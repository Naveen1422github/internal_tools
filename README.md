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

```text
internal-tools/
|-- core/                  # shared DB helpers and constants
|-- server/                # http server, static assets, and route dispatch
|   |-- server.js
|   |-- tools/
|   |   `-- collab.js      # /api/collab/* - DB explorer
|   `-- public/
|       |-- index.html
|       |-- app.js
|       |-- style.css
|       `-- styles.css
`-- mcp/                   # MCP server (separate; see its README)
```

## Notes

- Localhost-only, no auth.
- Dashboard reads/writes `mcp/collab.db` directly via `better-sqlite3`. For automated/agent flows, prefer the `mcp__collab__*` MCP tools.

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

If `ui/dist` is absent, the server falls back to the legacy `server/public` dashboard.
