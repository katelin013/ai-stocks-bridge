"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * Token-based authentication for Bridge.
 * Persists token across restarts — reads existing token from file if available,
 * generates a new one only on first run.
 * @param {object} opts
 * @param {string} opts.tokenDir - Directory to store token file (default ~/.ai-stocks)
 */
function createTokenAuth({ tokenDir } = {}) {
  const dir = tokenDir || path.join(os.homedir(), ".ai-stocks");
  const tokenFile = path.join(dir, "bridge.token");

  fs.mkdirSync(dir, { recursive: true });

  // Reuse existing token if available, otherwise generate new one
  let token;
  try {
    const existing = fs.readFileSync(tokenFile, "utf-8").trim();
    if (existing) {
      token = existing;
    }
  } catch {
    // File doesn't exist or unreadable — will generate new token
  }

  if (!token) {
    token = crypto.randomUUID();
  }

  // Always write to ensure file exists with correct permissions
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });

  return {
    getToken() {
      return token;
    },
    validate(input) {
      if (!input) return false;
      return input === token;
    },
    getTokenFile() {
      return tokenFile;
    },
  };
}

module.exports = { createTokenAuth };
