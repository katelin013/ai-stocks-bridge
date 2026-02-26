"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { deriveKey: nodeDeriveKey, encrypt: nodeEncrypt, decrypt: nodeDecrypt } = require("../crypto");

// Simulate frontend deriveKey using webcrypto (same as bridgeCrypto.ts)
async function webDeriveKey(token) {
  const enc = new TextEncoder();
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw", enc.encode(token), "HKDF", false, ["deriveKey"]
  );
  return webcrypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("ai-stocks-bridge-v1-salt"), info: enc.encode("bridge-prompt-encryption") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function webEncrypt(plaintext, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const toBase64 = (arr) => Buffer.from(arr).toString("base64");
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}

async function webDecrypt(data, key) {
  const iv = Buffer.from(data.iv, "base64");
  const raw = Buffer.from(data.ciphertext, "base64");
  const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw);
  return new TextDecoder().decode(decrypted);
}

const TOKEN = "550e8400-e29b-41d4-a716-446655440000";

describe("cross-compatibility: Node crypto ↔ WebCrypto", () => {
  it("Node encrypt → Web decrypt", async () => {
    const nodeKey = nodeDeriveKey(TOKEN);
    const encrypted = nodeEncrypt("分析 TSLA", nodeKey);

    const webKey = await webDeriveKey(TOKEN);
    const decrypted = await webDecrypt(encrypted, webKey);
    assert.strictEqual(decrypted, "分析 TSLA");
  });

  it("Web encrypt → Node decrypt", async () => {
    const webKey = await webDeriveKey(TOKEN);
    const encrypted = await webEncrypt("Analyze AAPL", webKey);

    const nodeKey = nodeDeriveKey(TOKEN);
    const decrypted = nodeDecrypt(encrypted, nodeKey);
    assert.strictEqual(decrypted, "Analyze AAPL");
  });

  it("derived keys match between Node and Web", async () => {
    const nodeKey = nodeDeriveKey(TOKEN);
    const webKey = await webDeriveKey(TOKEN);
    const webRaw = Buffer.from(await webcrypto.subtle.exportKey("raw", webKey));
    assert.deepStrictEqual(nodeKey, webRaw);
  });
});
