# Jules Task T1 — Real PTY backend (Phase 1)

## Goal
Replace the simulated `tools/console.js` with a real interactive terminal backend using `node-pty` and Server-Sent Events (SSE). Sessions must survive a server restart.

## Scope — files you may touch
- `internal-tools/tools/console.js` (rewrite)
- `internal-tools/server.js` (extend route handling to support SSE)
- `internal-tools/package.json` (add `node-pty` dependency)
- `internal-tools/data/sessions.json` (NEW — persistence file, gitignored)
- `internal-tools/.gitignore` (add `data/sessions.json`)

**DO NOT touch** any file in `public/`, `tools/agents/` (does not exist yet), `tools/codex.js`, `tools/collab.js`, `collab-mcp/`, `gemini-mcp/`, `briefs/`, `design-reference/`.

## Background
The existing `tools/console.js` returns fake `"Output for: <cmd>"` strings. The Engineering Console design (see `design-reference/app.jsx` and `design-reference/terminal.jsx`) expects real shell output streamed live. Sessions hold a list of "blocks" — each block is one command + its output lines.

## Functional requirements

### 1. Spawn real PTY sessions
- Use `node-pty` (`@homebridge/node-pty-prebuilt-multiarch` if `node-pty` fails to install on Windows).
- `agent === 'bash'` → spawn `bash` (or `cmd.exe` on Windows if bash unavailable; prefer Git Bash at `C:\Program Files\Git\bin\bash.exe`, fall back to `process.env.GIT_BASH`, then `cmd.exe`).
- `agent === 'claude' | 'codex' | 'gemini' | 'jules'` → spawn `bash` for now and write a TODO comment: `// AGENT_ADAPTER_HOOK — see tools/agents/<agent>.js (T3)`. Do NOT try to actually launch agent CLIs in T1.
- Each session keeps `{ id, name, agent, cwd, activeTaskId?, blocks: [...], pid, _pty }` in memory; `_pty` is non-serializable.

### 2. SSE streaming
- New route: `GET /api/console/session/stream?id=<sessionId>` → returns `text/event-stream`.
- Each event is JSON: `{ type: 'data' | 'exit' | 'block-start' | 'block-end', sessionId, payload }`.
  - `data`: `payload = { line, ansiClass? }` — chunks of stdout/stderr from the PTY. Detect coarse ANSI styling (red, green, yellow, cyan, dim, bold) and map to one of `['ansi-red','ansi-green','ansi-yellow','ansi-cyan','ansi-dim','ansi-bold','ansi-purple','']`. Strip raw escape codes from `line`.
  - `block-start`: emitted when a new command is submitted, payload = the new block stub `{ stamp, cmd, exit: 'run', out: [] }`.
  - `block-end`: emitted on prompt return with `{ duration, exit: 'ok'|'err', code }`.
- Detect "command finished" by either exit code (for one-shot mode) or by tracking when the shell prompt re-appears. Simplest robust path: run each command in **one-shot mode** — `bash -lc <cmd>` — keep one persistent PTY per session for env, but execute commands by writing them and piping a unique sentinel like `echo "::END::$?"` after.

### 3. HTTP routes
Keep all existing route paths. Replace simulated logic:
- `GET /api/console/sessions` — list (without `_pty`).
- `POST /api/console/session/spawn` — body `{ agent, opts }` → spawns PTY, persists, returns `{ ok, session }`.
- `POST /api/console/session/close` — body `{ id }` → kills PTY, removes from store, persists.
- `POST /api/console/command/run` — body `{ sessionId, text }` → writes to PTY, returns `{ ok, blockId }`. Output streams via SSE, NOT in this response.
- `GET  /api/console/session/stream?id=` — SSE (new).
- `POST /api/console/session/input` — body `{ id, data }` → writes raw bytes to PTY (used for interactive prompt responses; agents will need this).

### 4. Persistence
- On every block-end and on session close, serialize sessions (minus `_pty`) to `data/sessions.json`.
- On server start, read the file if present; spawn fresh PTYs for each session and replay nothing — we only restore the conversation history (blocks). Live PTYs do not survive restart, that is acceptable; user just gets a fresh prompt with the old transcript visible.

### 5. server.js
The current `server.js` does `routes[key](req, res, send, body)` — that pattern works for JSON returns. SSE needs to keep the response open. Add a way for a route to opt out of the JSON `send` shortcut: if a handler returns `'__sse__'` or the route key is prefixed with `SSE`, skip auto-end. Keep changes minimal and document them.

## Acceptance criteria
- [ ] `npm install` succeeds on Windows (Git Bash) and Linux.
- [ ] `npm start`, then `curl -N http://127.0.0.1:7473/api/console/session/stream?id=<id>` shows live output as you submit commands via `POST /api/console/command/run`.
- [ ] Killing the server and restarting preserves the `blocks` history of every session.
- [ ] `tools/console.js` exports the same `module.exports.routes` shape as before so `server.js` keeps working.
- [ ] Graceful shutdown: SIGINT closes all PTYs.
- [ ] No regressions to `/api/codex/*` or `/api/collab/*`.

## How to verify
```bash
npm install
npm start &
SID=$(curl -s -X POST http://127.0.0.1:7473/api/console/session/spawn \
       -H 'content-type: application/json' \
       -d '{"agent":"bash"}' | jq -r .session.id)
# In one terminal:
curl -N "http://127.0.0.1:7473/api/console/session/stream?id=$SID"
# In another:
curl -X POST http://127.0.0.1:7473/api/console/command/run \
     -H 'content-type: application/json' \
     -d "{\"sessionId\":\"$SID\",\"text\":\"ls -la\"}"
```
You should see the directory listing arrive over SSE, color-coded.

## Out of scope (do not do)
- Frontend changes (T2 owns those).
- Agent CLI integration — leave the hook comment, T3 owns it.
- Auth / WebSocket / cluster mode.

## PR title
`T1: real PTY backend with SSE streaming + session persistence`
