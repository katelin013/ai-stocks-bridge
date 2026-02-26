"use strict";
const crypto = require("node:crypto");

const SALT = Buffer.from("ai-stocks-bridge-v1-salt", "utf8");
const INFO = Buffer.from("bridge-prompt-encryption", "utf8");
const IV_LENGTH = 12;

function deriveKey(token) {
  return Buffer.from(crypto.hkdfSync("sha256", token, SALT, INFO, 32));
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
  };
}

function decrypt(data, key) {
  const iv = Buffer.from(data.iv, "base64");
  const raw = Buffer.from(data.ciphertext, "base64");
  const tag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

function isEncryptedPrompt(prompt) {
  return (
    prompt !== null &&
    typeof prompt === "object" &&
    typeof prompt.iv === "string" &&
    typeof prompt.ciphertext === "string"
  );
}

module.exports = { deriveKey, encrypt, decrypt, isEncryptedPrompt };
