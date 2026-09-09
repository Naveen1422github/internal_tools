# Collab MCP

SQLite-backed collaboration store for Claude + Codex + Gemini (+ Antigravity). Tasks, handoffs, reviews, decisions, gotchas, and module state — all queryable via MCP tools or `/collab-*` slash commands.

**Status:** Phase 1 complete + knowledge-model redesign shipped (migration `0004`), then extracted to a hexagonal `@collab-mcp/core` + thin adapters. Ready for daily use. This README is the current source of truth; **[DESIGN.md](./DESIGN.md)** is the original v0.1 rationale (historical — the implemented schema/tools have since diverged).

---

## Quick start

### One-time setup (already done in this repo)

```bash
cd internal-tools/mcp
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

Canonical bodies live at `internal-tools/mcp/claude/commands/*.md`. The `.claude/commands/collab-*.md` files are tiny redirects so the source of truth stays inside this package.

---

## MCP tools (full surface)

All exposed as `mcp__collab__<name>`. 18 tools across 6 areas:

**Read**
- `collab_search { q?, type?, category?, module?, agent?, since?, limit? }` — FTS5 full-text + filters. `category` filter (Index|Reference|Activity) is new. Module filter is multi-module aware (via `entry_modules`). Returns summaries; pull bodies via `collab_get`.
- `collab_get { id }` — full body + refs + category + modules[] + superseded_by for one entry.
- `collab_list_recent { module?, type?, category?, agent?, limit? }` — newest-first list of summaries. Same category/module semantics as search.

**Write — entries**
- `collab_add { type, title, summary, description?, agent?, module?, modules?[], category?, task_id?, refs?, status? }` — append a `handoff | review | proposal | counter | decision | gotcha | session-note | changelog`. **Cannot create `rollup` here** — use `collab_rollup`. `category` defaults from type (decision/gotcha→Reference, else→Activity); set `Index` explicitly for navigation hubs. `module` is the primary module (back-compat); `modules` adds many-to-many links via `entry_modules`.
- `collab_update { id, title?, summary?, description? }` — **NEW.** Edit an existing entry's title/summary/description in place. FTS + `updated_at` stay consistent via triggers. Use to correct/clarify durable entries (decisions, gotchas), not to churn.
- `collab_ingest { source, raw_text, context? }` — read-only parser; returns `{draft_entry, confidence}`. Caller reviews, then calls `collab_add` to persist. Used by `/collab-handoff` and the Codex dispatch script.

**Write — lifecycle**
- `collab_supersede { ids, by }` — **NEW.** Mark old entries as replaced by a newer one. Sets `superseded_by = by` AND `deprecated = 1` on each id. Originals drop out of default retrieval but remain as history. Validation: `by` must exist and must not appear in `ids`; every id must exist.
- `collab_archive { older_than?, types?[], module?, agent?, dry_run? }` — **NEW.** Category-aware cleanup that deprecates stale **Activity** entries older than a cutoff (default `30d`), leaving a rollup breadcrumb per module. Index and Reference entries are **never** in scope. Protected types (decision, gotcha, rollup, proposal, counter) are also hard-excluded in SQL as belt-and-suspenders. `dry_run` defaults **true** — preview before committing.

**Write — tasks**
- `collab_task_create { title, summary, ... }` — IDs are auto-generated (e.g. `T-001`).
- `collab_task_transition { id, status }` — `pending → assigned → in-progress → review → done`.
- `collab_task_assign { id, assignee }` — `Claude | Codex | Gemini | User`.
- `collab_task_get { id }` — task row + linked entry summaries.

**Write — modules**
- `collab_module_init { slug, name?, summary?, current_goal?, description? }` — idempotent on slug.
- `collab_module_get { slug }` — module card: active_tasks, indexes, top_gotchas, recent_decisions, recent_handoffs. Multi-module aware via `entry_modules`.

**System**
- `collab_rollup { task_id? | (since + group_by), dry_run? }` — concatenates entries into a `rollup` entry; deprecates originals atomically per group. No LLM synthesis — rollups are deterministic by design.
- `collab_export { format: "json" | "markdown", filter? }` — returns `{format, entry_count, body}`. Caller writes to disk.
- `collab_doctor` — runs health checks (schema, data integrity, FTS parity). Returns `{ok, checks[]}`.
- `collab_savings_report { since?, group_by?, agent? }` — aggregates the dispatches table to show tokens displaced from Claude's window by sending work to Codex/Gemini.

---

## Codex / Antigravity dispatch (shell)

Send tasks to Codex or Antigravity from any terminal, results auto-persist to `collab.db`:

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

### Antigravity (`agy`)

**agy** is the Antigravity (Gemini) CLI, used as a dispatched collaborator in the same role Codex fills. When Claude or the user dispatches work to agy, results are logged as entries with `agent='Gemini'` and the title prefixed with `(via agy)` so they're easy to filter. In practice agy is interchangeable with Codex for dispatch purposes — the collaboration protocol treats both as external agents whose output flows through `collab_ingest` → `collab_add`.

---

## File map

Since the hexagonal refactor, **all tool logic lives in `@collab-mcp/core`** (`core/src/ops/`);
this `mcp/` package is a thin stdio adapter that imports core and registers the tools.

```
internal-tools/
├── core/                      ← @collab-mcp/core — domain logic (shared by mcp + server)
│   └── src/
│       ├── db.ts              ← better-sqlite3 connection + migration runner
│       ├── constants.ts, validate.ts, index.ts
│       └── ops/               ← one file per operation (the real implementations):
│           ├── search.ts      ← collab_search (FTS5 + category/module filters)
│           ├── get.ts         ← collab_get
│           ├── list-recent.ts ← collab_list_recent
│           ├── add.ts         ← collab_add (category derivation, entry_modules writes)
│           ├── update.ts      ← collab_update (in-place title/summary/description edits)
│           ├── ingest.ts      ← collab_ingest
│           ├── supersede.ts   ← collab_supersede (superseded_by + deprecated)
│           ├── task.ts        ← collab_task_create/transition/assign/get
│           ├── module.ts      ← collab_module_init/get (multi-module aware)
│           ├── rollup.ts      ← collab_rollup + collab_archive
│           ├── export.ts      ← collab_export
│           ├── doctor.ts      ← collab_doctor
│           └── savings.ts     ← collab_savings_report
└── mcp/                       ← @collab-mcp/mcp — this package
    ├── DESIGN.md              ← original v0.1 design doc (historical; see banner inside)
    ├── README.md              ← this file (current source of truth)
    ├── collab.db              ← SQLite store (gitignored)
    ├── migrations/
    │   ├── 0001_init.sql                          ← base schema, indexes, FTS5 triggers, CHECKs
    │   ├── 0002_dispatches.sql                    ← dispatches table
    │   ├── 0002_fix_modules_slug_check.sql        ← slug validation fix
    │   ├── 0003_dispatches_updated_at.sql         ← add updated_at to dispatches
    │   └── 0004_categories_modules_supersede.sql  ← category, entry_modules, superseded_by
    └── src/
        ├── server.ts          ← MCP stdio entry (18 registerTool calls over core ops)
        ├── migrate.ts         ← migration CLI
        └── scripts/
            ├── seed.ts            ← idempotent test data
            ├── manual-search.ts   ← MCP-less smoke test
            ├── module-card.ts     ← used by SessionStart hook
            ├── check-handoff-needed.ts  ← used by Stop hook
            └── parse-codex-output.ts    ← Codex/agy JSONL → collab_add
    └── claude/commands/        ← canonical slash command bodies
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

## Data model (current — post migration 0004)

The schema has evolved since Phase 1. Key concepts:

### Category (lifecycle axis)

Every entry has a `category` column: **Index**, **Reference**, or **Activity**.

| Category | Purpose | Archive-eligible? |
|---|---|---|
| **Index** | Navigation hubs surfaced first (e.g. "READ FIRST" TOCs). Set explicitly on `collab_add`. | Never |
| **Reference** | Durable truth — decisions, gotchas, canonical knowledge. Auto-derived for `decision`/`gotcha` types. | Never |
| **Activity** | Work trail — handoffs, reviews, session-notes, changelogs, proposals, counters, rollups. Default for most types. | Yes (`collab_archive`) |

`type` (handoff, review, decision, …) is now **content-shape only**. `category` drives lifecycle and retrieval: Index/Reference entries are protected from archival; Activity entries age out.

### Many-to-many modules (`entry_modules`)

Entries can belong to multiple modules via the `entry_modules` junction table. `entries.module` is kept as the **primary** module for back-compat; `entry_modules` is the source of truth for multi-module reads. `collab_add` accepts both `module` (primary) and `modules[]` (additional).

### Supersession (`superseded_by`)

Entries have a `superseded_by` integer column (soft FK to another entry). When set via `collab_supersede`, the entry is also marked `deprecated = 1`, dropping it from default retrieval while preserving history.

### Agents

| Agent value | Who |
|---|---|
| `Claude` | Claude Code (primary agent) |
| `Codex` | OpenAI Codex (dispatched via `codex-dispatch.sh`) |
| `Gemini` | Gemini / Antigravity (`agy`). Results from agy dispatches are logged with `agent='Gemini'` and titles prefixed `(via agy)`. |
| `User` | Human (Naveen) |

---

## What's next (Phase 2 candidates — don't build yet)

Phase 1 + the knowledge-model redesign (0004) are the current stopping point. Further work should be driven by real friction. Likely candidates if/when they hurt:

- `collab_task_list` with filters (status, assignee, module)
- Auto-rollup on `task.transition('done')`
- Web/TUI viewer for read-only browsing
- BM25 ranking adjustments once corpus is real
- Cross-module weekly rollup
- `entry_modules`-aware archive scoping (currently scopes on `entries.module`)

Use it for a few weeks first, then look at what was painful.

---

## Migration history

- **2026-06-12:** Migration `0004_categories_modules_supersede` — knowledge-model redesign (decision E-00163). Adds `category` (Index/Reference/Activity), `superseded_by`, and the `entry_modules` junction table. Backfills existing data. See the **Data model (current)** section above for details.
- **2026-04-25:** Phase 1 archival. Legacy `.claude/collab/*.md` and `.claude/codex-tasks/*.md` removed. Two substantive handoffs (CR-004, Step 9) and the T-STEP8 task spec exemplar were ingested as entries `E-7`, `E-8`, `E-9`. The 11 BOARD tasks (all `review` status, work shipped) were not migrated — the work is done and was unlikely to be queried again. Backup tarball: `~/.claude-archives/frontend2-collab-cleanup-20260425.tar.gz`.
- **2026-04-22:** Code moved from `.claude/mcp/collab/` to `internal-tools/collab-mcp/`.
- **2026-06-14:** Package moved from `internal-tools/collab-mcp/` to `internal-tools/mcp/` as part of the internal-tools reorganization.
