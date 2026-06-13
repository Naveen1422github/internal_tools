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
|-- server.js              # http server + static + route dispatch
|-- tools/
|   `-- collab.js          # /api/collab/* - DB explorer (mirrors collab-mcp)
|-- public/
|   |-- index.html         # Alpine UI
|   |-- app.js             # state + handlers
|   |-- style.css          # Tailwind base
|   |-- styles.css         # Dashboard theme
|   `-- favicon.svg
`-- collab-mcp/            # MCP server (separate; see its README)
```

## Notes

- Localhost-only, no auth.
- Dashboard reads/writes `collab-mcp/collab.db` directly via `better-sqlite3`. For automated/agent flows, prefer the `mcp__collab__*` MCP tools.
