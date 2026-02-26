"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../rate-limiter");

describe("Token Bucket Rate Limiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = createRateLimiter({ capacity: 5, refillIntervalMs: 100 });
  });

  it("allows requests within capacity", () => {
    assert.strictEqual(limiter.tryConsume(), true);
    assert.strictEqual(limiter.tryConsume(), true);
    assert.strictEqual(limiter.tryConsume(), true);
  });

  it("rejects when bucket is empty", () => {
    for (let i = 0; i < 5; i++) limiter.tryConsume();
    assert.strictEqual(limiter.tryConsume(), false);
  });

  it("refills tokens over time", async () => {
    for (let i = 0; i < 5; i++) limiter.tryConsume();
    assert.strictEqual(limiter.tryConsume(), false);

    // Wait for 1 refill interval
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(limiter.tryConsume(), true);
  });

  it("does not exceed capacity after long idle", async () => {
    await new Promise((r) => setTimeout(r, 300));
    // Should still be capped at capacity
    let consumed = 0;
    while (limiter.tryConsume()) consumed++;
    assert.strictEqual(consumed, 5);
  });

  it("returns remaining tokens count", () => {
    assert.strictEqual(limiter.remaining(), 5);
    limiter.tryConsume();
    assert.strictEqual(limiter.remaining(), 4);
  });
});
