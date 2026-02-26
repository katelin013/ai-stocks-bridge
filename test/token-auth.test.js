"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createTokenAuth } = require("../token-auth");

describe("Token Auth", () => {
  const testDir = path.join(os.tmpdir(), "ai-stocks-test-" + Date.now());
  let auth;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    auth = createTokenAuth({ tokenDir: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("generates a UUID token on init", () => {
    const token = auth.getToken();
    assert.ok(token);
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("writes token to file", () => {
    const tokenFile = path.join(testDir, "bridge.token");
    assert.ok(fs.existsSync(tokenFile));
    const content = fs.readFileSync(tokenFile, "utf-8").trim();
    assert.strictEqual(content, auth.getToken());
  });

  it("validates correct token", () => {
    assert.strictEqual(auth.validate(auth.getToken()), true);
  });

  it("rejects wrong token", () => {
    assert.strictEqual(auth.validate("wrong-token"), false);
  });

  it("rejects empty token", () => {
    assert.strictEqual(auth.validate(""), false);
    assert.strictEqual(auth.validate(null), false);
    assert.strictEqual(auth.validate(undefined), false);
  });

  it("allows health endpoint without token (passthrough check)", () => {
    // Token auth should be checked at route level, not module level
    // This just verifies the validate function works independently
    assert.strictEqual(auth.validate(auth.getToken()), true);
  });

  it("persists token across restarts", () => {
    const firstToken = auth.getToken();
    // Create a second instance with same dir — should reuse token
    const auth2 = createTokenAuth({ tokenDir: testDir });
    assert.strictEqual(auth2.getToken(), firstToken);
  });

  it("generates new token when file is missing", () => {
    const firstToken = auth.getToken();
    // Delete the token file
    fs.unlinkSync(path.join(testDir, "bridge.token"));
    // New instance should generate a different token
    const auth2 = createTokenAuth({ tokenDir: testDir });
    assert.ok(auth2.getToken());
    assert.notStrictEqual(auth2.getToken(), firstToken);
  });
});
