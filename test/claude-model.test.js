"use strict";
// Every claude CLI launch must pin the model. Without --model the CLI uses
// the environment default, which can silently drift to an unintended model.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createClaudeRunner, CLAUDE_MODEL } = require("../openai-compat");

const EXPECTED_MODEL = "claude-opus-5-5[1m]";

function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const argsFile = path.join(dir, "args.json");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s1" }));
});
`,
    { mode: 0o755 },
  );
  return {
    bin,
    dir,
    readArgs: () => JSON.parse(fs.readFileSync(argsFile, "utf8")),
  };
}

function modelArg(args) {
  const i = args.indexOf("--model");
  return i === -1 ? undefined : args[i + 1];
}

describe("claude model pinning", () => {
  it("CLAUDE_MODEL is Opus 5.5", () => {
    assert.equal(CLAUDE_MODEL, EXPECTED_MODEL);
  });

  for (const resumeSessionId of [undefined, "sess-123"]) {
    it(`/v1 runner passes --model (resume=${resumeSessionId ?? "none"})`, async () => {
      const fake = fakeClaude();
      const run = createClaudeRunner({
        cliPath: fake.bin,
        env: process.env,
        cwd: fake.dir,
      });
      await run({ input: "hi", resumeSessionId });
      const args = fake.readArgs();
      assert.equal(modelArg(args), EXPECTED_MODEL);
      if (resumeSessionId)
        assert.equal(args[args.indexOf("--resume") + 1], resumeSessionId);
    });
  }

  it("index.js claude registry passes --model CLAUDE_MODEL", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const entry = src.match(/^\s*claude:\s*\{[\s\S]*?^\s*\},?/m)?.[0];
    assert.ok(entry, "claude registry entry not found");
    assert.match(entry, /cmd:\s*"claude"/);
    assert.match(entry, /args:\s*\[\s*"--model",\s*CLAUDE_MODEL\s*,/);
  });
});
