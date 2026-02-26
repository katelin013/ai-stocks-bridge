"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * Token-based authentication for Bridge.
 * Generates a random UUID token on startup, writes to file for Dashboard to read.
 * @param {object} opts
 * @param {string} opts.tokenDir - Directory to store token file (default ~/.ai-stocks)
 */
function createTokenAuth({ tokenDir } = {}) {
  const dir = tokenDir || path.join(os.homedir(), ".ai-stocks");
  const tokenFile = path.join(dir, "bridge.token");

  // Generate token
  const token = crypto.randomUUID();

  // Write to file
  fs.mkdirSync(dir, { recursive: true });
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
