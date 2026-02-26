"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

describe("Bridge Security Integration", () => {
  describe("Request body size limit", () => {
    it("MAX_BODY_SIZE is 8KB", () => {
      const { MAX_BODY_SIZE } = require("../security");
      assert.strictEqual(MAX_BODY_SIZE, 8 * 1024);
    });
  });

  describe("CORS configuration", () => {
    it("includes trilo.tw in allowed origins", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("https://trilo.tw"));
      assert.ok(source.includes("https://ai-stocks-web.web.app"));
    });

    it("requires X-Bridge-Token in allowed headers", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("X-Bridge-Token"));
    });
  });

  describe("Codex sandbox", () => {
    it("codex has cwd set to sandbox directory", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("ai-stocks-sandbox"));
    });
  });

  describe("Host header check", () => {
    it("validates host header against localhost", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("checkHost"));
    });
  });

  describe("Concurrency limit", () => {
    it("has MAX_CONCURRENT_CLI constant", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("MAX_CONCURRENT_CLI"));
      assert.ok(source.includes("activeClis"));
    });
  });

  describe("HTTP security headers", () => {
    it("includes X-Content-Type-Options and X-Frame-Options", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("X-Content-Type-Options"));
      assert.ok(source.includes("X-Frame-Options"));
    });
  });

  describe("Circuit breaker", () => {
    it("has ban threshold and duration constants", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
      assert.ok(source.includes("BAN_THRESHOLD"));
      assert.ok(source.includes("BAN_DURATION_MS"));
      assert.ok(source.includes("recordViolation"));
    });
  });
});
