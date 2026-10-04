# collab-mcp

A small, **local**, SQLite-backed [MCP](https://modelcontextprotocol.io) server that gives
your AI coding agent a knowledge base it keeps across sessions. Capture decisions, gotchas
and changelogs while you work; next session your agent searches them instead of
re-deriving everything from the code.

No cloud, no account, no telemetry. The data is one SQLite file you own.

Works with any MCP-capable agent — Claude Code, Codex, agy, Cursor, Cline, Windsurf, Zed.
You need one of them, not all of them.

## Requirements

Node.js ≥ 20.9. That's it.

## Quick start

```bash
git clone <this repo>
cd collab-mcp
npm install
npm run build
```

Then open your agent **in the project where you want the knowledge base**, and paste the
prompt from [`SETUP-PROMPT.md`](./SETUP-PROMPT.md) with this folder's path filled in. It
registers the MCP server, merges the conventions into your `CLAUDE.md` / `AGENTS.md`,
installs the workflow skill, and verifies the connection — then tells you what it changed.

To update later: `git pull && npm install && npm run build`.

## Where your data lives — read this once

The server picks its database in this order:

1. an explicit path passed in code
2. **`$COLLAB_DB_PATH`** ← set this
3. `./collab.db`, relative to the current working directory

**Set `COLLAB_DB_PATH` explicitly for every project.** If you don't, the fallback follows
whatever directory your agent happened to start in, and you can end up with a stray empty
database — or, if you point several projects at one install without it, at knowledge from
an unrelated project. An earlier version defaulted to a path *inside the install*, which
silently merged two projects' knowledge bases for days before anyone noticed. The server
now prints the file it opened on stderr; if something looks wrong, that line is the answer.

One database per project is the normal setup. Pointing several projects at the same file is
also fine — just make it a deliberate choice rather than an accident.

## What your agent gets

Twenty-one `collab_*` tools over one FTS5-indexed store. The ones that matter day to day:

- `collab_search` / `collab_get` / `collab_list_recent` — retrieval, filterable by module,
  type and date
- `collab_add` — record a `decision`, `gotcha`, `changelog`, `handoff` or `review`
- `collab_task_*` — lightweight task tracking with assignment and transitions
- `collab_module_get` — one call that returns a module's active tasks, recent decisions and
  top gotchas: the "catch me up" primitive
- `collab_doctor` — integrity and orphan-reference lint

Conventions live in [`AGENTS.md`](./AGENTS.md) and the portable skill in
[`skills/collab-workflow/`](./skills/collab-workflow/). Both are installed for you by the
setup prompt.

## Optional: the web UI

A React SPA and REST host ship alongside the MCP server for browsing and editing entries by
hand. Entirely optional — the MCP server never depends on it.

```bash
npm run ui:build     # -> ui/dist
node server/server.js
```

Open <http://127.0.0.1:7473/>. For hot reload, run `node server/server.js` and
`cd ui && npm run dev` in parallel, then use <http://localhost:5173/>.

**Localhost-only, with no user accounts.** Do not expose it to a network.

### REST API access

The web server only answers its own UI. Every `/api` request needs the header
`X-Collab-Key`; the key is new on every server start and is written to
`%LOCALAPPDATA%\collab\web\key` (Windows) or `~/.local/share/collab/web/key`.
A script on this machine can read that file:

    curl -H "X-Collab-Key: $(cat ~/.local/share/collab/web/key)" http://127.0.0.1:7473/api/collab/stats

Requests from other websites, with a wrong Host/Origin, or with a non-JSON body are refused.

## Optional: dispatching to Codex

`scripts/codex-dispatch.sh` sends a prompt to Codex and records the result as a collab entry
automatically. `--review` files it as a review instead of a handoff.

```bash
bash scripts/codex-dispatch.sh "refactor the parser" --db /path/to/project/collab.db
```

Always pass `--db`, or the entry follows the same fallback chain described above. The
script also points Codex's *own* collab MCP server at that database for the duration of
the run, so tools the agent calls mid-task write to the same place.

## Layout

npm workspaces monorepo, TypeScript, ESM.

```text
collab-mcp/
├── core/         # @collab-mcp/core — all domain logic (DB + collab ops)
│   ├── src/db.ts       # connection + migrations + path resolution
│   └── src/ops/        # add, search, get, task, module, ingest, rollup,
│                       #   doctor, export, savings, supersede, update
├── mcp/          # thin MCP stdio adapter over core
│   ├── src/server.ts   # registers the collab_* tools
│   ├── migrations/     # 0001–0004 SQL — the schema lives here
│   └── claude/         # slash commands + session hooks
├── server/       # REST host; also serves the built UI
├── ui/           # React + Vite SPA (optional)
├── scripts/      # codex dispatch, bundle.mjs, seed-starter.mjs
└── gemini-mcp/   # deprecated, scheduled for removal
```

Domain logic lives **only** in `core/src/ops/`. `mcp/` and `server/` are thin adapters over
it, which is why the MCP tools and the web UI can never disagree about your data.

## Sharing it

`npm run bundle` emits `dist-share/collab-mcp.zip` — source, migrations and onboarding docs,
with the database, `.env` and UI excluded. Useful for handing someone a copy offline;
cloning this repo is the better path for anyone who wants updates.

## License

MIT.
