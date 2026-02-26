"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { deriveKey, encrypt, decrypt, isEncryptedPrompt } = require("../crypto");

describe("crypto module", () => {
  const TEST_TOKEN = "550e8400-e29b-41d4-a716-446655440000";

  it("deriveKey returns a 32-byte Buffer", () => {
    const key = deriveKey(TEST_TOKEN);
    assert.ok(Buffer.isBuffer(key));
    assert.strictEqual(key.length, 32);
  });

  it("deriveKey is deterministic (same token → same key)", () => {
    const key1 = deriveKey(TEST_TOKEN);
    const key2 = deriveKey(TEST_TOKEN);
    assert.deepStrictEqual(key1, key2);
  });

  it("different tokens produce different keys", () => {
    const key1 = deriveKey(TEST_TOKEN);
    const key2 = deriveKey("00000000-0000-0000-0000-000000000001");
    assert.notDeepStrictEqual(key1, key2);
  });

  it("encrypt returns { iv, ciphertext } with base64 strings", () => {
    const key = deriveKey(TEST_TOKEN);
    const result = encrypt("Hello World", key);
    assert.ok(result.iv);
    assert.ok(result.ciphertext);
    assert.strictEqual(typeof result.iv, "string");
    assert.strictEqual(typeof result.ciphertext, "string");
  });

  it("iv is 16 chars base64 (12 bytes)", () => {
    const key = deriveKey(TEST_TOKEN);
    const result = encrypt("test", key);
    const ivBytes = Buffer.from(result.iv, "base64");
    assert.strictEqual(ivBytes.length, 12);
  });

  it("encrypt produces different ciphertext each time (random IV)", () => {
    const key = deriveKey(TEST_TOKEN);
    const a = encrypt("same text", key);
    const b = encrypt("same text", key);
    assert.notStrictEqual(a.ciphertext, b.ciphertext);
    assert.notStrictEqual(a.iv, b.iv);
  });

  it("decrypt recovers original plaintext", () => {
    const key = deriveKey(TEST_TOKEN);
    const encrypted = encrypt("分析 TSLA 股票", key);
    const decrypted = decrypt(encrypted, key);
    assert.strictEqual(decrypted, "分析 TSLA 股票");
  });

  it("decrypt with wrong key throws", () => {
    const key1 = deriveKey(TEST_TOKEN);
    const key2 = deriveKey("00000000-0000-0000-0000-000000000001");
    const encrypted = encrypt("secret", key1);
    assert.throws(() => decrypt(encrypted, key2));
  });

  it("decrypt with tampered ciphertext throws", () => {
    const key = deriveKey(TEST_TOKEN);
    const encrypted = encrypt("test", key);
    encrypted.ciphertext = encrypted.ciphertext.slice(0, -4) + "AAAA";
    assert.throws(() => decrypt(encrypted, key));
  });

  it("handles empty string", () => {
    const key = deriveKey(TEST_TOKEN);
    const encrypted = encrypt("", key);
    const decrypted = decrypt(encrypted, key);
    assert.strictEqual(decrypted, "");
  });

  it("handles long prompt (4000 chars)", () => {
    const key = deriveKey(TEST_TOKEN);
    const longText = "a".repeat(4000);
    const encrypted = encrypt(longText, key);
    const decrypted = decrypt(encrypted, key);
    assert.strictEqual(decrypted, longText);
  });

  it("handles multi-byte UTF-8 (中文、emoji)", () => {
    const key = deriveKey(TEST_TOKEN);
    const text = "分析台積電 2330.TW 技術指標 📈";
    const encrypted = encrypt(text, key);
    const decrypted = decrypt(encrypted, key);
    assert.strictEqual(decrypted, text);
  });
});

describe("isEncryptedPrompt helper", () => {
  it("detects encrypted prompt (object with iv + ciphertext)", () => {
    assert.strictEqual(isEncryptedPrompt({ iv: "abc", ciphertext: "def" }), true);
  });

  it("detects plaintext prompt (string)", () => {
    assert.strictEqual(isEncryptedPrompt("Analyze TSLA"), false);
  });

  it("rejects malformed objects", () => {
    assert.strictEqual(isEncryptedPrompt({ iv: "abc" }), false);
    assert.strictEqual(isEncryptedPrompt({ ciphertext: "abc" }), false);
    assert.strictEqual(isEncryptedPrompt(null), false);
    assert.strictEqual(isEncryptedPrompt(123), false);
  });
});
