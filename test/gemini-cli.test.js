"use strict";
// The standalone gemini CLI free tier was shut down (2026-06-18): it now fails
// with "IneligibleTierError: This client is no longer supported". Gemini must
// go through the Antigravity CLI (agy), whose flags are --model/--print.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function registryEntry(name) {
  const m = src.match(
    new RegExp(`^\\s*${name}:\\s*\\{[\\s\\S]*?^\\s*\\},`, "m"),
  );
  assert.ok(m, `${name} registry entry not found`);
  return m[0];
}

describe("gemini registry uses agy", () => {
  it("runs agy, not the retired gemini CLI", () => {
    assert.match(registryEntry("gemini"), /cmd:\s*"agy"/);
  });

  it("pins a current agy model via --model and --print", () => {
    assert.match(
      registryEntry("gemini"),
      /args:\s*\[\s*"--model",\s*"Gemini 3\.8 Flash \(Medium\)",\s*"--print"\s*\]/,
    );
  });

  it("allows for agy cold start (>90s)", () => {
    const t = registryEntry("gemini").match(/timeout:\s*([\d_]+)/);
    assert.ok(t && Number(t[1].replace(/_/g, "")) >= 180_000);
  });
});
