"use strict";

const { execFileSync } = require("child_process");
const os = require("os");

/**
 * Cross-platform `which` using only Node.js built-ins.
 * Returns the path if found, null otherwise.
 */
function which(cmd) {
  try {
    const bin = os.platform() === "win32" ? "where" : "which";
    const result = execFileSync(bin, [cmd], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    return result.toString().trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

module.exports = { which };
