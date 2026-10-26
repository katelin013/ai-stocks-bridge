# AI Stocks Bridge

Connects your browser to local AI CLI tools (Gemini, Claude, Codex).

A minimal HTTP server that runs on `localhost:7890` and forwards analysis prompts from the AI Stocks web app to your locally installed AI CLI tools.

## Quick Start

```bash
# Option 1: Run directly (requires Node.js 18+)
npx ai-stocks-bridge

# Option 2: Install globally
npm install -g ai-stocks-bridge
ai-stocks-bridge

# Option 3: Download from GitHub Releases
# https://github.com/katelin013/ai-stocks-bridge/releases
```

## Prerequisites

At least one AI CLI tool installed:

| CLI | Install | Docs |
|-----|---------|------|
| Antigravity CLI (`agy`, for Gemini) | [antigravity.google](https://antigravity.google) | [antigravity.google](https://antigravity.google) |
| Claude CLI | `npm install -g @anthropic-ai/claude-code` | [claude.ai](https://claude.ai) |
| Codex CLI | `npm install -g @openai/codex` | [openai.com](https://openai.com) |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status + detected CLIs + session token |
| `/analyze` | POST | Single CLI analysis |
| `/multi-analyze` | POST | Parallel multi-CLI analysis |
| `/v1/chat/completions` | POST | OpenAI-compatible chat with tool calling (Claude CLI backed) |
| `/v1/models` | GET | OpenAI-compatible model list (`bridge-claude`) |

### OpenAI-compatible layer (`/v1/*`)

For local trusted clients (e.g. LiteLLM-based agents). Send standard OpenAI
`messages` + `tools`; the bridge instructs the local Claude CLI to reply with a
JSON tool-call protocol and maps it back to `tool_calls` / `content`. SSE
streaming (`"stream": true`) is supported.

- Auth: the same bridge token, via `Authorization: Bearer <token>` or `X-Bridge-Token`
- Session optimization: repeated conversations resume the underlying Claude CLI
  session (`--resume`) and send only delta messages (prefix-hash mapping);
  any mismatch falls back to replaying the full history
- Responses are plain JSON (not encrypted) — this endpoint is for
  server-to-server localhost use, unlike the browser-facing `/analyze`

```bash
TOKEN=$(cat ~/.ai-stocks/bridge.token)
curl http://127.0.0.1:7890/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"bridge-claude","messages":[{"role":"user","content":"hi"}]}'
```

### Examples

```bash
# Check health
curl http://localhost:7890/health

# Single analysis
curl -X POST http://localhost:7890/analyze \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Analyze AAPL stock", "cli": "gemini"}'

# Multi-brain analysis
curl -X POST http://localhost:7890/multi-analyze \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Analyze AAPL stock", "clis": ["claude", "gemini"]}'
```

## Security

- **Localhost only** -- Listens on `127.0.0.1`, no external connections accepted
- **Zero network requests** -- Bridge never connects to any external server
- **Zero dependencies** -- Uses only Node.js built-in modules
- **Fully open source** -- Core code under 100 lines, review it yourself
- **CORS restricted** -- Only allows requests from specified origins
- **Token persistence** -- Session token is saved to `~/.ai-stocks/bridge.token` (mode 0600) and reused across restarts. The `/health` endpoint returns the current token so the frontend can auto-sync without manual re-entry.

### Prompt Encryption

All prompts and AI responses are encrypted with AES-256-GCM before transmission between browser and Bridge. The encryption key is derived from the session token using HKDF (SHA-256).

**Important:** This encryption prevents casual inspection via browser DevTools. It is not a substitute for TLS in non-localhost environments. The key derivation is deterministic from the session token -- anyone with access to the token can derive the same key.

## How It Works

```
Browser (AI Stocks SaaS)       Your Machine
+-------------+  fetch        +------------------+
| React App   | -----------> | AI Stocks Bridge  |
| :5173       | <----------- | localhost:7890    |
+-------------+  JSON         |                  |
                               | -> agy (Gemini)  |
                               | -> claude CLI    |
                               | -> codex CLI     |
                               +------------------+
```

The Bridge acts as a thin proxy: it receives prompts from the browser, passes them to your locally installed CLI tools via subprocess, and returns the results as JSON. Your API keys and data never leave your machine.

## License

MIT
