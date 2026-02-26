#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { which } = require("./which");
const {
  sanitizeEnv,
  wrapPrompt,
  sanitizeOutput,
  MAX_BODY_SIZE,
} = require("./security");
const { createRateLimiter } = require("./rate-limiter");
const { createTokenAuth } = require("./token-auth");

const PORT = parseInt(process.env.PORT || "7890", 10);
const HOST = "127.0.0.1";
const MAX_CONCURRENT_CLI = 5;
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:5174",
  "https://trilo.tw",
  "https://ai-stocks-web.web.app",
];

const CLI_REGISTRY = {
  claude: { cmd: "claude", args: ["--print"], timeout: 120_000 },
  gemini: {
    cmd: "gemini",
    args: ["-m", "gemini-3-flash-preview", "-o", "text"],
    timeout: 120_000,
  },
  codex: {
    cmd: "codex",
    args: ["exec", "-c", "features.rmcp_client=false", "-s", "read-only"],
    timeout: 180_000,
    sandbox: true,
  },
};

// --- Startup initialization ---

// Lock CLI paths at startup (prevent PATH hijacking)
const CLI_PATHS = {};
for (const [name, info] of Object.entries(CLI_REGISTRY)) {
  CLI_PATHS[name] = which(info.cmd);
}

// Create Codex sandbox (empty directory)
const SANDBOX_DIR = "/tmp/ai-stocks-sandbox";
fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

// Initialize rate limiter (capacity 15, refill 1 token per 6s)
const rateLimiter = createRateLimiter({ capacity: 15, refillIntervalMs: 6000 });

// Initialize token auth
const auth = createTokenAuth();

// Pre-compute sanitized env
const cleanEnv = sanitizeEnv(process.env);

// Concurrency tracking
let activeClis = 0;

// Security circuit breaker — 5 violations in 60s → ban 15 min
const violations = [];
const BAN_THRESHOLD = 5;
const BAN_WINDOW_MS = 60_000;
const BAN_DURATION_MS = 15 * 60_000;
let bannedUntil = 0;

// --- Audit log ---
const auditLogPath = (() => {
  const dir = path.join(os.homedir(), ".ai-stocks");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "bridge.log");
})();

function audit(cli, origin, prompt, status) {
  const line = `[${new Date().toISOString()}] CLI:${cli} Origin:${origin || "none"} Status:${status} Prompt:${(prompt || "").slice(0, 100).replace(/\n/g, " ")}\n`;
  try {
    const stat = fs.statSync(auditLogPath).size;
    if (stat > 5 * 1024 * 1024) {
      fs.renameSync(auditLogPath, auditLogPath + ".1");
    }
  } catch {
    /* file doesn't exist yet */
  }
  fs.appendFileSync(auditLogPath, line);
}

// --- Security helpers ---

function recordViolation() {
  const now = Date.now();
  violations.push(now);
  while (violations.length > 0 && violations[0] < now - BAN_WINDOW_MS)
    violations.shift();
  if (violations.length >= BAN_THRESHOLD) {
    bannedUntil = now + BAN_DURATION_MS;
    violations.length = 0;
  }
}

function isBanned() {
  return Date.now() < bannedUntil;
}

// --- Core functions ---

function detectClis() {
  return Object.entries(CLI_REGISTRY)
    .filter(([name]) => CLI_PATHS[name])
    .map(([name]) => name);
}

function runCli(name, userPrompt) {
  return new Promise((resolve) => {
    const info = CLI_REGISTRY[name];
    if (!info)
      return resolve({
        cli: name,
        error: `Unknown CLI: ${name}`,
        success: false,
      });

    const cliPath = CLI_PATHS[name];
    if (!cliPath)
      return resolve({
        cli: name,
        error: `${name} CLI not installed`,
        success: false,
      });

    // Concurrency check
    if (activeClis >= MAX_CONCURRENT_CLI) {
      return resolve({
        cli: name,
        error: "Too many concurrent CLI processes",
        success: false,
      });
    }

    // Wrap prompt with system constraints
    let wrappedPrompt;
    try {
      wrappedPrompt = wrapPrompt(userPrompt);
    } catch (e) {
      recordViolation();
      return resolve({ cli: name, error: e.message, success: false });
    }

    activeClis++;
    const start = Date.now();
    const execOpts = {
      timeout: info.timeout,
      env: cleanEnv,
      maxBuffer: 64 * 1024,
    };

    if (info.sandbox) {
      execOpts.cwd = SANDBOX_DIR;
    }

    const child = execFile(
      cliPath,
      [...info.args, wrappedPrompt],
      execOpts,
      (err, stdout, stderr) => {
        activeClis--;
        const elapsed = +((Date.now() - start) / 1000).toFixed(2);
        if (err) {
          const msg = err.killed
            ? `Timeout after ${info.timeout / 1000}s`
            : stderr?.slice(0, 500) || err.message;
          return resolve({ cli: name, error: msg, success: false, elapsed });
        }
        const sanitized = sanitizeOutput(stdout.trim());
        resolve({ cli: name, response: sanitized, success: true, elapsed });
      },
    );
    child.stdin?.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        return reject(
          new Error(`Request body too large (max ${MAX_BODY_SIZE} bytes)`),
        );
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
  // Chrome Private Network Access (PNA): allow public site → localhost requests
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function checkHost(req) {
  const host = (req.headers.host || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1";
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(JSON.stringify(data));
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Host header check (DNS rebinding defense)
  if (!checkHost(req)) {
    return json(res, 403, { error: "Invalid host" });
  }

  // Circuit breaker — ban after repeated violations
  if (isBanned()) {
    return json(res, 403, {
      error: "Temporarily banned due to repeated violations",
    });
  }

  const url = req.url?.split("?")[0];

  // Health endpoint — no auth required
  if (url === "/health" && req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      cli: detectClis(),
      version: "0.2.0",
      security: true,
    });
  }

  // All POST endpoints require token auth
  if (req.method === "POST") {
    const token = req.headers["x-bridge-token"];
    if (!auth.validate(token)) {
      recordViolation();
      audit("none", req.headers.origin, "", "AUTH_FAIL");
      return json(res, 403, { error: "Invalid or missing token" });
    }
  }

  // Rate limiting for POST requests
  if (req.method === "POST" && !rateLimiter.tryConsume()) {
    audit("none", req.headers.origin, "", "RATE_LIMITED");
    return json(res, 429, { error: "Too many requests", retryAfterMs: 6000 });
  }

  if (url === "/analyze" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: "prompt is required" });
      const cli = body.cli || "gemini";
      audit(cli, req.headers.origin, body.prompt, "START");
      const result = await runCli(cli, body.prompt);
      audit(
        cli,
        req.headers.origin,
        body.prompt,
        result.success ? "OK" : "FAIL",
      );
      return json(res, result.success ? 200 : 502, result);
    } catch (e) {
      return json(res, 400, { error: e.message || "Invalid JSON" });
    }
  }

  if (url === "/multi-analyze" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: "prompt is required" });
      const clis = body.clis || ["claude", "gemini"];

      // Rate limit: each CLI counts as 1 request (first already consumed above)
      for (let i = 1; i < clis.length; i++) {
        if (!rateLimiter.tryConsume()) {
          audit("multi", req.headers.origin, body.prompt, "RATE_LIMITED");
          return json(res, 429, {
            error: "Too many requests",
            retryAfterMs: 6000,
          });
        }
      }

      audit(
        "multi:" + clis.join(","),
        req.headers.origin,
        body.prompt,
        "START",
      );
      const results = await Promise.all(
        clis.map((c) => runCli(c, body.prompt)),
      );
      audit("multi:" + clis.join(","), req.headers.origin, body.prompt, "OK");
      return json(res, 200, {
        results,
        requestedClis: clis,
        successCount: results.filter((r) => r.success).length,
      });
    } catch (e) {
      return json(res, 400, { error: e.message || "Invalid JSON" });
    }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\nAI Stocks Bridge v0.2.0 (Security Hardened)`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(
    `Available CLIs: ${detectClis().join(", ") || "(none detected)"}`,
  );
  console.log(`Token: ${auth.getToken()}`);
  console.log(`Token file: ${auth.getTokenFile()}`);
  console.log(`Audit log: ${auditLogPath}\n`);
});
