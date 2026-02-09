#!/usr/bin/env node
"use strict";

const http = require("http");
const { execFile } = require("child_process");
const { which } = require("./which");

const PORT = parseInt(process.env.PORT || "7890", 10);
const HOST = "127.0.0.1";
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:5174",
];

const CLI_REGISTRY = {
  claude: { cmd: "claude", args: ["--print"], timeout: 120_000 },
  gemini: { cmd: "gemini", args: ["-m", "gemini-3-flash-preview", "-o", "text"], timeout: 120_000 },
  codex: { cmd: "codex", args: ["exec", "-c", "features.rmcp_client=false", "-s", "read-only"], timeout: 180_000 },
};

function detectClis() {
  return Object.entries(CLI_REGISTRY)
    .filter(([, info]) => which(info.cmd))
    .map(([name]) => name);
}

function runCli(name, prompt) {
  return new Promise((resolve) => {
    const info = CLI_REGISTRY[name];
    if (!info) return resolve({ cli: name, error: `Unknown CLI: ${name}`, success: false });
    if (!which(info.cmd)) return resolve({ cli: name, error: `${name} CLI not installed`, success: false });

    const start = Date.now();
    const child = execFile(info.cmd, [...info.args, prompt], { timeout: info.timeout }, (err, stdout, stderr) => {
      const elapsed = +((Date.now() - start) / 1000).toFixed(2);
      if (err) {
        const msg = err.killed ? `Timeout after ${info.timeout / 1000}s` : stderr?.slice(0, 500) || err.message;
        return resolve({ cli: name, error: msg, success: false, elapsed });
      }
      resolve({ cli: name, response: stdout.trim(), success: true, elapsed });
    });
    child.stdin?.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return json(res, 204, "");

  const url = req.url?.split("?")[0];

  if (url === "/health" && req.method === "GET") {
    return json(res, 200, { status: "ok", cli: detectClis(), version: "0.1.0" });
  }

  if (url === "/analyze" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: "prompt is required" });
      const result = await runCli(body.cli || "gemini", body.prompt);
      return json(res, result.success ? 200 : 502, result);
    } catch { return json(res, 400, { error: "Invalid JSON" }); }
  }

  if (url === "/multi-analyze" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: "prompt is required" });
      const clis = body.clis || ["claude", "gemini"];
      const results = await Promise.all(clis.map((c) => runCli(c, body.prompt)));
      return json(res, 200, { results, requestedClis: clis, successCount: results.filter((r) => r.success).length });
    } catch { return json(res, 400, { error: "Invalid JSON" }); }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\nAI Stocks Bridge v0.1.0`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Available CLIs: ${detectClis().join(", ") || "(none detected)"}\n`);
});
