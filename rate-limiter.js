"use strict";

/**
 * Token Bucket Rate Limiter (zero dependencies).
 * @param {object} opts
 * @param {number} opts.capacity - Max tokens in bucket (default 15)
 * @param {number} opts.refillIntervalMs - Ms between token refills (default 6000 = 1 token per 6s)
 */
function createRateLimiter({ capacity = 15, refillIntervalMs = 6000 } = {}) {
  let tokens = capacity;
  let lastRefill = Date.now();

  function refill() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const newTokens = Math.floor(elapsed / refillIntervalMs);
    if (newTokens > 0) {
      tokens = Math.min(capacity, tokens + newTokens);
      lastRefill += newTokens * refillIntervalMs;
    }
  }

  return {
    tryConsume() {
      refill();
      if (tokens > 0) {
        tokens--;
        return true;
      }
      return false;
    },
    remaining() {
      refill();
      return tokens;
    },
  };
}

module.exports = { createRateLimiter };
