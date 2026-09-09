# Collab MCP

A small, **local**, SQLite-backed [MCP](https://modelcontextprotocol.io) server that
gives your AI assistant a shared knowledge base across sessions. Capture decisions,
gotchas, and changelogs as you work; your AI searches them next time instead of
re-deriving everything. No cloud, no account — the data lives in one SQLite file you
control.

## Requirements

- **Node.js ≥ 20.9**

## Install

```bash
npm install
npm run build
```

This builds the two packages (`@collab-mcp/core`, `collab-mcp`). The MCP server entry
point is then at `mcp/dist/server.js`.

## Connect your agent

You need **one** MCP-capable agent — Claude Code, Codex, agy (Antigravity), or any other
MCP client (Cursor, Cline, Windsurf, Zed, …). You don't need all of them, and none is
required specifically.

### Easiest: let your AI set it up

Open your agent in your project and paste the prompt from
[`SETUP-PROMPT.md`](./SETUP-PROMPT.md) with this folder's path filled in. The agent will
build the server, register it, merge the conventions into your existing `AGENTS.md` /
`CLAUDE.md` (or create one), install the workflow skill, and verify the connection.

### Manual setup

The server speaks standard MCP, so any MCP client works. Verified setups:

**Claude Code** — add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "collab": {
      "command": "node",
      "args": ["<path>/mcp/dist/server.js"],
      "env": { "COLLAB_DB_PATH": "<workspace>/collab.db" },
      "type": "stdio"
    }
  }
}
```

**Codex:**

```bash
codex mcp add collab --env COLLAB_DB_PATH=<workspace>/collab.db -- node <abs>/mcp/dist/server.js
```

**agy (Antigravity CLI)** — add to `~/.gemini/antigravity-cli/mcp_config.json`:

```json
{
  "mcpServers": {
    "collab": {
      "command": "node",
      "args": ["<abs>/mcp/dist/server.js"],
      "env": { "COLLAB_DB_PATH": "<workspace>/collab.db" }
    }
  }
}
```

## Per-workspace database (`COLLAB_DB_PATH`)

The default database lives **inside the package**, so if you don't set `COLLAB_DB_PATH`,
every workspace shares one DB. Point `COLLAB_DB_PATH` at a per-workspace file (e.g.
`<workspace>/collab.db`) to keep each project's knowledge separate. The DB is created and
migrated automatically on first run.

## Optional: starter content

```bash
npm run seed:starter
```

Seeds a few self-documenting onboarding entries (including agent-setup notes), so your
first `collab_search` returns something useful. Idempotent — safe to run once.

## Optional: the workflow skill

Install `skills/collab-workflow/` into your agent so it knows the search-before-add /
capture loop natively:

- Claude Code → `.claude/skills/collab-workflow/`
- Codex → `.codex/skills/collab-workflow/`
- agy → `~/.gemini/antigravity-cli/skills/collab-workflow/`

## Tools

The MCP server exposes:

- **Knowledge:** `collab_search`, `collab_add`, `collab_get`, `collab_update`,
  `collab_supersede`, `collab_list_recent`
- **Modules:** `collab_module_get`, `collab_module_init`
- **Tasks:** `collab_task_create`, `collab_task_assign`, `collab_task_get`,
  `collab_task_transition`
- **Maintenance:** `collab_doctor`, `collab_rollup`, `collab_archive`,
  `collab_savings_report`, `collab_export`, `collab_ingest`

## License

MIT — see [LICENSE](./LICENSE).
