# Internal Tools

Local web dashboard for collaboration management. Runs on `127.0.0.1:7473`.

## Features

- **Collaboration** - Browse and edit the Collab MCP database (entries, tasks, modules) with FTS5 search, doctor, and JSON/Markdown export.
- **Durable Memory** - Source of truth for agent handoffs, decisions, and project "gotchas".
- **Lightweight** - Zero native dependencies, fast startup, and minimal footprint.

## Run

```bash
cd internal-tools
npm install
npm run dev          # nodemon, auto-restart on server changes
# or: npm start
```

Open `http://127.0.0.1:7473/`.

## Layout

npm workspaces monorepo (TypeScript, ESM). Five packages:

```text
internal-tools/
├── core/         # @collab-mcp/core — all domain logic (DB + the collab ops)
│   ├── src/db.ts
│   └── src/ops/  # add, search, get, task, module, ingest, rollup, doctor,
│                 #   export, savings, supersede, update, list-recent
├── mcp/          # @collab-mcp/mcp — thin MCP stdio adapter over core (see its README)
│   ├── src/server.ts   # registers the mcp__collab__* tools
│   ├── migrations/     # 0001–0004 SQL — the schema lives here
│   └── src/scripts/    # seed, codex-output parser, hook helpers
├── server/       # @collab-mcp/server — HTTP host: REST API + serves the built UI
│   └── src/tools/{collab,ai}.ts   # /api/collab/* and /api/ai/* routes
├── ui/           # React + Vite SPA (Dashboard, Tasks, Modules, Knowledge, Health, AiPanel)
├── gemini-mcp/   # Gemini skim/locate MCP server (separate; see its README)
└── scripts/      # bundle.mjs (emits the shareable dist-share/), seed-starter.mjs
```

Domain logic lives **only** in `core/src/ops/`; `mcp/` and `server/` are thin adapters
(MCP stdio and REST) over it. The SQLite store is `mcp/collab.db` (gitignored).

## Notes

- Localhost-only, no auth.
- The dashboard and `mcp__collab__*` tools share the same DB via `@collab-mcp/core`
  (`better-sqlite3`). For automated/agent flows, prefer the MCP tools.

## UI (React SPA)

Two modes:

- **Dev (hot reload):** run the backend and the Vite dev server in parallel.
  ```bash
  node server/server.js        # backend on :7473
  cd ui && npm run dev         # UI on :5173, proxies /api -> :7473
  ```
  Open http://localhost:5173/

- **Integrated (single server):** build the UI, then the Node server serves it.
  ```bash
  cd ui && npm run build       # -> ui/dist
  node server/server.js        # serves ui/dist at http://127.0.0.1:7473/
  ```

The server serves the built UI from `ui/dist`. If it's absent, static routes return
`503 — UI not built. Run npm run ui:build first.` (there is no legacy dashboard fallback).
