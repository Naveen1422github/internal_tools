# Internal Tools

Local utility tools and dashboards for the project. Two components:

- **Internal Tools Dashboard** — a localhost web UI for managing Codex profiles and browsing/editing the collab DB. Lives in this directory.
- **Collab MCP Server** — the SQLite-backed collaboration store with MCP tools and slash commands. Lives in [`collab-mcp/`](./collab-mcp/).

---

## 1. Internal Tools Dashboard

A small Node http server (no framework) that serves a vanilla-JS Alpine UI and exposes JSON APIs for the dashboard to call.

- **Entry point:** `server.js`
- **Port:** `7473` (override with `PORT=...`)
- **Bind:** `127.0.0.1` only (localhost — no auth, not for remote access)

### Features

- **Codex Profile Manager** — GUI for `codex-profile.sh`. Switch profiles, mark rate-limited, save the current login as a named profile, run `check`/`check --all` probes, edit labels and reset times, delete profiles. Calls the canonical script via bash.
- **Collab DB Explorer** — browse, search (FTS5), view, edit, and delete collab `entries`. List/edit `tasks` and `modules`. Direct SQLite reads/writes against `collab-mcp/collab.db`.
- **Engineering Console** — terminal sessions with real PTYs, agent CLI adapters (Claude/Codex/Gemini/Jules), task-driven spawn from collab DB, Cmd-K palette, drag-task-to-tab, SSE-streamed output. Stylesheets split across `style.css` (Tailwind base), `styles.css` (Console theme), `styles-overlays.css`, `styles-terminal.css`.

### Usage

```bash
cd internal-tools
npm install
npm start            # → http://127.0.0.1:7473/
npm run dev          # auto-restart server with nodemon
```

If Git Bash isn't at one of the standard locations, set `GIT_BASH=/path/to/bash.exe` before `npm start` so the codex profile API can shell out.

### Adding a new tool

1. Create `tools/foo.js` exporting `module.exports.routes = { 'GET /api/foo/...': handler, ... }`.
2. In `server.js`, `require('./tools/foo')` and spread `foo.routes` into the routes map.
3. Restart `npm start`.

### Directory layout

```
internal-tools/
├── server.js          ← http server + static file handler
├── package.json
├── tools/
│   ├── agents/        ← per-agent CLI adapters (Claude, Codex, Gemini, Jules) + envelope formatter
│   ├── codex.js       ← /api/codex/* — profile manager
│   ├── console.js     ← /api/console/* — PTY sessions + SSE
│   └── collab.js      ← /api/collab/* — DB explorer
├── public/
│   ├── index.html     ← Alpine UI
│   ├── app.js         ← state + handlers
│   ├── style.css      ← Tailwind base layer
│   └── styles*.css    ← console theme + overlays + terminal styles
└── collab-mcp/        ← MCP server (separate from the dashboard)
```

### Important caveat — dashboard vs MCP

The dashboard reads/writes `collab.db` **directly via better-sqlite3**, not through the MCP server. The two paths share the database but not their code. To prevent drift:

- `tools/collab.js` mirrors the MCP `KIND_BY_TYPE` mapping and the `SLUG_REGEX` from `collab-mcp/src/tools/`. **Keep these in sync** if the MCP versions change.
- Validation happens server-side in `tools/collab.js` (rejects invalid types, oversized summaries, malformed slugs, attempts to create `rollup` entries).
- For automated/agent flows, prefer the MCP tools (`mcp__collab__*`) — they're the canonical interface.

---

## 2. Collab MCP Server

SQLite + FTS5 + MCP server that stores tasks, handoffs, reviews, decisions, gotchas, and module state. Replaces the older file-based `.claude/collab/*.md` system.

**Status:** Phase 1 complete (all 9 build steps in `DESIGN.md §15`). Ready to dogfood; Phase 2 will be driven by real friction.

See [`collab-mcp/README.md`](./collab-mcp/README.md) for full usage (slash commands, MCP tools, hooks, troubleshooting) and [`collab-mcp/DESIGN.md`](./collab-mcp/DESIGN.md) for the rationale and design.

---

## Conventions

- **No build step for the dashboard** — server.js + tools/* are plain CommonJS, served as-is. The frontend is vanilla HTML/JS/CSS via Alpine.
- **No nested git repos.** Everything is tracked by the parent repo (`frontend2/`).
- **Local-only.** Don't expose `internal-tools/` to a public network. There's no auth.
- **DB lives at `collab-mcp/collab.db`** (gitignored). The dashboard opens it read-write — close other writers before destructive ops.
