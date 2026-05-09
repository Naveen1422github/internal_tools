# Internal Tools

Local web dashboard for personal engineering workflows. Runs on `127.0.0.1:7473`.

## Tabs

- **Identities** - Codex profile manager. Switch profiles, save the current login, run validation probes, view rate-limit status.
- **Collaboration** - Browse and edit the Collab MCP database (entries, tasks, modules) with FTS5 search, doctor, JSON/Markdown export.
- **Console** - Real terminal sessions backed by node-pty, rendered with xterm.js. `+New > Bash` for a Git Bash shell. `+New > Claude / Codex / Gemini` spawns the corresponding agent CLI directly via the adapter in `tools/agents/`. Cmd-K palette for fuzzy task / agent / command navigation. Drag a task onto a tab to inject its context envelope.

## Run

```bash
cd internal-tools
npm install
npm run dev          # nodemon, auto-restart on server changes
# or: npm start

# Optional: server-side debug logs
CONSOLE_DEBUG=1 npm run dev
```

Open `http://127.0.0.1:7473/`.

If Git Bash isn't at a standard location, set `GIT_BASH=/path/to/bash.exe` before starting.

## Adding a tool

1. Create `tools/foo.js` exporting `module.exports.routes = { 'GET /api/foo/...': handler, ... }`.
2. In `server.js`, require and spread `foo.routes` into the routes map.

## Layout

```text
internal-tools/
|-- server.js              # http server + static + route dispatch
|-- nodemon.json           # watch list (server.js + tools/, ignores data/, public/)
|-- tools/
|   |-- codex.js           # /api/codex/* - profile manager
|   |-- collab.js          # /api/collab/* - DB explorer (mirrors collab-mcp)
|   |-- console.js         # /api/console/* - PTY sessions + raw SSE stream
|   |-- workspace.js       # /api/workspace/* - cwd info, git status, agent detect, file tree
|   `-- agents/            # per-agent CLI adapters
|-- public/
|   |-- index.html         # Alpine UI
|   |-- app.js             # state + handlers
|   |-- style.css          # Tailwind base
|   |-- styles.css         # Console theme
|   |-- styles-terminal.css
|   |-- styles-overlays.css
|   `-- favicon.svg
|-- data/                  # gitignored runtime state (session list)
`-- collab-mcp/            # MCP server (separate; see its README)
```

## Notes

- Localhost-only, no auth.
- Dashboard reads/writes `collab-mcp/collab.db` directly via `better-sqlite3`. For automated/agent flows, prefer the `mcp__collab__*` MCP tools.
- The Console's xterm.js renderer is the same library VS Code uses; copy with `Ctrl+Shift+C`, paste with `Ctrl+Shift+V`.
