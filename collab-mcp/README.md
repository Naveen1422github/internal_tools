# Collab MCP

SQLite-backed collaboration store for Claude + Codex + Gemini. Tasks, handoffs, reviews, decisions, gotchas, and module state — all queryable via MCP tools or `/collab-*` slash commands.

**Status:** Phase 1 complete (steps 1–9 of `DESIGN.md §15`). Ready to dogfood. See **[DESIGN.md](./DESIGN.md)** for the rationale and full design.

---

## Quick start

### One-time setup (already done in this repo)

```bash
cd internal-tools/collab-mcp
npm install
npm run migrate         # creates collab.db (idempotent)
```

The MCP server is registered in the workspace `.mcp.json` and enabled in `.claude/settings.local.json`. Slash commands and session hooks are wired. **Restart Claude Code once after setup** so MCP tools register.

Verify it's live:

```bash
npm run dev             # should print "collab-mcp stdio server listening" and stay running
# Ctrl+C to exit — Claude Code spawns it on demand
```

In Claude, type `/` and you should see `collab-start`, `collab-pickup`, `collab-handoff`, `collab-review`, `collab-dispatch`, `collab-done`.

### Everyday flow

```
/collab-start <module-slug>      → load module card (active tasks, gotchas, recent handoffs)
   ↓ work happens, Codex dispatched, code changes
/collab-handoff                  → save handoff from current git diff
   ↓ next session
/collab-pickup <module-slug>     → see what's recent and what's still open
```

The `Stop` hook nudges you to write a handoff if you have uncommitted changes and no handoff was logged this session.

---

## Slash commands (use these in Claude)

| Command | What it does |
|---|---|
| `/collab-start <slug>` | Loads the module card. Offers to `init` the module if it doesn't exist yet. |
| `/collab-pickup <slug>` | Same as start, but framed as "what's open / what changed since I left." |
| `/collab-handoff [--task T-NNN]` | Drafts a handoff from your git diff + recent actions, asks you to confirm, saves it. |
| `/collab-review` | Saves a review entry (links to files reviewed). |
| `/collab-dispatch <prompt>` | Sends a task to Codex, persists the result as a handoff. |
| `/collab-done <task-id>` | Transitions a task to `done`. |

Canonical bodies live at `internal-tools/collab-mcp/claude/commands/*.md`. The `.claude/commands/collab-*.md` files are tiny redirects so the source of truth stays inside this package.

---

## MCP tools (full surface)

All exposed as `mcp__collab__<name>`. 14 tools across 5 areas:

**Read**
- `collab_search { q?, type?, module?, agent?, since?, limit? }` — FTS5 full-text + filters. Returns summaries; pull bodies via `collab_get`.
- `collab_get { id }` — full body for one entry.
- `collab_list_recent { module?, type?, agent?, limit? }` — newest-first list of summaries.

**Write — entries**
- `collab_add { type, title, summary, description?, agent?, module?, task_id?, refs?, status? }` — append a `handoff | review | proposal | counter | decision | gotcha | session-note | changelog`. **Cannot create `rollup` here** — use `collab_rollup`.
- `collab_ingest { source, raw_text, context? }` — read-only parser; returns `{draft_entry, confidence}`. Caller reviews, then calls `collab_add` to persist. Used by `/collab-handoff` and the Codex dispatch script.

**Write — tasks**
- `collab_task_create { id, title, summary, ... }` — IDs are user-chosen (e.g. `T-001`, `CR-042`).
- `collab_task_transition { id, status }` — `pending → assigned → in-progress → review → done`.
- `collab_task_assign { id, assignee }` — `Claude | Codex | Gemini | User`.
- `collab_task_get { id }` — task row + linked entry summaries.

**Write — modules**
- `collab_module_init { slug, name?, summary?, current_goal?, description? }` — idempotent on slug.
- `collab_module_get { slug }` — module card: active_tasks, top_gotchas, recent_decisions, recent_handoffs.

**System**
- `collab_rollup { task_id? | (since + group_by) }` — concatenates entries into a `rollup` entry; deprecates originals atomically per group. No LLM synthesis (D7=B locked in DESIGN.md).
- `collab_export { format: "json" | "markdown", filter? }` — returns `{format, entry_count, body}`. Caller writes to disk.
- `collab_doctor` — runs 9 health checks (3 schema, 5 data integrity, 1 FTS parity). Returns `{ok, checks[]}`.

---

## Codex dispatch (shell)

Send tasks to Codex from any terminal, results auto-persist to `collab.db`:

```bash
# Basic dispatch (saves as type=handoff)
bash .claude/scripts/codex-dispatch.sh "implement feature X"

# Review-type entry
bash .claude/scripts/codex-dispatch.sh "review changes" --review

# Run inside a specific service dir
bash .claude/scripts/codex-dispatch.sh "fix bug" --dir ./emp1st-auth-service

# Link to task + module (module also auto-inferred from --dir basename)
bash .claude/scripts/codex-dispatch.sh "implement T-001" --task T-001 --module custom-reports

# Quiet mode — full JSONL goes to ~/.codex/logs/, terminal shows milestones only
bash .claude/scripts/codex-dispatch-quiet.sh "..."
```

The script pipes raw JSONL through `src/scripts/parse-codex-output.ts --save`, which calls `collab_ingest` + `collab_add` internally. Failures bubble up — entries never silently drop.

---

## File map

```
internal-tools/collab-mcp/
├── DESIGN.md                  ← design v0.2 + build order (§15)
├── README.md                  ← this file
├── collab.db                  ← SQLite store (gitignored)
├── migrations/
│   └── 0001_init.sql          ← schema, indexes, FTS5 triggers, CHECKs
├── src/
│   ├── server.ts              ← MCP stdio entry (14 registerTool calls)
│   ├── db.ts                  ← better-sqlite3 connection + migration runner
│   ├── migrate.ts             ← migration CLI
│   ├── tools/                 ← one file per tool: search, get, list-recent,
│   │                              add, ingest, task, module, rollup, export, doctor
│   └── scripts/
│       ├── seed.ts            ← idempotent test data
│       ├── manual-search.ts   ← MCP-less smoke test
│       ├── module-card.ts     ← used by SessionStart hook
│       ├── check-handoff-needed.ts  ← used by Stop hook
│       └── parse-codex-output.ts    ← Codex JSONL → collab.add
└── claude/commands/           ← canonical slash command bodies
                                  (.claude/commands/collab-*.md are redirects)
```

Hooks (in repo root, not this package):
- `.claude/hooks/collab-session-start.sh` — emits module card via `additionalContext` if cwd basename matches a known module.
- `.claude/hooks/collab-stop-nudge.sh` — nudges to write a handoff when ending a session with uncommitted changes and no handoff logged.
- `.claude/hooks/session-logger.sh` — generic Edit/Write logger.

---

## Maintenance

```bash
# Health check (run anytime — schema, FTS parity, data integrity)
# In Claude: call collab_doctor MCP tool. Or via export:
npm run dev              # in another terminal, then call from MCP client

# Backup the DB
cp collab.db "collab-$(date +%Y%m%d).db.bak"

# Reset (NUCLEAR — wipes all entries/tasks/modules)
rm collab.db && npm run migrate

# Re-apply migrations on existing DB (safe — idempotent)
npm run migrate

# Repopulate seed data
npm run seed
```

---

## Troubleshooting

**Slash commands don't appear in Claude**
Restart Claude Code. MCP servers register on session start.

**`collab_*` tools return "tool not found"**
Check `.claude/settings.local.json` has `"collab"` in `enabledMcpjsonServers`. Then check `.mcp.json` has the `collab` server entry pointing at this package.

**`npm run dev` fails with "no such table"**
DB never migrated. Run `npm run migrate`.

**FTS search returns empty for words you can see in the DB**
Run `collab_doctor` — the FTS-parity check will flag if triggers are out of sync. Re-running `npm run migrate` will not fix this (triggers fire on insert). Easiest repair: `npm run dev` while a separate process re-INSERTs the orphan rows, or `DROP/CREATE` the FTS virtual table (write a 0002 migration if this ever happens).

**Codex dispatch saves nothing**
Check `~/.codex/logs/` for the dispatch's JSONL — if empty, codex itself failed (not the parser). If JSONL is there but nothing in DB, run `parse-codex-output.ts --input <file>` manually to see parser stderr.

**Hook didn't fire on session start**
`bash` on Windows is from Git for Windows — make sure it's on PATH. The hook commands in `.claude/settings.local.json` use `bash "$CLAUDE_PROJECT_DIR/..."` form.

---

## What's next (Phase 2 candidates — don't build yet)

Phase 1 is intentionally a stopping point. DESIGN.md does not define Phase 2; it should be driven by real friction during dogfooding. Likely candidates if/when they hurt:

- `collab_task_list` with filters (status, assignee, module)
- Auto-rollup on `task.transition('done')`
- Web/TUI viewer for read-only browsing
- BM25 ranking adjustments once corpus is real
- Cross-module weekly rollup

Use it for a few weeks first, then look at what was painful.

---

## Migration history

- **2026-04-25:** Phase 1 archival. Legacy `.claude/collab/*.md` and `.claude/codex-tasks/*.md` removed. Two substantive handoffs (CR-004, Step 9) and the T-STEP8 task spec exemplar were ingested as entries `E-7`, `E-8`, `E-9`. The 11 BOARD tasks (all `review` status, work shipped) were not migrated — the work is done and was unlikely to be queried again. Backup tarball: `~/.claude-archives/frontend2-collab-cleanup-20260425.tar.gz`.
- **2026-04-22:** Code moved from `.claude/mcp/collab/` to `internal-tools/collab-mcp/`.
