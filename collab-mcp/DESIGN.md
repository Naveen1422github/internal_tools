# Collab v2 — SQLite + FTS5 + MCP Tools

> **Status:** Draft v0.1 (2026-04-17) — design doc, no code yet
> **Author:** Naveen + Claude
> **Audience:** Naveen (single-dev today); future devs on this repo
> **Purpose:** Replace today's file-heavy collab system (`.claude/collab/*.md`, `.claude/codex-tasks/*.md`, `.claude/<module>/SESSION-NOTES.md`) with a structured DB + MCP tool surface so AI agents only pay tokens for what they actually need.

---

## 1. Why we're doing this

Today every agent session pays full token cost to orient itself:

| File | Lines | ~Tokens | Read frequency |
|---|---|---|---|
| `.claude/collab/HANDOFFS.md` | 257 | ~2,000 | Every handoff |
| `.claude/collab/BOARD.md` | 125 | ~1,000 | Every task pickup |
| `.claude/collab/PROTOCOL.md` | 75 | ~600 | Every write |
| `.claude/codex-tasks/STATE.md` | 113 | ~1,500 | Every module session |
| `.claude/codex-tasks/CR-00x.md` | ~100 each | ~1,200 each | Task-specific |

All of them load fully even when the agent needs one line. The real cost isn't storage — it's that **addressing** (where is it?) and **retrieval** (what does it say?) share the same blob. Splitting those two is where the token savings come from.

## 2. Goals / Non-Goals

**Goals**
- Agents read summaries first, pull full bodies deliberately
- Retrieval is filter-first (module, task, type, time, status), search second
- All writes go through a schema — no free-form markdown the agent has to validate
- STATE.md-style module context becomes a cheap, composable query
- System survives without AI doing bookkeeping (status transitions, module tagging, handoff drafting)

**Non-Goals (for phase 1)**
- Team collaboration across machines (single-dev only; JSONL export is the exit door)
- Auto-rollup / LLM-driven compaction (manual rollup only)
- Ingesting `.claude/knowledge/` or domain docs (those stay as files)
- Replacing the dispatch shell scripts themselves (they stay; just their output flows into the DB)

## 3. Decisions locked

| Area | Decision | Rationale |
|---|---|---|
| Stack | Node/TS in `internal-tools/collab-mcp/`, `better-sqlite3` + FTS5 | Matches repo stack; versioned with code |
| Phase 1 scope | collab entries + codex-tasks + session notes + modules | Highest token pain; knowledge/ stays as files |
| Team model | Single-dev, local `collab.db` (gitignored) + JSONL export hook | Clean exit door if multi-dev comes later |
| Rollup | Manual only (`collab rollup <task>`) | No surprise compaction; deterministic |
| Retrieval default | Summaries-first, auto-expand iff `count ≤ 3 AND sum(tokens_estimate) ≤ 1500` | Cheap list lookups, safe auto-fetch |
| Modules | First-class table, populated lazily via `collab.module.init` | Each module has wiring + decisions that deserve a queryable primitive |
| Entry kinds | `signal` (handoffs, reviews, decisions, gotchas) vs `log` (session-notes, changelog) | Search defaults to signal; log requires opt-in |
| Entry IDs | Integer auto-increment. Display-formatted as `E-00042` in CLI, raw int over the wire | Simpler than prefix; avoids ID generation races |
| `refs.ref_value` for files | Repo-relative path (e.g. `src/controllers/reportController.ts`) | Portable across machines; shorter |
| Orchestrator | = the human user (Naveen). A role label, not a separate actor | Pulled from PROTOCOL.md heritage; documented here for clarity |

## 4. Data model

### Tables

```sql
-- Mutable task state. Replaces BOARD.md.
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,         -- "T-001"
  title        TEXT NOT NULL,
  summary      TEXT,                     -- <= 200 chars, one-liner
  description  TEXT,                     -- full body (markdown)
  status       TEXT NOT NULL,            -- pending | assigned | in-progress | review | done
  assignee     TEXT,                     -- 'Claude' | 'Codex' | NULL
  priority     TEXT,                     -- critical | high | medium | low
  module       TEXT,                     -- soft FK to modules.slug
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_status   ON tasks(status);
CREATE INDEX idx_tasks_module   ON tasks(module);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);

-- Append-only. Handoffs, reviews, proposals, decisions, gotchas, session notes, changelog, rollups.
CREATE TABLE entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL,        -- handoff|review|proposal|counter|decision|gotcha|session-note|changelog|rollup
  kind             TEXT NOT NULL,        -- signal | log
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,        -- <= 200 chars
  description      TEXT,                 -- full body, lazy-loaded
  status           TEXT NOT NULL DEFAULT 'active',  -- draft | active | resolved | deprecated
  agent            TEXT,                 -- 'Claude' | 'Codex' | 'User'
  module           TEXT,                 -- soft FK to modules.slug
  task_id          TEXT,                 -- soft FK to tasks.id
  tokens_estimate  INTEGER DEFAULT 0,    -- ceil(len(description)/4), computed on write
  rollup_of_task   TEXT,                 -- if this is a rollup entry, the task id whose entries it summarizes
  deprecated       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_entries_type      ON entries(type);
CREATE INDEX idx_entries_module    ON entries(module);
CREATE INDEX idx_entries_task      ON entries(task_id);
CREATE INDEX idx_entries_created   ON entries(created_at);
CREATE INDEX idx_entries_kind      ON entries(kind);

-- FTS over title + summary + description.
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, summary, description,
  content='entries', content_rowid='id',
  tokenize='porter unicode61'
);
-- Triggers to keep FTS in sync with entries (AFTER INSERT/UPDATE/DELETE).

-- Many-to-many links. An entry can reference files, tasks, other entries.
CREATE TABLE refs (
  entry_id    INTEGER NOT NULL,
  ref_type    TEXT NOT NULL,             -- file | task | entry | url
  ref_value   TEXT NOT NULL,             -- file: repo-relative path | task: T-id | entry: int id | url: full url
  PRIMARY KEY (entry_id, ref_type, ref_value)
);
CREATE INDEX idx_refs_value ON refs(ref_value);

-- Module-level context. Lazy-populated.
CREATE TABLE modules (
  slug           TEXT PRIMARY KEY,       -- "timesheet", "custom-reports", "action-bar"
  name           TEXT,
  summary        TEXT,                   -- 1-line
  description    TEXT,                   -- paragraph
  current_goal   TEXT,                   -- what we're trying to do now
  status         TEXT DEFAULT 'active',  -- active | stable | deprecated
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

### Soft FKs, not hard

`entries.module`, `entries.task_id`, `tasks.module` are text columns without `FOREIGN KEY` constraints. Reason: the importer will run with partial data (entry mentions a module that doesn't exist yet in `modules`). Soft FKs let us write in any order; consistency is checked by CLI (`collab doctor`).

### `tokens_estimate` is cheap and worth it

Computed on every write as `ceil(char_length(description) / 4)`. This is what powers the "auto-expand only if sum ≤ 1500" rule without runtime cost. Off by ~15% from real tokenizers, fine for a budget cap.

## 5. Entry types

| Type | Kind | Lifespan | Purpose |
|---|---|---|---|
| `handoff` | signal | append-only | Context transfer between agents |
| `review` | signal | append-only | Code review on the other agent's work |
| `proposal` | signal | append-only | Approach suggestion |
| `counter` | signal | append-only | Critique / alternative to a proposal |
| `decision` | signal | append-only, persistent | Final call by Orchestrator |
| `gotcha` | signal | append-only, persistent | Warnings that never age (surfaced by `module.get`) |
| `rollup` | signal | append-only, system-generated | Summary of older resolved entries on a task; created by `collab.rollup` |
| `session-note` | log | append-only, noisy | Per-module dated notes |
| `changelog` | log | append-only | System changes to the collab infra itself |

Default searches return **signal** only. `--include-logs` opts in.

### Entry status lifecycle

| Status | Meaning | Set by |
|---|---|---|
| `draft` | Entry in progress, not yet visible to agents by default | Writer, via `collab.add({status: 'draft'})` |
| `active` | Default state on insert; live and searchable | System |
| `resolved` | Work it describes is complete; still searchable, but rollup-eligible | User or `collab.task.transition(task, 'done')` cascades handoffs/reviews of that task to `resolved` |
| `deprecated` | Superseded by a rollup or explicitly retired; excluded from search unless `include_deprecated=true` | `collab.rollup` |

Status columns are mutable on entries (unlike the body) — this is the one exception to the append-only rule.

### Task state machine

```
pending ─┬─► assigned ─► in-progress ─► review ─► done
         │                    ▲
         └── assign ──────────┘
                          rework
                  review ────────► in-progress
```

Legal transitions (enforced by `collab.task.transition`):

- `pending → assigned` (on assign)
- `assigned → in-progress` (on pickup)
- `pending → in-progress` (self-pickup without explicit assign)
- `in-progress → review` (work complete, awaiting review)
- `review → in-progress` (rework requested)
- `review → done` (Orchestrator only)
- `* → pending` (reset, Orchestrator only)

When a task transitions to `done`, the server cascades `status='resolved'` to all `active` handoffs and reviews linked to it. Nothing else cascades.

## 6. Tool surface (MCP)

Named like a flat namespace so LLMs can pick them easily.

### Read

```
collab.search(query, {module?, task?, type?, kind?='signal', since?, status?, include_deprecated=false, limit=10})
  -> [{id, type, title, summary, score, tokens_estimate}]
  # FTS5 bm25 over title+summary+description, filters applied first.
  # Default kind='signal' — log entries (session-notes, changelog) hidden unless kind='log' or kind='any'.
  # Default include_deprecated=false — rolled-up originals hidden unless opted in.

collab.get(id)
  -> {id, type, title, summary, description, refs[], agent, module, task_id, created_at, ...}
  # The one expensive call. Returns full body.

collab.list_recent({type?, module?, task?, since='7d', limit=10, include_logs=false, include_deprecated=false})
  -> [{id, type, title, summary, created_at}]

collab.module.get(slug)
  -> {
       module: {slug, name, summary, description, current_goal, status},
       active_tasks:     [{id, title, status, priority}],
       recent_decisions: [{id, title, summary}],
       top_gotchas:      [{id, summary}],
       recent_handoffs:  [{id, title, summary, agent, created_at}]  // last 3
     }
  # Returns null module if slug unknown, with suggestion to call collab.module.init.

collab.task.get(id)
  -> {task: {...}, recent_entries: [{id, type, title, summary}]}
```

### Write

```
collab.add({type, title, summary, description?, status?, agent, module?, task_id?, refs?[]})
  -> {id}
  # Validates type/kind, computes tokens_estimate, inserts refs.

collab.task.create({title, summary, description?, priority?, module?, assignee?})
  -> {id: "T-NNN"}  # auto-increments.

collab.task.transition(id, status)
  -> {id, status}  # enforces valid state machine.

collab.task.assign(id, agent)
  -> {id, assignee}

collab.module.init({slug, name?, summary?, description?, current_goal?})
  -> {slug}

collab.module.update(slug, patch)
  -> {slug}

collab.link(entry_id, ref_type, ref_value)
  -> ok

collab.ingest({source, raw_text, context?})
  -> {draft_entry: {type, title, summary, description, module?, task_id?, refs[]}, confidence}
  # Does NOT save. Returns a proposed entry for user/Claude to approve, then add.
```

### Admin

```
collab.rollup(task_id)
  -> {rollup_entry_id, deprecated_ids: []}
  # Manual. Generates one rollup entry from resolved entries of a task; marks originals deprecated.

collab.export({since?, format='jsonl'})
  -> {path}
  # Dumps to internal-tools/collab-mcp/export/*.jsonl — the "multi-dev exit door".

collab.doctor()
  -> {orphaned_tasks: [], unknown_modules: [], fts_drift: false, ...}
```

## 7. Retrieval strategy (the thing that saves tokens)

### Default flow for "what's going on with T-001?"

1. Agent calls `collab.task.get("T-001")` → gets task row + ~3 recent entry summaries. ~400 tokens.
2. Agent reads summaries, decides which matters. If any body is needed → `collab.get(id)`. ~1-2K tokens *per selected entry*.
3. Total: ~500-2500 tokens vs today's 2000+ for a full BOARD.md + HANDOFFS.md pull.

### Smart auto-expand rule

When `collab.search` or `collab.list_recent` returns results, the server auto-expands descriptions iff:

```
result_count <= 3  AND  sum(tokens_estimate for all results) <= 1500
```

Both conditions must hold. This prevents worst-case (3 huge entries = 6K tokens auto-loaded). Configurable via `COLLAB_AUTOEXPAND_MAX_TOKENS` env var.

### Filter-before-search

Every read tool takes filters. Agents are nudged to filter first via tool descriptions:

> "Prefer filters (module, task, since) over broad queries. Search returns summaries; call `collab.get(id)` to read the full description deliberately."

## 8. Write path & ingest flow

### Direct writes (Claude)

Claude calls tools directly. The tool validates type/kind, computes `tokens_estimate`, inserts into `entries` + `refs`, updates `entries_fts` via trigger.

### Indirect writes (Codex)

Codex doesn't speak MCP. The existing `codex-dispatch.sh` stays as the bridge, modified to:

1. Run Codex as today
2. Capture JSONL output + list of changed files from git
3. Pass both to a parser (`parse-codex-output.ts`) which emits a draft entry JSON
4. Call `collab.ingest` with the draft
5. Either auto-add (with `--auto`) or print the draft for human approval

The parser is the single point where quality matters. It extracts:
- Last assistant message → `description`
- First line of description → `title` (truncated)
- Auto-generated summary (first sentence or ~150-char truncate)
- Changed files → `refs[]`
- Task ID from dispatch args → `task_id`

### User writes (CLI)

```
collab task create "Add share toggle" --module custom-reports --priority high
collab task transition T-001 review
collab task done T-001
collab handoff --task T-001 --file HANDOFF.md
collab gotcha "Attendance uses STRING employeeId" --module timesheet
collab rollup T-001
```

## 9. Migration plan

One-shot importer (`scripts/migrate-from-markdown.ts`) converts existing files into rows. Runs once, idempotent (checks DB emptiness first).

### Source → target mapping

| Source | Target |
|---|---|
| `.claude/collab/BOARD.md` `### T-NNN` blocks | `tasks` rows |
| `.claude/collab/HANDOFFS.md` `### [HANDOFF]` blocks | `entries` type=handoff |
| `.claude/collab/REVIEWS.md` `### [REVIEW]` blocks | `entries` type=review |
| `.claude/collab/PROPOSALS.md` `### [PROPOSAL|COUNTER|DECISION]` blocks | `entries` type=proposal|counter|decision |
| `.claude/collab/CHANGELOG.md` `### [CHANGELOG]` blocks | `entries` type=changelog kind=log |
| `.claude/codex-tasks/CR-*.md` | `tasks` rows + `entries` type=handoff for body |
| `.claude/codex-tasks/STATE.md` (per-module) | `modules` row (one per file) |
| `.claude/<module>/SESSION-NOTES.md` entries | `entries` type=session-note kind=log module=<module> |

### Parsing rules

- Entry boundaries: `^---$` on its own line
- Header regex: `^### \[([A-Z-]+)\]\s+(.+)$`
- Metadata fields: `^- \*\*([^:]+):\*\*\s+(.+)$`
- Body: everything between metadata and next `---`
- Refs field is split on `,` and classified by heuristics (contains `/` = file, matches `T-\d+` = task, else url/entry)

### Post-migration

Move old `.md` files to `.claude/collab/_archive/YYYY-MM-DD/` — don't delete. Leaves a rollback path for a week.

## 10. Session lifecycle (phase 4 sketch)

Slash commands that wrap common flows:

```
/collab-start <module>       # calls collab.module.get(module); loads module card + recent
/collab-pickup T-001         # calls collab.task.get + transitions to in-progress
/collab-handoff              # drafts a handoff from recent git diff + last task; asks to confirm
/collab-review <pr|branch>   # dispatches codex-review.sh, ingests result
/collab-dispatch "task"      # wraps codex-dispatch.sh, ingests handoff
/collab-done T-001           # task.transition + suggests rollup if >14d old
```

**End-of-session auto-handoff** (hook): when Claude's session closes, a post-session hook asks "summarize what changed in this session" and offers to add it as a handoff. Avoids the "I forgot to write a handoff" problem.

## 11. Rollup (manual, phase 1)

`collab rollup T-001`:

1. Find entries where `task_id='T-001' AND status='resolved' AND created_at < today - 14d AND deprecated=0 AND type != 'rollup'`
2. If <2 entries → noop
3. Concatenate their summaries (with entry id + date per line), write one new entry of `type=rollup, kind=signal, status=active, rollup_of_task='T-001'`
4. Mark originals `deprecated=1`
5. Originals stay searchable with `include_deprecated=true`
6. Rollups are never themselves rolled up (filter in step 1 excludes `type='rollup'`)

No LLM call. Deterministic. Good enough until it isn't.

## 12. Shared vs independent

Single-dev is assumed for phase 1. DB lives at `internal-tools/collab-mcp/collab.db` (gitignored). Every ~N writes, a JSONL export lands at `internal-tools/collab-mcp/export/collab-YYYY-MM-DD.jsonl`. That file is the exit door — if multi-dev becomes real, import it into a hosted sqlite later.

`collab.export --since=2026-04-15 --format=jsonl` can be run ad-hoc.

## 13. Open questions (still to decide)

1. ~~Entry ID format~~ — **resolved:** integer auto-increment, formatted as `E-00042` for display
2. **Soft delete vs hard delete** — deprecated entries are hidden by default (`include_deprecated=false`), not stripped. Keep forever, or purge after N rollups?
3. ~~`refs.ref_value` for files~~ — **resolved:** repo-relative paths
4. **Module slug rules** — free text, normalized to kebab-case, validated on insert. Max length? Reject reserved words?
5. **Multi-agent writes** — SQLite WAL mode handles concurrent writes. But should `ingest` write atomically with the Codex run, or post-hoc (review-then-add)? Leaning post-hoc for safety.
6. **Schema migrations** — numbered `.sql` files + `schema_migrations` table. Resolved pattern; first migration `0001_init.sql` in phase 2.
7. **"Top gotchas" ranking** — by recency? A future `pinned` column? Punt: default to recency, revisit after use.

## 14. Out of scope / deferred

- `.claude/knowledge/` ingestion (stays as files; revisit after phase 1 proves out)
- Auto-rollup triggers (time/count-based)
- Team-hosted DB (Turso, litestream, etc.)
- Vector embeddings for semantic search (FTS5 bm25 is enough at current scale — revisit at ~10K entries)
- UI / dashboard (CLI + agent tools only)
- Replacing dispatch scripts with pure MCP (Codex bridge stays shell-based)

## 15. Build order

1. **This doc locked** → any blocker here is a re-design problem, cheap to fix on paper
2. **Schema + migrations** → `internal-tools/collab-mcp/migrations/0001_init.sql`
3. **Tool stub + better-sqlite3 wiring** → minimum viable `collab.search`, `collab.get`, `collab.add`
4. **Importer** → one-shot migration of existing `.md` files; run against a copy first
5. **Remaining read tools** → `list_recent`, `task.get`, `module.get`
6. **Remaining write tools** → `task.*`, `module.*`, `ingest`
7. **Dispatch parser** → `parse-codex-output.ts` + `collab.ingest` wiring
8. **Rollup + export + doctor**
9. **Slash commands + session hooks**

---

## Appendix A — example token math

### Today: agent picks up T-001 on custom-reports

- Reads `BOARD.md` (1000 tok) + `HANDOFFS.md` (2000 tok) + `STATE.md` (1500 tok) = **~4500 tokens**
- 90% of that content isn't about T-001

### After: same scenario

- `collab.task.get("T-001")` → ~400 tok (task row + 3 entry summaries)
- `collab.module.get("custom-reports")` → ~600 tok (module card + top gotchas + active tasks)
- `collab.get(<id of key handoff>)` → ~800 tok
- **Total: ~1800 tokens** — all relevant

Savings: ~60% per session pickup, plus the content agents see is on-topic.

### Today: broad question "what did Codex do this week?"

- Read full `HANDOFFS.md` (2000 tok), scan by hand

### After

- `collab.list_recent({agent: 'Codex', since: '7d', limit: 10})` → ~800 tok (10 summaries)
- If something interesting → `collab.get(id)` for specific entries

Savings: ~60% on the default case, and the agent can follow up precisely.

---

## Appendix B — non-goals I want to call out explicitly

- **Not a project manager.** Tasks are lightweight. Priority/assignee/status are enough. No sprints, estimates, dependencies.
- **Not a wiki.** Knowledge docs stay as markdown files; DB indexes on demand if ever.
- **Not a universal memory.** Scoped to collab-adjacent context (handoffs, reviews, decisions, tasks, module state, session notes). Chat history, personal notes, etc. stay elsewhere.
- **Not a replacement for git.** Code changes still flow through git; `refs` point to file paths but don't store diffs.

---

*End of design v0.1. Markup welcome — the doc is the source of truth until code lands.*
