"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  stableStringify,
  hashMessagePrefix,
  createSessionStore,
  renderFullInput,
  renderDeltaInput,
  extractFirstJsonObject,
  extractDecision,
  parseClaudeEvents,
  buildAssistantMessage,
  createOpenAICompat,
  OUTPUT_CONTRACT,
  BRIDGE_MODEL_ID,
} = require("../openai-compat");

describe("stableStringify", () => {
  it("is independent of key order", () => {
    assert.strictEqual(
      stableStringify({ b: 1, a: { d: 2, c: 3 } }),
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("handles arrays and primitives", () => {
    assert.strictEqual(stableStringify([1, "x", null]), '[1,"x",null]');
  });
});

describe("hashMessagePrefix", () => {
  const base = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];

  it("same prefix same hash", () => {
    assert.strictEqual(
      hashMessagePrefix(base, 2),
      hashMessagePrefix([...base], 2),
    );
  });

  it("tool_calls argument key order does not change the hash", () => {
    const a = [
      ...base,
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_quote",
              arguments: '{"code":"2330.TW","market":"tw"}',
            },
          },
        ],
      },
    ];
    const b = [
      ...base,
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_quote",
              arguments: '{"market":"tw","code":"2330.TW"}',
            },
          },
        ],
      },
    ];
    assert.strictEqual(hashMessagePrefix(a, 3), hashMessagePrefix(b, 3));
  });

  it("different content different hash", () => {
    const changed = [base[0], { role: "user", content: "bye" }];
    assert.notStrictEqual(
      hashMessagePrefix(base, 2),
      hashMessagePrefix(changed, 2),
    );
  });
});

describe("createSessionStore", () => {
  const history = [
    { role: "system", content: "sys" },
    { role: "user", content: "分析 2330" },
  ];
  const assistantMsg = { role: "assistant", content: "看多" };

  it("lookup miss on unknown conversation", () => {
    const store = createSessionStore();
    assert.strictEqual(store.lookup(history), null);
  });

  it("save then lookup returns delta only", () => {
    const store = createSessionStore();
    store.save([...history, assistantMsg], "sess-1");
    const next = [
      ...history,
      assistantMsg,
      { role: "user", content: "那 AAPL 呢" },
    ];
    const hit = store.lookup(next);
    assert.ok(hit);
    assert.strictEqual(hit.sessionId, "sess-1");
    assert.strictEqual(hit.prefixCount, 3);
    assert.deepStrictEqual(hit.delta, [
      { role: "user", content: "那 AAPL 呢" },
    ]);
  });

  it("expired entries are not returned", () => {
    let t = 1000;
    const store = createSessionStore({ ttlMs: 50, now: () => t });
    store.save([...history, assistantMsg], "sess-1");
    t += 100;
    assert.strictEqual(
      store.lookup([
        ...history,
        assistantMsg,
        { role: "user", content: "more" },
      ]),
      null,
    );
  });

  it("evicts oldest beyond maxEntries", () => {
    const store = createSessionStore({ maxEntries: 2 });
    store.save([{ role: "user", content: "a" }], "s1");
    store.save([{ role: "user", content: "b" }], "s2");
    store.save([{ role: "user", content: "c" }], "s3");
    assert.strictEqual(store.size(), 2);
  });
});

describe("extractFirstJsonObject", () => {
  it("finds balanced object with nested braces and strings", () => {
    const text = 'noise {"a": {"b": "va}lue"}, "c": 1} trailing';
    assert.strictEqual(
      extractFirstJsonObject(text),
      '{"a": {"b": "va}lue"}, "c": 1}',
    );
  });

  it("returns null when no object", () => {
    assert.strictEqual(extractFirstJsonObject("plain text"), null);
  });
});

describe("extractDecision", () => {
  it("parses tool_call decision", () => {
    const d = extractDecision(
      '{"tool_call": {"name": "get_quote", "arguments": {"code": "2330.TW"}}}',
    );
    assert.strictEqual(d.type, "tool_calls");
    assert.strictEqual(d.calls[0].name, "get_quote");
    assert.deepStrictEqual(d.calls[0].arguments, { code: "2330.TW" });
  });

  it("parses final decision", () => {
    const d = extractDecision('{"final": "台積電看多"}');
    assert.strictEqual(d.type, "final");
    assert.strictEqual(d.content, "台積電看多");
  });

  it("strips markdown fences", () => {
    const d = extractDecision('```json\n{"final": "ok"}\n```');
    assert.strictEqual(d.type, "final");
    assert.strictEqual(d.content, "ok");
  });

  it("treats plain text as final answer", () => {
    const d = extractDecision("就是一段普通回答");
    assert.strictEqual(d.type, "final");
    assert.strictEqual(d.content, "就是一段普通回答");
  });

  it("flags malformed tool_call attempts", () => {
    const d = extractDecision(
      '{"tool_call": {"name": "get_quote", "arguments": {broken',
    );
    assert.strictEqual(d.type, "malformed");
  });
});

describe("render inputs", () => {
  const messages = [
    { role: "system", content: "你是分析師" },
    { role: "user", content: "分析 2330" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_quote", arguments: '{"code":"2330.TW"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      name: "get_quote",
      content: '{"price": 2455}',
    },
  ];
  const tools = [
    {
      type: "function",
      function: {
        name: "get_quote",
        description: "查行情",
        parameters: { type: "object" },
      },
    },
  ];

  it("full input contains tools, conversation and contract", () => {
    const input = renderFullInput(messages, tools);
    assert.ok(input.includes("AVAILABLE TOOLS"));
    assert.ok(input.includes("get_quote"));
    assert.ok(input.includes("分析 2330"));
    assert.ok(input.includes('"price": 2455'));
    assert.ok(input.includes(OUTPUT_CONTRACT));
  });

  it("delta input contains only new messages plus contract", () => {
    const input = renderDeltaInput([messages[3]], tools);
    assert.ok(input.includes('"price": 2455'));
    assert.ok(!input.includes("分析 2330"));
    assert.ok(input.includes(OUTPUT_CONTRACT));
  });
});

describe("parseClaudeEvents", () => {
  it("parses array-of-events output", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"final":"ok"}',
        session_id: "s-1",
        usage: { output_tokens: 5 },
      },
    ]);
    const r = parseClaudeEvents(stdout);
    assert.strictEqual(r.text, '{"final":"ok"}');
    assert.strictEqual(r.sessionId, "s-1");
  });

  it("parses legacy single-object output", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x",
      session_id: "s-2",
    });
    assert.strictEqual(parseClaudeEvents(stdout).sessionId, "s-2");
  });

  it("throws on error result", () => {
    const stdout = JSON.stringify([
      { type: "result", subtype: "error_during_execution", is_error: true },
    ]);
    assert.throws(() => parseClaudeEvents(stdout));
  });
});

describe("createOpenAICompat", () => {
  const baseMessages = [
    { role: "system", content: "你是分析師" },
    { role: "user", content: "分析 2330" },
  ];
  const tools = [
    { type: "function", function: { name: "get_quote", parameters: {} } },
  ];

  function fakeRunner(script) {
    const calls = [];
    return {
      calls,
      run: async ({ input, resumeSessionId }) => {
        calls.push({ input, resumeSessionId });
        const step = script.shift();
        if (step.error) throw new Error(step.error);
        return {
          text: step.text,
          sessionId: step.sessionId || "sess-1",
          usage: step.usage || null,
        };
      },
    };
  }

  it("fresh conversation returns final content", async () => {
    const runner = fakeRunner([{ text: '{"final": "看多"}' }]);
    const compat = createOpenAICompat({ runClaude: runner.run });
    const res = await compat.chatOnce({
      model: "bridge-claude",
      messages: baseMessages,
      tools,
    });
    assert.strictEqual(res.object, "chat.completion");
    assert.strictEqual(res.choices[0].finish_reason, "stop");
    assert.strictEqual(res.choices[0].message.content, "看多");
    assert.ok(!runner.calls[0].resumeSessionId);
    assert.ok(runner.calls[0].input.includes("分析 2330"));
  });

  it("tool call flow resumes session with delta only", async () => {
    const store = createSessionStore();
    const runner = fakeRunner([
      {
        text: '{"tool_call": {"name": "get_quote", "arguments": {"code": "2330.TW"}}}',
      },
      { text: '{"final": "2455 元，看多"}' },
    ]);
    const compat = createOpenAICompat({
      runClaude: runner.run,
      sessionStore: store,
    });

    const first = await compat.chatOnce({ messages: baseMessages, tools });
    assert.strictEqual(first.choices[0].finish_reason, "tool_calls");
    const toolCall = first.choices[0].message.tool_calls[0];
    assert.strictEqual(toolCall.function.name, "get_quote");

    // DSA echoes back: history + our assistant message + tool result
    const second = await compat.chatOnce({
      messages: [
        ...baseMessages,
        first.choices[0].message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "get_quote",
          content: '{"price": 2455}',
        },
      ],
      tools,
    });
    assert.strictEqual(second.choices[0].message.content, "2455 元，看多");
    // Second CLI run must be a resume carrying only the delta
    assert.strictEqual(runner.calls[1].resumeSessionId, "sess-1");
    assert.ok(runner.calls[1].input.includes('"price": 2455'));
    assert.ok(!runner.calls[1].input.includes("分析 2330"));
  });

  it("falls back to full history when resume fails", async () => {
    const store = createSessionStore();
    store.save(baseMessages, "dead-session");
    const runner = fakeRunner([
      { error: "No conversation found" },
      { text: '{"final": "重建成功"}', sessionId: "sess-new" },
    ]);
    const compat = createOpenAICompat({
      runClaude: runner.run,
      sessionStore: store,
    });
    const res = await compat.chatOnce({
      messages: [...baseMessages, { role: "user", content: "續問" }],
      tools,
    });
    assert.strictEqual(res.choices[0].message.content, "重建成功");
    assert.strictEqual(runner.calls[0].resumeSessionId, "dead-session");
    assert.strictEqual(runner.calls[1].resumeSessionId, null);
    assert.ok(runner.calls[1].input.includes("分析 2330"));
  });

  it("repairs malformed tool JSON within the same session", async () => {
    const runner = fakeRunner([
      {
        text: '{"tool_call": {"name": "get_quote", "arguments": {broken',
        sessionId: "sess-9",
      },
      {
        text: '{"tool_call": {"name": "get_quote", "arguments": {"code": "2330.TW"}}}',
        sessionId: "sess-9",
      },
    ]);
    const compat = createOpenAICompat({ runClaude: runner.run });
    const res = await compat.chatOnce({ messages: baseMessages, tools });
    assert.strictEqual(res.choices[0].finish_reason, "tool_calls");
    assert.strictEqual(runner.calls[1].resumeSessionId, "sess-9");
    assert.ok(runner.calls[1].input.includes("not a valid JSON"));
  });

  it("rejects empty messages with 400", async () => {
    const compat = createOpenAICompat({
      runClaude: async () => ({ text: "", sessionId: null }),
    });
    await assert.rejects(
      compat.chatOnce({ messages: [] }),
      (e) => e.statusCode === 400,
    );
  });

  it("streams SSE chunks ending with [DONE]", async () => {
    const runner = fakeRunner([{ text: '{"final": "串流答案"}' }]);
    const compat = createOpenAICompat({ runClaude: runner.run });
    const written = [];
    const fakeRes = {
      writeHead: () => {},
      write: (s) => written.push(s),
      end: () => written.push("<END>"),
    };
    await compat.handleChatCompletions(
      { messages: baseMessages, stream: true },
      fakeRes,
    );
    const joined = written.join("");
    assert.ok(joined.includes('"chat.completion.chunk"'));
    assert.ok(joined.includes("串流答案"));
    assert.ok(joined.includes("data: [DONE]"));
    assert.ok(joined.endsWith("<END>"));
  });

  it("handleModels lists the bridge model", async () => {
    const compat = createOpenAICompat({ runClaude: async () => ({}) });
    const written = [];
    compat.handleModels({ writeHead: () => {}, end: (s) => written.push(s) });
    const body = JSON.parse(written[0]);
    assert.strictEqual(body.data[0].id, BRIDGE_MODEL_ID);
  });
});

describe("buildAssistantMessage", () => {
  it("serializes tool call arguments as a JSON string", () => {
    const msg = buildAssistantMessage({
      type: "tool_calls",
      calls: [{ name: "get_quote", arguments: { code: "2330.TW" } }],
    });
    assert.strictEqual(msg.content, null);
    assert.strictEqual(typeof msg.tool_calls[0].function.arguments, "string");
    assert.deepStrictEqual(JSON.parse(msg.tool_calls[0].function.arguments), {
      code: "2330.TW",
    });
    assert.ok(msg.tool_calls[0].id.startsWith("call_"));
  });
});
