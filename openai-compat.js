"use strict";

/**
 * OpenAI-compatible chat completions layer for local trusted clients (e.g. DSA).
 *
 * Exposes `/v1/chat/completions` + `/v1/models` semantics on top of the local
 * Claude CLI. Tool calling is implemented as a text protocol: the model is
 * instructed to reply with exactly one JSON object — either
 *   {"tool_call": {"name": "...", "arguments": {...}}}
 * or
 *   {"final": "...answer..."}
 * and the bridge maps that back to the OpenAI `tool_calls` / `content` shape.
 *
 * Session optimization: conversations are keyed by a canonical hash of their
 * message prefix. On a prefix hit the bridge resumes the existing Claude CLI
 * session (`--resume <id>`) and sends only the delta messages; any miss or
 * resume failure falls back to replaying the full history, so correctness
 * never depends on the cache.
 *
 * Unlike `/analyze`, this endpoint serves a trusted localhost client and does
 * not wrap prompts with the browser-facing constraints (conversation history
 * and tool schemas legitimately exceed those limits).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const OPENAI_MAX_BODY_SIZE = 1024 * 1024; // 1MB — agent histories are large
const CLAUDE_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const BRIDGE_MODEL_ID = "bridge-claude";

const STATIC_INSTRUCTION =
  "You are the tool-calling reasoning engine of a stock-analysis agent. " +
  "Follow the instructions provided on stdin exactly and output only what they require.";

const OUTPUT_CONTRACT = `=== OUTPUT FORMAT (MANDATORY) ===
Reply with EXACTLY ONE JSON object and nothing else (no markdown fences, no commentary):
- To call a tool:  {"tool_call": {"name": "<tool name>", "arguments": { ... }}}
- To answer:       {"final": "<your complete answer as a string>"}
Call at most one tool per reply. Use "final" once you have enough information.`;

// ---------------------------------------------------------------------------
// Canonical hashing of message prefixes
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") +
    "}"
  );
}

function canonicalArguments(args) {
  if (typeof args !== "string") return stableStringify(args ?? null);
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    return args;
  }
}

function normalizeMessage(m) {
  const out = {
    role: m.role || "",
    content:
      typeof m.content === "string"
        ? m.content
        : m.content == null
          ? ""
          : stableStringify(m.content),
  };
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id || "",
      name: (tc.function && tc.function.name) || "",
      arguments: canonicalArguments(tc.function && tc.function.arguments),
    }));
  }
  return out;
}

function hashMessagePrefix(messages, count) {
  const canon = stableStringify(messages.slice(0, count).map(normalizeMessage));
  return crypto.createHash("sha256").update(canon).digest("hex");
}

// ---------------------------------------------------------------------------
// Session store: prefix hash -> Claude CLI session id
// ---------------------------------------------------------------------------

function createSessionStore({ maxEntries = 200, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // hash -> {sessionId, count, at}

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [k, v] of map) {
      if (v.at < cutoff) map.delete(k);
    }
    while (map.size > maxEntries) {
      map.delete(map.keys().next().value); // Map preserves insertion order
    }
  }

  return {
    /** Find the longest stored prefix of `messages`; return resume info or null. */
    lookup(messages) {
      prune();
      for (let n = messages.length - 1; n >= 1; n--) {
        const h = hashMessagePrefix(messages, n);
        const e = map.get(h);
        if (e && e.count === n) {
          return { sessionId: e.sessionId, prefixCount: n, delta: messages.slice(n) };
        }
      }
      return null;
    },
    /** Record that `messages` (full array) is now represented by `sessionId`. */
    save(messages, sessionId) {
      if (!sessionId) return;
      const h = hashMessagePrefix(messages, messages.length);
      map.delete(h);
      map.set(h, { sessionId, count: messages.length, at: now() });
      prune();
    },
    size() {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation rendering
// ---------------------------------------------------------------------------

function renderMessage(m) {
  const content =
    typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content);
  if (m.role === "tool") {
    return `[tool result${m.name ? ` for ${m.name}` : ""}${m.tool_call_id ? ` (${m.tool_call_id})` : ""}]:\n${content}`;
  }
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    const calls = m.tool_calls
      .map((tc) => {
        const fn = tc.function || {};
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
        return `{"tool_call": {"name": ${JSON.stringify(fn.name || "")}, "arguments": ${args}}}`;
      })
      .join("\n");
    return `[assistant tool_call]:\n${calls}` + (content ? `\n[assistant]:\n${content}` : "");
  }
  return `[${m.role}]:\n${content}`;
}

function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const defs = tools
    .map((t) => (t && t.type === "function" ? t.function : t))
    .filter(Boolean);
  return `=== AVAILABLE TOOLS (JSON Schemas) ===\n${JSON.stringify(defs, null, 1)}\n\n`;
}

/** Full-history prompt for a fresh CLI session. */
function renderFullInput(messages, tools) {
  return (
    renderTools(tools) +
    "=== CONVERSATION SO FAR ===\n" +
    messages.map(renderMessage).join("\n\n") +
    "\n\n" +
    OUTPUT_CONTRACT
  );
}

/** Delta prompt when resuming an existing CLI session. */
function renderDeltaInput(delta, tools) {
  return (
    "=== NEW MESSAGES (continuing the same conversation) ===\n" +
    delta.map(renderMessage).join("\n\n") +
    "\n\n" +
    OUTPUT_CONTRACT
  );
}

// ---------------------------------------------------------------------------
// Model output parsing
// ---------------------------------------------------------------------------

/** Extract the first balanced top-level JSON object from text, or null. */
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the model's reply into a decision.
 * Returns {type:"tool_calls", calls:[{name, arguments}]} or {type:"final", content}
 * or {type:"malformed"} when it looks like a failed tool-call attempt.
 */
function extractDecision(rawText) {
  const text = (rawText || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const jsonText = extractFirstJsonObject(text);
  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText);
      if (obj && obj.tool_call && typeof obj.tool_call.name === "string") {
        return {
          type: "tool_calls",
          calls: [{ name: obj.tool_call.name, arguments: obj.tool_call.arguments ?? {} }],
        };
      }
      if (obj && typeof obj.final === "string") {
        return { type: "final", content: obj.final };
      }
      if (obj && obj.final != null) {
        return { type: "final", content: JSON.stringify(obj.final) };
      }
    } catch {
      if (text.includes('"tool_call"')) return { type: "malformed" };
    }
  }
  if (!jsonText && text.includes('"tool_call"')) return { type: "malformed" };
  // No protocol JSON — treat the whole text as the final answer (graceful).
  return { type: "final", content: text };
}

// ---------------------------------------------------------------------------
// Claude CLI runner
// ---------------------------------------------------------------------------

function parseClaudeEvents(stdout) {
  const parsed = JSON.parse(stdout);
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const results = events.filter((e) => e && e.type === "result");
  if (results.length === 0) throw new Error("claude output has no result event");
  const result = results[results.length - 1];
  if (result.is_error === true || result.subtype !== "success") {
    throw new Error(`claude result not success (subtype=${result.subtype || "unknown"})`);
  }
  return {
    text: String(result.result || ""),
    sessionId: result.session_id || null,
    usage: result.usage || null,
  };
}

function createClaudeRunner({ cliPath, env, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  fs.mkdirSync(cwd, { recursive: true });
  return function run({ input, resumeSessionId }) {
    return new Promise((resolve, reject) => {
      const args = [
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--output-format",
        "json",
        "-p",
        STATIC_INSTRUCTION,
      ];
      const child = execFile(
        cliPath,
        args,
        { timeout: timeoutMs, env, cwd, maxBuffer: CLAUDE_MAX_BUFFER },
        (err, stdout, stderr) => {
          if (err) {
            const msg = err.killed
              ? `claude timeout after ${timeoutMs / 1000}s`
              : (stderr || err.message || "claude failed").slice(0, 500);
            return reject(new Error(msg));
          }
          try {
            resolve(parseClaudeEvents(String(stdout)));
          } catch (e) {
            reject(e);
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.write(input);
      child.stdin.end();
    });
  };
}

// ---------------------------------------------------------------------------
// OpenAI response shaping
// ---------------------------------------------------------------------------

function mapUsage(usage) {
  const prompt =
    (usage && (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) || 0;
  const completion = (usage && usage.output_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function buildAssistantMessage(decision) {
  if (decision.type === "tool_calls") {
    return {
      role: "assistant",
      content: null,
      tool_calls: decision.calls.map((c) => ({
        id: "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
        type: "function",
        function: {
          name: c.name,
          arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
        },
      })),
    };
  }
  return { role: "assistant", content: decision.content };
}

function buildCompletionResponse({ model, message, finishReason, usage }) {
  return {
    id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || BRIDGE_MODEL_ID,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: mapUsage(usage),
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamCompletionResponse(res, response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
  const base = {
    id: response.id.replace("chatcmpl-", "chatcmpl-"),
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
  };
  const message = response.choices[0].message;
  const delta = { role: "assistant" };
  if (message.tool_calls) {
    delta.tool_calls = message.tool_calls.map((tc, i) => ({ index: i, ...tc }));
  } else {
    delta.content = message.content;
  }
  writeSse(res, { ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  writeSse(res, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: response.choices[0].finish_reason }],
    usage: response.usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

function createOpenAICompat({
  runClaude, // injected runner: ({input, resumeSessionId}) => Promise<{text, sessionId, usage}>
  audit = () => {},
  sessionStore = createSessionStore(),
  maxConcurrent = 4,
} = {}) {
  if (typeof runClaude !== "function") {
    throw new Error("createOpenAICompat requires a runClaude function");
  }
  let active = 0;

  async function runWithRetry(input, resumeSessionId) {
    let result;
    try {
      result = await runClaude({ input, resumeSessionId });
    } catch (e) {
      if (!resumeSessionId) throw e;
      // Resume failed (expired/corrupt session) — will be retried fresh by caller.
      const err = new Error("resume_failed: " + e.message);
      err.resumeFailed = true;
      throw err;
    }
    let decision = extractDecision(result.text);
    if (decision.type === "malformed" && result.sessionId) {
      // One repair round-trip inside the same CLI session.
      const repair = await runClaude({
        input:
          "Your previous reply was not a valid JSON object.\n" + OUTPUT_CONTRACT,
        resumeSessionId: result.sessionId,
      });
      result = repair;
      decision = extractDecision(repair.text);
    }
    if (decision.type === "malformed") {
      decision = { type: "final", content: result.text };
    }
    return { decision, sessionId: result.sessionId, usage: result.usage };
  }

  async function chatOnce(body) {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      const err = new Error("messages is required");
      err.statusCode = 400;
      throw err;
    }
    if (active >= maxConcurrent) {
      const err = new Error("Too many concurrent requests");
      err.statusCode = 429;
      throw err;
    }
    active++;
    try {
      const tools = body.tools;
      const hit = sessionStore.lookup(messages);
      let outcome;
      if (hit) {
        try {
          outcome = await runWithRetry(renderDeltaInput(hit.delta, tools), hit.sessionId);
          audit("claude-v1", null, `resume n=${hit.prefixCount}`, "OK");
        } catch (e) {
          if (!e.resumeFailed) throw e;
          audit("claude-v1", null, "resume failed, replaying full history", "RETRY");
          outcome = await runWithRetry(renderFullInput(messages, tools), null);
        }
      } else {
        outcome = await runWithRetry(renderFullInput(messages, tools), null);
      }
      const message = buildAssistantMessage(outcome.decision);
      sessionStore.save([...messages, message], outcome.sessionId);
      return buildCompletionResponse({
        model: body.model,
        message,
        finishReason: outcome.decision.type === "tool_calls" ? "tool_calls" : "stop",
        usage: outcome.usage,
      });
    } finally {
      active--;
    }
  }

  return {
    chatOnce,
    async handleChatCompletions(body, res) {
      try {
        const response = await chatOnce(body);
        if (body.stream) return streamCompletionResponse(res, response);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(response));
      } catch (e) {
        const status = e.statusCode || 502;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: e.message || "bridge error", type: "bridge_error", code: status },
          }),
        );
      }
    },
    handleModels(res) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: BRIDGE_MODEL_ID,
              object: "model",
              created: 0,
              owned_by: "ai-stocks-bridge",
            },
          ],
        }),
      );
    },
  };
}

function defaultAgentCwd() {
  return path.join(os.homedir(), ".ai-stocks", "claude-agent-cwd");
}

module.exports = {
  OPENAI_MAX_BODY_SIZE,
  BRIDGE_MODEL_ID,
  STATIC_INSTRUCTION,
  OUTPUT_CONTRACT,
  stableStringify,
  normalizeMessage,
  hashMessagePrefix,
  createSessionStore,
  renderFullInput,
  renderDeltaInput,
  renderMessage,
  extractFirstJsonObject,
  extractDecision,
  parseClaudeEvents,
  createClaudeRunner,
  buildAssistantMessage,
  buildCompletionResponse,
  createOpenAICompat,
  defaultAgentCwd,
};
