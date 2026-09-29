# Collab Migration 0006 (ULID contract phase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Collab logging (every executor, every task):** add a `session-note` to module `collab-mcp` when you start, a `changelog` when you finish (files touched + test counts), and a `gotcha` if you are blocked. Never `git add` / `commit` / `stash` / `reset`. The user commits.

**Goal:** Make the ULID the real identity of every collab entry. `entries.ulid` becomes the primary key, the E-number (`id`) becomes a nullable label, links and module memberships are keyed by ULID, deletes become tombstones, and every synced table passes cr-sqlite's `crsql_as_crr`. Nothing that works today on the live 0005 DB may break before go-live.

**Architecture:** This is the *contract* half of the expand/contract pair that 0005 started. It has three layers:
1. A staged SQL migration (`0006_ulid_contract.sql`) that rebuilds five tables.
2. A JS pre-flight hook that validates and repairs data *before* the rebuild. If it finds bad data, the migration stops with nothing changed.
3. A code layer where every write and read goes through small schema-aware helpers (`core/src/schema.ts`, `core/src/entry-write.ts`). The same build therefore runs correctly on the live 0005 DB now and on 0006 after go-live.

**Tech Stack:** TypeScript 5.3, better-sqlite3 (bundled SQLite 3.53), node:test via `tsx --test`. No new runtime dependencies. cr-sqlite v0.16.3 is used only by the rehearsal script, loaded from a path in `CRSQLITE_PATH`, and is never a package dependency (its npm postinstall is broken on Node 22).

**Spec:** collab **E-687** (0006 scope), **E-685** (pre-flight checklist from the 0005 final review, items 1–9), **E-689** (never silently create an empty DB), **E-684** (trigger firing order / FTS rule), **E-674** (performance targets: 10k entries, search < 100 ms), **E-648** (E-number is a label, the allocator comes later), **E-651** (links keyed `(entry_ulid, ref_type, ref_value)`).

## Spike results (2026-09-29, on a VACUUM INTO copy of the live DB; live DB opened read-only)

The SQL in Task 2 was run as-is against a copy of `mcp/collab.db` (684 entries, 2127 refs, 792 module rows):
- Migration took 68 ms. Row counts before and after were identical. The counter was seeded to 689 (`max(sqlite_sequence=689, max(id)=689)`).
- FTS `integrity-check` passed, both straight after the migration and after the E-684 NULL→text edit.
- `UPDATE entries SET ulid = …` is refused ("entries.ulid is immutable").
- **`crsql_as_crr` succeeded on `entries`, `refs`, `entry_modules`, `entry_revisions`, `tasks` and `modules`** (cr-sqlite v0.16.3 win-x86_64). The FTS triggers still worked after the conversion.
- At **10,084 entries**, measured without cr-sqlite / with cr-sqlite:

  | Operation | Without cr-sqlite | With cr-sqlite |
  |---|---|---|
  | Edit (avg) | 19 ms | 32 ms |
  | FTS search (avg) | 42 ms | 46 ms |

  E-674's target is search under 100 ms.
- Finding for later: once a DB has been turned into a CRR, **any connection that has not loaded the extension can no longer write to it** (`no such function: crsql_internal_sync_bit`). That matters for the relay plan, not for 0006, which never calls `crsql_as_crr` on the live DB.

## Decisions baked into this plan (confirm at review)

| # | Decision | Default in this plan | Why |
|---|---|---|---|
| D1 | Primary key | `entries.ulid TEXT NOT NULL PRIMARY KEY CHECK(length(ulid)=26)`. The table keeps SQLite's hidden rowid (it is not a `WITHOUT ROWID` table). | cr-sqlite needs a NOT NULL PK (the spike shows OK). Keeping the rowid keeps the FTS and the planner simple. |
| D2 | E-number | `id INTEGER`, nullable, plain (non-unique) index. New numbers come from `local_counters('entry_number')`, seeded to `max(sqlite_sequence.seq, max(id))` and always kept ≥ `max(id)`. | E-648: an entry may exist before it has a number. The central allocator later replaces `nextEntryNumber()`. Seeding from `seq` means deleted numbers are never reused. |
| D3 | Old `entry_id` in `refs` / `entry_modules` | Kept as a **nullable, write-only label**. Writers fill it and **nothing reads it**. A later contract step drops it. | Writers can then use the same column list on 0005 and 0006, where `entry_id` is still NOT NULL on 0005. That removes a branch from every writer. |
| D4 | FTS | Its own copy of the text: `fts5(ulid UNINDEXED, title, summary, description)`, deletes done by `ulid`. | VACUUM can renumber hidden rowids now that `id` is not the INTEGER PK. The spike measured 19–32 ms per edit at 10k rows, within budget. |
| D5a | Deletes | `deleted_at` tombstone. The app never hard-deletes an entry after 0006; `DELETE` stays legal for scripts and synced deletes, and cascades by ulid. Tombstoned rows stay in FTS, and every list or search query filters them out through one helper. | Sync needs the delete to travel as data. One helper means one test covers every list. |
| **D5b** | **Can you still open a deleted entry by its number?** | **Yes.** `getEntry` returns it with `deleted_at` set. It is hidden from search, lists, module cards, exports, stats and rollups. | Old links (`E-214`) keep showing what they pointed at, like a deleted file in git history. **User to confirm; the alternative is "gone everywhere".** |
| D6 | `dispatches` table | Not rebuilt. | Local telemetry. It never syncs, and its AUTOINCREMENT key keeps `sqlite_sequence` alive. |
| D7 | Author backfill (E-685 #7) | Moved into the one-time pre-flight. After 0006, the startup backfill **never** stamps `author`. | A synced row with a NULL author must not be claimed by whichever machine happens to start next. |
| D8 | ULID changes | A BEFORE UPDATE trigger aborts any change to `entries.ulid`. | refs, module rows, FTS, revisions and sync all hang off it. |
| **D9** | **Creating a new database (E-689)** | `getDb()` refuses to open a path that does not exist, unless `create: true` is passed or `COLLAB_DB_CREATE=1` is set. The init command is `npm --prefix mcp run migrate`. Every open prints one stderr line with the path it resolved. | A typo'd path or a load-order bug must never look like "all my entries are gone". **User to confirm: this adds one setup step for people installing the bundle.** |
| D10 | Doctor's 144 "orphan entry refs" | These are false positives. `CAST('E-214' AS INTEGER)` is 0, so every `E-`/`#` link looked orphaned. Rebased on `parseEntryRef`. | `data.unresolved_entry_refs: ok` already proved the real count is 0. |
| D11 | Oldest schema the read paths must handle | Read paths may assume **≥ 0005**, because `migrate()` runs before any read in both servers. Write paths keep the existing `hasUlidColumns` pre-0005 guard. | Keeps the dual-level matrix to 0005 × 0006. |

## Global Constraints

- **Never run `npm run build`, the root `npm test`, or anything else that builds.** The root `test` script builds the server. Core tests run as targeted files: `cd internal-tools/core && npx tsx --test test/<file>.test.ts`. REST tests (Task 7) need `server/dist`, so **the user builds the server first**. After that, the subagent runs `cd internal-tools && npx tsx --test test/<file>.test.mts`.
- **Tests are run by a background subagent** that returns pass/fail counts plus each failure's name, assertion and file:line. Never paste raw output inline.
- **Never touch the git index.** No `git add`, `git commit`, `git stash` or `git reset` in any step. Each task ends with **"Checkpoint: user commits"**.
- **Precondition:** the user has committed the current `internal-tools` working tree on `collabv1`: the 0005 staged→released move and the `server/src/env.ts` fix (E-689). Execute in a **new worktree** `Downloads/dev/wt-collab-0006` on branch `collab-0006-contract` off `collabv1`, so that subagents never share the user's index.
- **0006 lives in `mcp/migrations/staged/` until go-live.** Every running server scans `mcp/migrations/` straight from source. Only tests and the rehearsal pass `includeStaged: true`.
- **Never open the live DB (`internal-tools/mcp/collab.db`) for writing** before the go-live runbook in Task 9. Rehearsals work on `VACUUM INTO` copies.
- **Every changed read or write is tested at BOTH 0005 and 0006** through `testAtEachLevel` (Task 3). The merged branch runs on the live 0005 DB until go-live.
- **No Turso anywhere.** Turso gets SupportHub data only (user rule).
- **E-684 rule:** `trg_entries_fts_au` watches exactly `title, summary, description`. Any test that touches FTS ends with `INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`.
- **cr-sqlite rules for the synced tables** (`entries`, `refs`, `entry_modules`, `entry_revisions`, `tasks`, `modules`): a NOT NULL primary key, a DEFAULT on every other NOT NULL column, no UNIQUE index besides the PK, and no checked foreign keys.
- The `summary` ≤ 200 CHECK and all existing CHECK lists are copied unchanged.

## Review Focus

1. **The merged branch on the live 0005 DB, before go-live.** Every write (`addEntry`, `rollup`, `archive`, `updateEntryRefs`, `supersede`, `deleteEntry`, the REST upsert) and every read must work at 0005 exactly as it does today. → `testAtEachLevel` in Tasks 3–7, plus the REST tests in Task 7, which run at both levels.
2. **A deleted (tombstoned) entry** must vanish from search, list_recent, module card, task card, export, REST stats, REST search and rollup/archive selection. It stays readable by `getEntry` (D5b), and links that point at it still resolve. → Task 5 test `a tombstoned entry disappears from every list`, and Task 7 test `delete tombstones and hides the entry`.
3. **Bad data at migration time** (a NULL ulid left by an unparseable `created_at`, two entries sharing a ulid, a malformed ulid, a ref whose owner is gone) must stop the migration with a list of the offending rows and **change nothing**. → Task 2 tests `preflight rejects duplicate and malformed ulids and changes nothing` and `preflight assigns a ulid to a row the backfill skipped`.
4. **E-number continuity.** The first entry added after go-live must get `max(seq, max(id)) + 1` (computed at go-live), never a reused number, even if the counter row was lost. → Task 3 tests `new entries continue the E-number sequence` and `counter self-heals and never falls behind max(id)`.
5. **FTS under edits and at scale.** A NULL→text edit must keep `integrity-check` passing (E-684). At 10k entries an edit must take < 100 ms and a search < 100 ms. → Task 2 tests `FTS own copy survives a NULL->text edit` and `perf at 10k entries`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `core/src/db.ts` | modify | `getDb` create guard + one-line path log (T1); injectable migration dirs (T1); before-migration hook (T2) |
| `mcp/migrations/staged/0006_ulid_contract.sql` | create | The rebuild (T2) |
| `core/src/preflight-0006.ts` | create | Validate/repair before the rebuild; one-time author stamp (T2) |
| `core/src/schema.ts` | create | `hasUlidPrimaryKey`, `liveEntry`, `ftsJoin` (T3) |
| `core/src/entry-write.ts` | create | `nextEntryNumber`, `insertEntryRow`, `insertRefs`, `insertEntryModules`, `ownerOf`, `deleteRef`, `replaceLinks` (T3) |
| `core/src/ops/add.ts`, `ops/rollup.ts` | modify | Inserts through `entry-write` (T3) |
| `core/src/ops/update.ts`, `ops/supersede.ts`, `backfill.ts` | modify | Keyed by ulid; author narrowed (T4) |
| `core/src/ops/delete.ts` | create | `deleteEntry`: tombstone at 0006, hard delete before (T4) |
| `core/src/ops/search.ts`, `get.ts`, `module.ts`, `task.ts`, `export.ts`, `rollup.ts` | modify | FTS join, membership by ulid, tombstone filter (T5) |
| `core/src/ops/doctor.ts` | modify | Level-aware sets, fixed orphan check, new checks (T6) |
| `server/src/tools/collab.ts` | modify | No `rowid`; writes via core; doctor via core; tombstone delete (T7) |
| `test/helpers/server.mjs`, `test/api.contract-0006.test.mts` | modify/create | Level-aware REST tests (T7) |
| `mcp/src/scripts/log-collab.ts`, `sweep-deps.ts`, `manual-search.ts`, `seed.ts`, `mcp/src/migrate.ts` | modify | All DB access through core; init creates (T1, T8) |
| `mcp/src/scripts/rehearse-0006.ts` | create | Real-DB rehearsal + optional cr-sqlite probe (T9) |
| `test/golden/snapshot.mjs` | modify | Line-ending-insensitive compare (T9) |
| `core/test/helpers/levels.ts` | create | `dbAt`, `testAtEachLevel` (T3) |
| `core/test/migrate-0006.test.ts`, `entry-write.test.ts`, `write-paths-0006.test.ts`, `read-paths-0006.test.ts`, `doctor-0006.test.ts` | create | Tests |
| `README.bundle.md`, `SETUP-PROMPT.md` | modify | Init step (T1) |
| `core/src/index.ts` | modify | Export the new modules |

---

### Task 1: Never silently create a database (E-689) + injectable migration dirs

This task can be merged on its own before any of 0006. It fixes the failure the user already hit.

**Files:**
- Modify: `core/src/db.ts:55-90` (getDb), `core/src/db.ts:118-217` (MigrateOptions, pendingMigrations)
- Modify: `mcp/src/migrate.ts`, `mcp/src/scripts/seed.ts`, `test/helpers/server.mjs`, `README.bundle.md:75-80`, `SETUP-PROMPT.md` (setup step list)
- Test: `core/test/db-path.test.ts`, `core/test/migrate-0005.test.ts`

**Interfaces:**
- Produces: `getDb(dbPath?: string, opts?: GetDbOptions): DB` with `interface GetDbOptions { create?: boolean }`; `class MissingDatabaseError extends Error` (name `"MissingDatabaseError"`); `interface MigrateOptions { includeStaged?: boolean; migrationsDir?: string; stagedDir?: string }`.

- [ ] **Step 1: Write the failing tests** (append to `core/test/db-path.test.ts`; add the imports to the top of the file)

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb, closeDb, MissingDatabaseError } from '../src/db.js';

function withVar(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { fn(); } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-guard-'));
  return { dir, path: join(dir, 'collab.db') };
}

// E-689: the REST server once opened ./collab.db because .env loaded late;
// SQLite created it, migrate() gave it a valid schema, and the UI showed 0
// entries with no error. A missing file must be an error, not a new DB.
test('getDb refuses to create a missing database file', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => {
      assert.throws(
        () => getDb(path),
        (e: Error) =>
          e instanceof MissingDatabaseError &&
          e.message.includes(path) &&
          e.message.includes('npm --prefix mcp run migrate'),
      );
    });
    assert.equal(existsSync(path), false, 'the refused path must not have been created');
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb creates the file when create: true is passed', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => { getDb(path, { create: true }); });
    assert.equal(existsSync(path), true);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb creates the file when COLLAB_DB_CREATE=1', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', '1', () => { getDb(path); });
    assert.equal(existsSync(path), true);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb opens :memory: without the guard', () => {
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => { assert.ok(getDb(':memory:')); });
  } finally {
    closeDb();
  }
});
```

In `core/test/migrate-0005.test.ts`, **replace the whole body** of the test `'migrate refuses a version that exists in both migrations/ and staged/'`, and the whole body of `'plain migrate() never applies staged migrations'`, with temp-dir versions. From now on neither test writes into the real `mcp/migrations` (E-685 #8):

```ts
test('migrate refuses a version that exists in both migrations/ and staged/', () => {
  const { db, dir } = tempDb();
  const migrationsDir = join(dir, 'migrations');
  const stagedDir = join(migrationsDir, 'staged');
  mkdirSync(stagedDir, { recursive: true });
  const probe = `BEGIN; INSERT INTO schema_migrations (version) VALUES ('0999_dup_probe'); COMMIT;`;
  writeFileSync(join(migrationsDir, '0999_dup_probe.sql'), probe);
  writeFileSync(join(stagedDir, '0999_dup_probe.sql'), probe);
  try {
    assert.throws(
      () => migrateProd(db, { includeStaged: true, migrationsDir, stagedDir }),
      (e: Error) => e.name === 'DuplicateMigrationError',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain migrate() never applies staged migrations', () => {
  const { db, dir } = tempDb();
  const migrationsDir = join(dir, 'migrations');
  const stagedDir = join(migrationsDir, 'staged');
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(join(stagedDir, '0999_staged_probe.sql'),
    `BEGIN; INSERT INTO schema_migrations (version) VALUES ('0999_staged_probe'); COMMIT;`);
  try {
    migrateProd(db, { migrationsDir, stagedDir });
    assert.equal(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0999_staged_probe'`).get(), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/db-path.test.ts test/migrate-0005.test.ts`
Expected: FAIL. `MissingDatabaseError` is not exported, and `migrationsDir` is ignored.

- [ ] **Step 3: Implement.** In `core/src/db.ts`:

Add `existsSync` to the existing `node:fs` import (it is already imported). Then replace `getDb` (lines 55–90) with:

```ts
let _db: DB | null = null;
let _dbPath: string | null = null;

export interface GetDbOptions {
  /** Allow creating the file when it does not exist. Only init paths pass this. */
  create?: boolean;
}

/**
 * Thrown instead of creating a new, empty database (collab E-689). A missing
 * file almost always means a wrong path (a typo, a late-loaded .env, the wrong
 * cwd), and a freshly migrated empty DB looks exactly like "all entries gone".
 */
export class MissingDatabaseError extends Error {
  constructor(path: string, source: DbPathSource) {
    super(
      `[collab-mcp] no database at ${path} (resolved from ${source}). Refusing to create an empty one.\n` +
        `[collab-mcp] To create a new knowledge base there, run once: ` +
        `COLLAB_DB_PATH="${path}" npm --prefix mcp run migrate  (or set COLLAB_DB_CREATE=1).`,
    );
    this.name = "MissingDatabaseError";
  }
}

export function getDb(dbPath?: string, opts: GetDbOptions = {}): DB {
  if (_db) {
    // The connection is a module-level singleton, so a later caller asking for a
    // DIFFERENT file would silently receive the first one. Refuse instead: a
    // request for the wrong knowledge base must never look like it succeeded.
    if (dbPath && _dbPath && dbPath !== _dbPath) {
      throw new Error(
        `[collab-mcp] getDb("${dbPath}") requested, but "${_dbPath}" is already open. ` +
          `Call closeDb() before switching databases.`,
      );
    }
    return _db;
  }

  const { path, source } = resolveDbPath(dbPath);

  const mayCreate = opts.create === true || process.env.COLLAB_DB_CREATE === "1";
  if (path !== ":memory:" && !mayCreate && !existsSync(path)) {
    throw new MissingDatabaseError(path, source);
  }

  // The fallback is safe (per-project) but implicit, so say so out loud.
  // stderr keeps this off the MCP stdio channel.
  if (source === "cwd-fallback") {
    console.error(
      `[collab-mcp] COLLAB_DB_PATH is not set - opening ${path}\n` +
        `[collab-mcp] Set COLLAB_DB_PATH to pin this project to a specific knowledge base.`,
    );
  }
  // One line per process: which file this process is actually using (E-689).
  console.error(`[collab-mcp] db: ${path} (${source})`);

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  _db = db;
  _dbPath = path;
  return db;
}
```

Replace `MigrateOptions` and `pendingMigrations`:

```ts
export interface MigrateOptions {
  includeStaged?: boolean;
  /** Tests only: read migrations from here instead of mcp/migrations. */
  migrationsDir?: string;
  /** Tests only: defaults to <migrationsDir>/staged. */
  stagedDir?: string;
}

function pendingMigrations(db: DB, upTo: string | undefined, opts: MigrateOptions): Pending[] {
  // Bootstrap the bookkeeping table (also created by 0001_init, but we need it
  // before we can read from it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as string),
  );
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const stagedDir = opts.stagedDir ?? (opts.migrationsDir ? join(opts.migrationsDir, "staged") : STAGED_DIR);
  const core = listSql(migrationsDir);
  const staged = opts.includeStaged ? listSql(stagedDir) : [];
  for (const s of staged) {
    const dup = core.find((c) => c.version === s.version);
    if (dup) throw new DuplicateMigrationError(s.version, dup.file, s.file);
  }
  return [...core, ...staged]
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
    .filter((m) => !applied.has(m.version) && (upTo === undefined || m.version.slice(0, 4) <= upTo));
}
```

`mcp/src/migrate.ts`: the init command is the one legitimate creator.

```ts
// The one command allowed to create a new knowledge base (E-689).
const db = getDb(undefined, { create: true });
```

`mcp/src/scripts/seed.ts` line 11: `const db = getDb(undefined, { create: true });`

`test/helpers/server.mjs`: after `process.env.COLLAB_DB_PATH = tmpFile;` add
```js
  process.env.COLLAB_DB_CREATE = '1'; // test DBs are created on purpose
```

`README.bundle.md`: replace the sentence at line 80 ending "migrated automatically on first run." with:
```md
Create it once before first use:
`COLLAB_DB_PATH=<workspace>/collab.db npm --prefix <abs>/mcp run migrate`.
The servers refuse to open a path that does not exist, because a typo in the path
must never look like an empty knowledge base (collab E-689).
```

`SETUP-PROMPT.md`: add this step right after the step that chooses `COLLAB_DB_PATH` (line 36), and renumber the steps after it:
```md
   Create the database once (the servers never create one on their own):
   COLLAB_DB_PATH="<dbpath>" npm --prefix ${COLLAB_MCP_DIR}/mcp run migrate
```

- [ ] **Step 4: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/db-path.test.ts test/migrate-0005.test.ts`
Expected: PASS, and no `0999_*` file anywhere under `mcp/migrations`.

- [ ] **Step 5: Checkpoint: user commits** (suggested message: `fix(core): refuse to create a missing collab DB; log the resolved path (E-689)`)

---

### Task 2: Staged `0006_ulid_contract.sql` + pre-flight hook

**Files:**
- Create: `mcp/migrations/staged/0006_ulid_contract.sql`
- Create: `core/src/preflight-0006.ts`
- Modify: `core/src/db.ts` (`applyMigrations`, imports)
- Modify: `core/src/index.ts` (export preflight)
- Test: `core/test/migrate-0006.test.ts`

**Interfaces:**
- Consumes: `migrateTo(db, upTo, { includeStaged })`, `ulidFromLegacy`, `newUlid`, `resolveAuthor`.
- Produces: `preflight0006(db: DB): { assignedUlids: number; stampedAuthors: number }`; `class PreflightError extends Error { problems: string[] }` (name `"PreflightError"`); a table `local_counters(name TEXT PK, value INTEGER)` with row `'entry_number'`; migration version `'0006_ulid_contract'`.

- [ ] **Step 1: Write the failing tests** in `core/test/migrate-0006.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate as migrateProd, migrateTo } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { supersede } from '../src/ops/supersede.js';
import { newUlid } from '../src/ulid.js';

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0006-'));
  const db = new Database(join(dir, 'collab.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const fts = (db: Database.Database) =>
  db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);

// A realistic 0005 DB: modules, refs in every legacy link format, a supersede.
function seed0005(db: Database.Database) {
  migrateTo(db, '0005', { includeStaged: true });
  db.prepare(`INSERT INTO modules (slug, name, hub) VALUES ('m1', 'M1', NULL)`).run();
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-001', 'task')`).run();
  const a = addEntry(db, { type: 'decision', title: 'alpha', summary: 's', module: 'm1', task_id: 'T-001' }).id;
  const b = addEntry(db, { type: 'gotcha', title: 'beta', summary: 's', modules: ['m1', 'm2'],
    refs: [{ ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'entry', ref_value: `#${a}` },
           { ref_type: 'file', ref_value: 'x.ts' }] }).id;
  const c = addEntry(db, { type: 'handoff', title: 'gamma', summary: 's' }).id;
  supersede(db, { ids: [a], by: b });
  return { a, b, c };
}

const snapshot = (db: Database.Database) => ({
  entries: db.prepare(`SELECT ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
    tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category, superseded_by, author,
    superseded_by_ulid FROM entries ORDER BY ulid`).all(),
  refs: db.prepare(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`).all(),
  modules: db.prepare(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`).all(),
  tasks: db.prepare(`SELECT * FROM tasks ORDER BY id`).all(),
  moduleRows: db.prepare(`SELECT slug, name, hub, status FROM modules ORDER BY slug`).all(),
});

test('rebuild keeps every row, key and link', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db);
    const before = snapshot(db);
    migrate(db);
    assert.deepEqual(snapshot(db), before);
    assert.ok(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get());
  } finally { cleanup(); }
});

test('entries.ulid is the primary key; id is a nullable, non-unique label', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db); migrate(db);
    const pk = db.prepare(`SELECT name FROM pragma_table_info('entries') WHERE pk = 1`).all();
    assert.deepEqual(pk, [{ name: 'ulid' }]);
    const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, ?, 'handoff', 'signal', 't', 's')`);
    ins.run(newUlid(), null);
    ins.run(newUlid(), 7);
    ins.run(newUlid(), 7);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entries WHERE id = 7`).get() as any).c, 2);
  } finally { cleanup(); }
});

test('counter is seeded from max(sqlite_sequence, max(id)) so deleted numbers are never reused', () => {
  const { db, cleanup } = tempDb();
  try {
    const { c } = seed0005(db);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(c); // 0005: hard delete; seq stays at c
    migrate(db);
    const v = (db.prepare(`SELECT value FROM local_counters WHERE name = 'entry_number'`).get() as any).value;
    assert.equal(v, c);
  } finally { cleanup(); }
});

test('FTS own copy survives a NULL->text edit (E-684)', () => {
  const { db, cleanup } = tempDb();
  try {
    const { c } = seed0005(db); migrate(db);
    db.prepare(`UPDATE entries SET description = 'zebracorn' WHERE id = ?`).run(c); // description was NULL
    fts(db);
    const hit = db.prepare(`SELECT e.id FROM entries_fts JOIN entries e ON e.ulid = entries_fts.ulid WHERE entries_fts MATCH 'zebracorn'`).all();
    assert.deepEqual(hit, [{ id: c }]);
  } finally { cleanup(); }
});

test('entries.ulid is immutable', () => {
  const { db, cleanup } = tempDb();
  try {
    const { a } = seed0005(db); migrate(db);
    assert.throws(() => db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`).run(newUlid(), a), /immutable/);
  } finally { cleanup(); }
});

test('preflight rejects duplicate and malformed ulids and changes nothing', () => {
  const { db, cleanup } = tempDb();
  try {
    const { a, b, c } = seed0005(db);
    const ulidA = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(a) as any).ulid;
    db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`).run(ulidA, b);        // duplicate
    db.prepare(`UPDATE entries SET ulid = 'not-a-ulid' WHERE id = ?`).run(c);   // malformed
    const before = db.prepare(`SELECT id, ulid, author FROM entries ORDER BY id`).all();
    const E = (n: number) => `E-${String(n).padStart(5, '0')}`; // PreflightError pads like doctor
    assert.throws(() => migrate(db), (e: any) =>
      e.name === 'PreflightError' &&
      e.problems.some((p: string) => p.includes(E(a)) && p.includes(E(b))) &&
      e.problems.some((p: string) => p.includes(E(c)) && p.includes('not-a-ulid')));
    assert.equal(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get(), undefined);
    assert.deepEqual(db.prepare(`SELECT id, ulid, author FROM entries ORDER BY id`).all(), before);
  } finally { cleanup(); }
});

test('preflight assigns a ulid to a row the backfill skipped (unparseable created_at)', () => {
  const { db, cleanup } = tempDb();
  try {
    seed0005(db);
    db.prepare(`INSERT INTO entries (type, kind, title, summary, created_at) VALUES ('handoff', 'signal', 'odd', 's', 'garbage')`).run();
    migrate(db);
    const row = db.prepare(`SELECT ulid FROM entries WHERE title = 'odd'`).get() as any;
    assert.match(row.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  } finally { cleanup(); }
});

test('a 0004 DB with rows migrates straight through 0005 and 0006', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateTo(db, '0004');
    const one = db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('decision', 'signal', 'old', 's')`).run().lastInsertRowid;
    const two = db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('handoff', 'signal', 'old2', 's')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (?, 'entry', ?)`).run(two, `E-${one}`);
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (?, 'm1', 1)`).run(two);
    migrate(db);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entries WHERE ulid IS NULL`).get() as any).c, 0);
    const link = db.prepare(`SELECT target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
    const oneUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(one) as any).ulid;
    assert.equal(link.target_ulid, oneUlid);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM entry_modules`).get() as any).c, 1);
    fts(db);
  } finally { cleanup(); }
});

test('perf at 10k entries: edit < 100 ms, search < 100 ms (E-674)', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateTo(db, '0006', { includeStaged: true });
    const words = ['sync', 'relay', 'ulid', 'merge', 'tombstone', 'module', 'hub', 'search', 'index', 'report'];
    const txt = (n: number, k: number) => Array.from({ length: n }, (_, i) => words[(i * 7 + k) % words.length]).join(' ');
    const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, description) VALUES (?, ?, 'session-note', 'log', ?, ?, ?)`);
    db.transaction(() => { for (let i = 1; i <= 10000; i++) ins.run(newUlid(), i, `perf ${txt(6, i)}`, txt(20, i), txt(200, i)); })();
    const target = (db.prepare(`SELECT ulid FROM entries WHERE id = 5000`).get() as any).ulid;
    const edit = db.prepare(`UPDATE entries SET description = description || ' x' WHERE ulid = ?`);
    let t = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) edit.run(target);
    const editMs = Number(process.hrtime.bigint() - t) / 10 / 1e6;
    const q = db.prepare(`SELECT e.id FROM entries_fts JOIN entries e ON e.ulid = entries_fts.ulid
      WHERE entries_fts MATCH ? AND e.deprecated = 0 AND e.deleted_at IS NULL ORDER BY bm25(entries_fts) LIMIT 10`);
    t = process.hrtime.bigint();
    for (let k = 0; k < 10; k++) q.all('relay* AND merge*');
    const searchMs = Number(process.hrtime.bigint() - t) / 10 / 1e6;
    assert.ok(editMs < 100, `edit took ${editMs.toFixed(1)} ms`);
    assert.ok(searchMs < 100, `search took ${searchMs.toFixed(1)} ms`);
    fts(db);
  } finally { cleanup(); }
});

test('plain migrate() never applies staged 0006', () => {
  const { db, cleanup } = tempDb();
  try {
    migrateProd(db);
    assert.equal(db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0006_ulid_contract'`).get(), undefined);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/migrate-0006.test.ts`
Expected: FAIL (no 0006 file; `local_counters` missing; the pk is still `id`).

- [ ] **Step 3: Create `mcp/migrations/staged/0006_ulid_contract.sql`** with exactly this content (this is the spike-verified SQL):

```sql
-- ============================================================
-- Collab — team-sync schema, CONTRACT phase (E-687, E-685, E-674, E-648, E-651)
-- Migration: 0006_ulid_contract
--
-- Rebuilds entries / refs / entry_modules / tasks / modules so every table
-- that will sync has a NOT NULL primary key and a DEFAULT on every other
-- NOT NULL column (cr-sqlite rules; verified with crsql_as_crr in the
-- 2026-09-29 spike and re-checked by mcp/src/scripts/rehearse-0006.ts).
--
--   entries.ulid          -> PRIMARY KEY (was: id INTEGER PK AUTOINCREMENT)
--   entries.id            -> E-number LABEL: nullable, NOT unique (E-648)
--   entries.deleted_at    -> tombstone; the app never hard-deletes after 0006
--   refs PK               -> (entry_ulid, ref_type, ref_value)       (E-651)
--   entry_modules PK      -> (entry_ulid, module)
--   refs/entry_modules.entry_id -> write-only legacy label, never read
--   entries_fts           -> keeps its OWN copy of the text, keyed by ulid
--   local_counters        -> local E-number allocator (never synced)
--
-- dispatches is NOT rebuilt: it is local telemetry (token counts of this
-- machine's agent runs), it never syncs, and its INTEGER AUTOINCREMENT key is
-- what keeps sqlite_sequence alive.
--
-- The JS pre-flight (core/src/preflight-0006.ts) runs BEFORE this file and
-- guarantees: every entry has a valid, unique 26-char ulid; every refs /
-- entry_modules row has entry_ulid; tasks.id and modules.slug are non-NULL.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Seed the E-number counter FIRST. The 'entries' row of sqlite_sequence
--    disappears when the AUTOINCREMENT table is dropped below. max(seq, max(id))
--    so numbers that were used and then deleted are never handed out again.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_counters (
  name   TEXT    NOT NULL PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO local_counters (name, value)
SELECT 'entry_number', MAX(
  COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'entries'), 0),
  COALESCE((SELECT MAX(id) FROM entries), 0)
);

-- ------------------------------------------------------------
-- 1. Drop every trigger that names a table being rebuilt, and the external-
--    content FTS table (content='entries'). If any survives, ALTER TABLE ...
--    RENAME below fails with "error in trigger ...: no such table: main.entries".
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_entries_fts_ai;
DROP TRIGGER IF EXISTS trg_entries_fts_ad;
DROP TRIGGER IF EXISTS trg_entries_fts_au;
DROP TRIGGER IF EXISTS trg_entries_updated_at;
DROP TRIGGER IF EXISTS trg_entries_fill_superseded_ulid;
DROP TRIGGER IF EXISTS trg_entries_revision;
DROP TRIGGER IF EXISTS trg_refs_cascade_delete;
DROP TRIGGER IF EXISTS trg_refs_fill_ulids;
DROP TRIGGER IF EXISTS trg_entry_modules_cascade_delete;
DROP TRIGGER IF EXISTS trg_entry_modules_fill_ulid;
DROP TRIGGER IF EXISTS trg_tasks_updated_at;
DROP TRIGGER IF EXISTS trg_modules_updated_at;
DROP TABLE IF EXISTS entries_fts;

-- ------------------------------------------------------------
-- 2. entries (explicit column lists everywhere: 0005 appended columns, so
--    SELECT * would silently misalign)
-- ------------------------------------------------------------
CREATE TABLE entries_new (
  ulid               TEXT    NOT NULL PRIMARY KEY CHECK (length(ulid) = 26),
  id                 INTEGER,  -- E-number label (E-648): nullable, no UNIQUE
  type               TEXT    NOT NULL DEFAULT 'session-note'
                     CHECK (type IN ('handoff','review','proposal','counter','decision',
                                     'gotcha','rollup','session-note','changelog')),
  kind               TEXT    NOT NULL DEFAULT 'log' CHECK (kind IN ('signal','log')),
  title              TEXT    NOT NULL DEFAULT '',
  summary            TEXT    NOT NULL DEFAULT '' CHECK (length(summary) <= 200),
  description        TEXT,
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('draft','active','resolved','deprecated')),
  agent              TEXT    CHECK (agent IS NULL OR agent IN ('Claude','Codex','Gemini','User')),
  module             TEXT,
  task_id            TEXT,
  tokens_estimate    INTEGER NOT NULL DEFAULT 0,
  rollup_of_task     TEXT,
  deprecated         INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0,1)),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  category           TEXT    NOT NULL DEFAULT 'Activity'
                     CHECK (category IN ('Index','Reference','Activity')),
  superseded_by      INTEGER,
  author             TEXT,
  superseded_by_ulid TEXT,
  deleted_at         TEXT,
  CHECK (type != 'rollup' OR rollup_of_task IS NOT NULL)
);
INSERT INTO entries_new (
  ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category,
  superseded_by, author, superseded_by_ulid, deleted_at
)
SELECT
  ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category,
  superseded_by, author, superseded_by_ulid, NULL
FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX idx_entries_id         ON entries(id);
CREATE INDEX idx_entries_type       ON entries(type);
CREATE INDEX idx_entries_module     ON entries(module);
CREATE INDEX idx_entries_task       ON entries(task_id);
CREATE INDEX idx_entries_created    ON entries(created_at);
CREATE INDEX idx_entries_kind       ON entries(kind);
CREATE INDEX idx_entries_status     ON entries(status);
CREATE INDEX idx_entries_deprecated ON entries(deprecated);
CREATE INDEX idx_entries_category   ON entries(category);
CREATE INDEX idx_entries_superseded ON entries(superseded_by);

-- ------------------------------------------------------------
-- 3. refs: PK moves to entry_ulid (E-651). entry_id stays as a write-only label.
-- ------------------------------------------------------------
CREATE TABLE refs_new (
  entry_ulid   TEXT    NOT NULL,
  ref_type     TEXT    NOT NULL DEFAULT 'file' CHECK (ref_type IN ('file','task','entry','url')),
  ref_value    TEXT    NOT NULL DEFAULT '',
  entry_id     INTEGER,
  target_ulid  TEXT,
  PRIMARY KEY (entry_ulid, ref_type, ref_value)
);
INSERT INTO refs_new (entry_ulid, ref_type, ref_value, entry_id, target_ulid)
SELECT entry_ulid, ref_type, ref_value, entry_id, target_ulid FROM refs;
DROP TABLE refs;
ALTER TABLE refs_new RENAME TO refs;

CREATE INDEX idx_refs_value       ON refs(ref_value);
CREATE INDEX idx_refs_type        ON refs(ref_type);
CREATE INDEX idx_refs_target_ulid ON refs(target_ulid);

-- ------------------------------------------------------------
-- 4. entry_modules
-- ------------------------------------------------------------
CREATE TABLE entry_modules_new (
  entry_ulid  TEXT    NOT NULL,
  module      TEXT    NOT NULL DEFAULT '',
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  entry_id    INTEGER,
  PRIMARY KEY (entry_ulid, module)
);
INSERT INTO entry_modules_new (entry_ulid, module, is_primary, entry_id)
SELECT entry_ulid, module, is_primary, entry_id FROM entry_modules;
DROP TABLE entry_modules;
ALTER TABLE entry_modules_new RENAME TO entry_modules;

CREATE INDEX idx_entry_modules_module ON entry_modules(module);

-- ------------------------------------------------------------
-- 5. tasks: NOT NULL PK + DEFAULT on title.
-- ------------------------------------------------------------
CREATE TABLE tasks_new (
  id           TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  summary      TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','assigned','in-progress','review','done')),
  assignee     TEXT CHECK (assignee IS NULL OR assignee IN ('Claude','Codex','Gemini','User')),
  priority     TEXT CHECK (priority IS NULL OR priority IN ('critical','high','medium','low')),
  module       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tasks_new (id, title, summary, description, status, assignee, priority, module, created_at, updated_at)
SELECT id, title, summary, description, status, assignee, priority, module, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_status   ON tasks(status);
CREATE INDEX idx_tasks_module   ON tasks(module);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);

-- ------------------------------------------------------------
-- 6. modules: NOT NULL PK. The slug CHECK is 0002's (INSTR), NOT 0001's
--    broken LIKE '%_%' (where _ is a wildcard). Keeps 0005's hub column.
-- ------------------------------------------------------------
CREATE TABLE modules_new (
  slug          TEXT NOT NULL PRIMARY KEY
                CHECK (slug GLOB '[a-z0-9]*' AND INSTR(slug, '_') = 0 AND length(slug) <= 60),
  name          TEXT,
  summary       TEXT,
  description   TEXT,
  current_goal  TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stable','deprecated')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  hub           TEXT
);
INSERT INTO modules_new (slug, name, summary, description, current_goal, status, created_at, updated_at, hub)
SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules;
DROP TABLE modules;
ALTER TABLE modules_new RENAME TO modules;

-- ------------------------------------------------------------
-- 7. FTS with its own copy of the text, keyed by ulid. Local only, never
--    synced. Deletes scan by the UNINDEXED ulid column; the 10k-row timing
--    test in migrate-0006.test.ts holds this to the E-674 budget.
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE entries_fts USING fts5(
  ulid UNINDEXED,
  title,
  summary,
  description,
  tokenize = 'porter unicode61'
);
INSERT INTO entries_fts (ulid, title, summary, description)
SELECT ulid, title, summary, description FROM entries;

-- ------------------------------------------------------------
-- 8. Triggers. Creation order matters: SQLite fires the NEWEST same-event
--    trigger first (E-684). Safe here because trg_entries_fts_au watches only
--    the three FTS columns, so the bookkeeping UPDATEs below never reach it.
-- ------------------------------------------------------------
CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category,
                superseded_by, deleted_at
ON entries
FOR EACH ROW
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE ulid = OLD.ulid;
END;

CREATE TRIGGER trg_entries_fts_ai
AFTER INSERT ON entries
BEGIN
  INSERT INTO entries_fts (ulid, title, summary, description)
  VALUES (new.ulid, new.title, new.summary, new.description);
END;

CREATE TRIGGER trg_entries_fts_ad
AFTER DELETE ON entries
BEGIN
  DELETE FROM entries_fts WHERE ulid = old.ulid;
END;

CREATE TRIGGER trg_entries_fts_au
AFTER UPDATE OF title, summary, description ON entries
BEGIN
  DELETE FROM entries_fts WHERE ulid = old.ulid;
  INSERT INTO entries_fts (ulid, title, summary, description)
  VALUES (new.ulid, new.title, new.summary, new.description);
END;

-- The ulid is the identity everything else hangs off (refs, modules, FTS,
-- revisions, sync). Changing it would orphan all of them silently.
CREATE TRIGGER trg_entries_ulid_immutable
BEFORE UPDATE OF ulid ON entries
WHEN NEW.ulid IS NOT OLD.ulid
BEGIN
  SELECT RAISE(ABORT, 'entries.ulid is immutable');
END;

-- Writers set superseded_by_ulid themselves. This only repairs a legacy
-- writer that changed the integer superseded_by but not its ULID twin.
CREATE TRIGGER trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
WHEN NEW.superseded_by IS NOT OLD.superseded_by
 AND NEW.superseded_by_ulid IS OLD.superseded_by_ulid
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = NEW.superseded_by ORDER BY e.ulid LIMIT 1)
   WHERE ulid = NEW.ulid;
END;

-- Unchanged from 0005 (already keyed on ulid).
CREATE TRIGGER trg_entries_revision
AFTER UPDATE OF title, summary, description ON entries
WHEN NEW.ulid IS NOT NULL
 AND (OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.description IS NOT NEW.description)
BEGIN
  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description, created_at)
  SELECT NEW.ulid, NULL, OLD.title, OLD.summary, OLD.description, OLD.updated_at
   WHERE NOT EXISTS (SELECT 1 FROM entry_revisions WHERE entry_ulid = NEW.ulid);

  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description)
  VALUES (
    NEW.ulid,
    (SELECT rev_id FROM entry_revisions WHERE entry_ulid = NEW.ulid ORDER BY created_at DESC, rowid DESC LIMIT 1),
    NEW.title, NEW.summary, NEW.description
  );
END;

-- Resolves a legacy link value ("214", "E-214", "#116", ...) to the target's
-- ulid. The parser MUST match parseEntryRef() in core/src/ulid.ts (same
-- explicit whitespace set; the 0005 parity test guards it).
-- id is no longer unique, so pick deterministically (lowest ulid).
CREATE TRIGGER trg_refs_fill_target_ulid
AFTER INSERT ON refs
WHEN NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
BEGIN
  UPDATE refs SET target_ulid = (
    SELECT e.ulid FROM entries e WHERE e.id = (
      SELECT CAST(d AS INTEGER) FROM (
        SELECT CASE
          WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
          WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
          WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
          ELSE s
        END AS d
        FROM (SELECT upper(trim(NEW.ref_value, ' ' || char(9,10,11,12,13,160))) AS s)
      )
      WHERE d <> '' AND d NOT GLOB '*[^0-9]*' AND CAST(d AS INTEGER) > 0
    )
    ORDER BY e.ulid LIMIT 1
  )
  WHERE entry_ulid = NEW.entry_ulid AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END;

-- Hard deletes still happen (a synced delete, a script). Cascade by ulid.
CREATE TRIGGER trg_refs_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM refs WHERE entry_ulid = old.ulid;
END;

CREATE TRIGGER trg_entry_modules_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM entry_modules WHERE entry_ulid = old.ulid;
END;

CREATE TRIGGER trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
BEGIN
  UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_modules_updated_at
AFTER UPDATE ON modules
FOR EACH ROW
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END;

INSERT INTO schema_migrations (version) VALUES ('0006_ulid_contract');

COMMIT;
```

- [ ] **Step 4: Create `core/src/preflight-0006.ts`**

```ts
import type { DB } from "./db.js";
import { newUlid, ulidFromLegacy } from "./ulid.js";
import { resolveAuthor } from "./author.js";

/**
 * Everything 0006's table rebuild assumes, checked BEFORE any table is touched
 * (collab E-685 item 1). Runs inside one transaction: if anything is wrong it
 * throws and its own repairs roll back too, so the DB is exactly as it was.
 */
export class PreflightError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `[collab-mcp] 0006 pre-flight failed, nothing was changed:\n  - ${problems.join("\n  - ")}\n` +
        `[collab-mcp] Fix these rows, then start the server again.`,
    );
    this.name = "PreflightError";
  }
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const eid = (id: number | null) => `E-${String(id ?? "?").padStart(5, "0")}`;

export function preflight0006(db: DB): { assignedUlids: number; stampedAuthors: number } {
  const run = db.transaction(() => {
    // 1. Rows the 0005 backfill skipped (unparseable created_at) or that were
    //    written without core. Prefer the deterministic legacy ULID (D1 of the
    //    0005 plan) so every machine holding the row derives the same one.
    const missing = db
      .prepare(`SELECT id, created_at, title FROM entries WHERE ulid IS NULL ORDER BY id`)
      .all() as Array<{ id: number; created_at: string; title: string }>;
    const setUlid = db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`);
    for (const r of missing) {
      let u: string;
      try { u = ulidFromLegacy(r.id, r.created_at, r.title); } catch { u = newUlid(); }
      setUlid.run(u, r.id);
    }

    // 2. One-time author stamp (E-685 #7). After 0006 the startup backfill
    //    never stamps author, so a synced row is never claimed by this machine.
    const author = resolveAuthor();
    const stampedAuthors = author
      ? db.prepare(`UPDATE entries SET author = ? WHERE author IS NULL`).run(author).changes
      : 0;

    // 3. ULID keys the rebuilt tables need as NOT NULL primary-key columns.
    db.prepare(`UPDATE refs SET entry_ulid = (SELECT ulid FROM entries WHERE id = refs.entry_id) WHERE entry_ulid IS NULL`).run();
    db.prepare(`UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = entry_modules.entry_id) WHERE entry_ulid IS NULL`).run();
    db.prepare(`
      UPDATE entries SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = entries.superseded_by)
       WHERE superseded_by IS NOT NULL AND superseded_by_ulid IS NULL
    `).run();

    // 4. Validate. Collect everything, then fail once with the full list.
    const problems: string[] = [];
    const seen = new Map<string, number>();
    for (const r of db.prepare(`SELECT id, ulid FROM entries ORDER BY id`).all() as Array<{ id: number; ulid: string }>) {
      if (!ULID_RE.test(r.ulid)) problems.push(`${eid(r.id)}: invalid ulid "${r.ulid}"`);
      const prev = seen.get(r.ulid);
      if (prev !== undefined) problems.push(`${eid(prev)} and ${eid(r.id)} share ulid ${r.ulid}`);
      else seen.set(r.ulid, r.id);
    }
    for (const r of db.prepare(`SELECT entry_id, ref_type, ref_value FROM refs WHERE entry_ulid IS NULL`).all() as any[]) {
      problems.push(`refs row (${eid(r.entry_id)}, ${r.ref_type}, ${r.ref_value}) has no owning entry`);
    }
    for (const r of db.prepare(`SELECT entry_id, module FROM entry_modules WHERE entry_ulid IS NULL`).all() as any[]) {
      problems.push(`entry_modules row (${eid(r.entry_id)}, ${r.module}) has no owning entry`);
    }
    const nullTasks = (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE id IS NULL`).get() as { c: number }).c;
    if (nullTasks > 0) problems.push(`${nullTasks} task row(s) with a NULL id`);
    const nullModules = (db.prepare(`SELECT COUNT(*) c FROM modules WHERE slug IS NULL`).get() as { c: number }).c;
    if (nullModules > 0) problems.push(`${nullModules} module row(s) with a NULL slug`);

    if (problems.length > 0) throw new PreflightError(problems);
    return { assignedUlids: missing.length, stampedAuthors };
  });
  return run();
}
```

- [ ] **Step 5: Wire the hook into `core/src/db.ts`.** Add the import next to the `backfillUlids` import:

```ts
import { preflight0006 } from "./preflight-0006.js";
```

Add this above `applyMigrations`:

```ts
// JS that must run immediately BEFORE a given migration's SQL (after the
// backup). A hook that throws stops migrate() before that SQL runs.
const BEFORE_MIGRATION: Record<string, (db: DB) => unknown> = {
  "0006_ulid_contract": preflight0006,
};
```

In `applyMigrations`, change the loop body to:

```ts
  for (const m of pending) {
    BEFORE_MIGRATION[m.version]?.(db);
    // Each migration file owns its BEGIN/COMMIT; we just exec.
    db.exec(readFileSync(m.file, "utf-8"));
  }
```

In `core/src/index.ts` add: `export * from './preflight-0006.js';`

- [ ] **Step 6: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/migrate-0006.test.ts test/migrate-0005.test.ts`
Expected: PASS. 0005's own tests must still pass. If `rebuild keeps every row` fails only on `updated_at`, a trigger fired during the copy. Stop and report; do not loosen the assertion.

- [ ] **Step 7: Checkpoint: user commits** (suggested: `feat(core): staged 0006 ulid contract migration + pre-flight (E-685)`)

---

### Task 3: Schema helpers, dual-level fixture, insert paths (`addEntry`, `rollup`, `archive`)

**Files:**
- Create: `core/src/schema.ts`, `core/src/entry-write.ts`, `core/test/helpers/levels.ts`, `core/test/entry-write.test.ts`
- Modify: `core/src/ops/add.ts:129-200`, `core/src/ops/rollup.ts:210-285` and `:380-450`, `core/src/index.ts`

**Interfaces:**
- Consumes: `hasUlidColumns(db)`, `newUlid()`, `resolveAuthor()`, `RefInput`, migration `0006_ulid_contract`.
- Produces (`core/src/schema.ts`): `hasUlidPrimaryKey(db: DB): boolean`, `liveEntry(db: DB, alias?: string): string`, `ftsJoin(db: DB, alias?: string): string`.
- Produces (`core/src/entry-write.ts`): `interface InsertedEntry { id: number; ulid: string | null }`; `interface EntryRowInput { type; kind; title; summary; description: string | null; status; agent: string | null; module: string | null; task_id: string | null; tokens_estimate: number; category?: string; rollup_of_task?: string | null }`; `interface RefRowInput extends RefInput { target_ulid?: string | null }`; `nextEntryNumber(db): number`; `insertEntryRow(db, row: EntryRowInput): InsertedEntry`; `insertRefs(db, owner: InsertedEntry, refs: RefRowInput[]): number`; `insertEntryModules(db, owner, modules: string[], primary: string | null): void`; `ownerOf(db, id: number): InsertedEntry | null`; `deleteRef(db, owner, ref: RefInput): number`; `replaceLinks(db, owner, modules: string[], primary: string | null, refs: RefRowInput[]): void`.
- Produces (`core/test/helpers/levels.ts`): `type Level = '0005' | '0006'`, `dbAt(level)`, `testAtEachLevel(name, fn: (db, level) => void)`.

- [ ] **Step 1: Create the fixture `core/test/helpers/levels.ts`**

```ts
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../../src/db.js';

export type Level = '0005' | '0006';
export const LEVELS: Level[] = ['0005', '0006'];

export function dbAt(level: Level): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `collab-${level}-`));
  const db = new Database(join(dir, 'collab.db'));
  migrateTo(db, level, { includeStaged: true });
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * One test per schema level. The merged branch runs on the live 0005 DB until
 * 0006 goes live, so every changed read/write must pass at BOTH levels
 * (0005's worst review bug was an insert that threw on the older schema).
 */
export function testAtEachLevel(name: string, fn: (db: Database.Database, level: Level) => void): void {
  for (const level of LEVELS) {
    test(`${name} [${level}]`, () => {
      const { db, cleanup } = dbAt(level);
      try { fn(db, level); } finally { cleanup(); }
    });
  }
}
```

- [ ] **Step 2: Write the failing tests** in `core/test/entry-write.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { rollup, archive } from '../src/ops/rollup.js';
import { hasUlidPrimaryKey } from '../src/schema.js';
import { migrate } from '../src/db.js';

testAtEachLevel('addEntry writes ulid, author and ulid-keyed links', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's', module: 'm1' }).id;
  const b = addEntry(db, { type: 'gotcha', title: 'b', summary: 's', modules: ['m1', 'm2'],
    refs: [{ ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'file', ref_value: 'f.ts' }] }).id;
  assert.equal(b, a + 1);
  const rowA = db.prepare(`SELECT ulid, author FROM entries WHERE id = ?`).get(a) as any;
  const rowB = db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(b) as any;
  assert.match(rowA.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const link = db.prepare(`SELECT entry_ulid, target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
  assert.deepEqual(link, { entry_ulid: rowB.ulid, target_ulid: rowA.ulid });
  const mods = db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(rowB.ulid);
  assert.deepEqual(mods, [{ module: 'm1', is_primary: 1 }, { module: 'm2', is_primary: 0 }]);
});

test('new entries continue the E-number sequence after 0006', () => {
  const { db, cleanup } = dbAt('0005');
  try {
    const ids = [1, 2, 3].map((i) => addEntry(db, { type: 'handoff', title: `t${i}`, summary: 's' }).id);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(ids[2]); // number 3 was used, then deleted
    migrate(db, { includeStaged: true });                       // 0005 -> 0006
    assert.ok(hasUlidPrimaryKey(db));
    assert.equal(addEntry(db, { type: 'handoff', title: 'after', summary: 's' }).id, ids[2] + 1);
  } finally { cleanup(); }
});

test('counter self-heals and never falls behind max(id)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const first = addEntry(db, { type: 'handoff', title: 'x', summary: 's' }).id;
    db.prepare(`DELETE FROM local_counters`).run();                       // lost counter row
    assert.equal(addEntry(db, { type: 'handoff', title: 'y', summary: 's' }).id, first + 1);
    db.prepare(`UPDATE entries SET id = 500 WHERE id = ?`).run(first + 1); // a label moved ahead of the counter
    assert.equal(addEntry(db, { type: 'handoff', title: 'z', summary: 's' }).id, 501);
  } finally { cleanup(); }
});

testAtEachLevel('rollup inserts a numbered rollup linked to its originals by ulid', (db) => {
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-009', 't')`).run();
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', task_id: 'T-009' }).id;
  const res = rollup(db, { task_id: 'T-009', dry_run: false } as any);
  const rid = res.created_entries[0].id;
  assert.equal(rid, a + 1);
  const aUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(a) as any).ulid;
  const rUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(rid) as any).ulid;
  const link = db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ? AND ref_type = 'entry'`).get(rUlid) as any;
  assert.equal(link.target_ulid, aUlid);
  assert.equal((db.prepare(`SELECT deprecated FROM entries WHERE id = ?`).get(a) as any).deprecated, 1);
});

testAtEachLevel('archive inserts a numbered breadcrumb', (db) => {
  const a = addEntry(db, { type: 'handoff', title: 'old', summary: 's', module: 'm1' }).id;
  db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(a);
  const res = archive(db, { older_than: '30d', dry_run: false } as any);
  assert.equal(res.created_entries.length, 1);
  assert.equal(res.created_entries[0].id, a + 1);
});
```

- [ ] **Step 3: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/entry-write.test.ts`
Expected: FAIL at `[0006]` (the insert omits `ulid`/`id`, and `NOT NULL constraint failed: entries.ulid`); `schema.js` is missing.

- [ ] **Step 4: Create `core/src/schema.ts`**

```ts
import type { DB } from "./db.js";

/**
 * True once migration 0006 has made entries.ulid the primary key.
 * Deliberately NOT cached (same reason as hasUlidColumns): migrate() can run
 * between two calls on one open handle.
 */
export function hasUlidPrimaryKey(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'ulid' AND pk = 1`).get();
}

/** SQL predicate that hides tombstoned entries. Before 0006 there is no deleted_at column. */
export function liveEntry(db: DB, alias = "e"): string {
  return hasUlidPrimaryKey(db) ? `${alias}.deleted_at IS NULL` : "1 = 1";
}

/** JOIN from entries_fts to entries: by ulid (0006 own-copy FTS) or by rowid = id (external content). */
export function ftsJoin(db: DB, alias = "e"): string {
  return hasUlidPrimaryKey(db)
    ? `JOIN entries ${alias} ON ${alias}.ulid = entries_fts.ulid`
    : `JOIN entries ${alias} ON ${alias}.id = entries_fts.rowid`;
}
```

- [ ] **Step 5: Create `core/src/entry-write.ts`**

```ts
import type { DB } from "./db.js";
import { hasUlidColumns } from "./db.js";
import { hasUlidPrimaryKey, liveEntry } from "./schema.js";
import { newUlid } from "./ulid.js";
import { resolveAuthor } from "./author.js";
import type { RefInput } from "./ops/add.js";

// The ONE place that knows how an entry and its links are written at each
// schema level (pre-0005 / 0005 / 0006). Every writer goes through here.

export interface InsertedEntry {
  id: number;
  ulid: string | null; // null only on a pre-0005 DB
}

export interface EntryRowInput {
  type: string;
  kind: string;
  title: string;
  summary: string;
  description: string | null;
  status: string;
  agent: string | null;
  module: string | null;
  task_id: string | null;
  tokens_estimate: number;
  category?: string;
  rollup_of_task?: string | null;
}

export interface RefRowInput extends RefInput {
  target_ulid?: string | null;
}

/**
 * Next local E-number (D2). Self-heals a missing counter row and never falls
 * behind max(id), so a restored or hand-edited DB can't hand out a duplicate.
 * Replaced by the central allocator later (E-648).
 */
export function nextEntryNumber(db: DB): number {
  db.prepare(
    `INSERT OR IGNORE INTO local_counters (name, value) SELECT 'entry_number', COALESCE(MAX(id), 0) FROM entries`,
  ).run();
  const row = db
    .prepare(
      `UPDATE local_counters
          SET value = MAX(value, (SELECT COALESCE(MAX(id), 0) FROM entries)) + 1
        WHERE name = 'entry_number'
      RETURNING value`,
    )
    .get() as { value: number };
  return row.value;
}

function run(db: DB, cols: string[], values: Record<string, unknown>) {
  const bind = Object.fromEntries(cols.map((c) => [c, values[c]]));
  return db
    .prepare(`INSERT INTO entries (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`)
    .run(bind);
}

export function insertEntryRow(db: DB, row: EntryRowInput): InsertedEntry {
  const cols = [
    "type", "kind", "title", "summary", "description", "status",
    "agent", "module", "task_id", "tokens_estimate", "rollup_of_task",
  ];
  const values: Record<string, unknown> = { ...row, rollup_of_task: row.rollup_of_task ?? null };
  if (row.category !== undefined) cols.push("category");

  if (hasUlidPrimaryKey(db)) {
    const ulid = newUlid();
    const id = nextEntryNumber(db);
    cols.push("ulid", "author", "id");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id });
    return { id, ulid };
  }
  if (hasUlidColumns(db)) {
    const ulid = newUlid();
    cols.push("ulid", "author");
    const r = run(db, cols, { ...values, ulid, author: resolveAuthor() });
    return { id: Number(r.lastInsertRowid), ulid };
  }
  const r = run(db, cols, values);
  return { id: Number(r.lastInsertRowid), ulid: null };
}

/** Inserts refs; returns how many rows were actually new (INSERT OR IGNORE). */
export function insertRefs(db: DB, owner: InsertedEntry, refs: RefRowInput[]): number {
  if (refs.length === 0) return 0;
  let changed = 0;
  if (owner.ulid !== null) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of refs) changed += stmt.run(owner.ulid, owner.id, r.ref_type, r.ref_value, r.target_ulid ?? null).changes;
  } else {
    const stmt = db.prepare(`INSERT OR IGNORE INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)`);
    for (const r of refs) changed += stmt.run(owner.id, r.ref_type, r.ref_value).changes;
  }
  return changed;
}

export function insertEntryModules(db: DB, owner: InsertedEntry, modules: string[], primary: string | null): void {
  if (modules.length === 0) return;
  if (owner.ulid !== null) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, ?, ?, ?)`,
    );
    for (const m of modules) stmt.run(owner.ulid, owner.id, m, m === primary ? 1 : 0);
  } else {
    const stmt = db.prepare(`INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, ?)`);
    for (const m of modules) stmt.run(owner.id, m, m === primary ? 1 : 0);
  }
}

/** Resolve an E-number to a live entry. Tombstoned entries are not owners. */
export function ownerOf(db: DB, id: number): InsertedEntry | null {
  if (!hasUlidColumns(db)) {
    const r = db.prepare(`SELECT id FROM entries WHERE id = ?`).get(id) as { id: number } | undefined;
    return r ? { id: r.id, ulid: null } : null;
  }
  const r = db
    .prepare(`SELECT id, ulid FROM entries WHERE id = ? AND ${liveEntry(db, "entries")} ORDER BY ulid LIMIT 1`)
    .get(id) as { id: number; ulid: string } | undefined;
  return r ? { id: r.id, ulid: r.ulid } : null;
}

export function deleteRef(db: DB, owner: InsertedEntry, ref: RefInput): number {
  return owner.ulid !== null
    ? db.prepare(`DELETE FROM refs WHERE entry_ulid = ? AND ref_type = ? AND ref_value = ?`)
        .run(owner.ulid, ref.ref_type, ref.ref_value).changes
    : db.prepare(`DELETE FROM refs WHERE entry_id = ? AND ref_type = ? AND ref_value = ?`)
        .run(owner.id, ref.ref_type, ref.ref_value).changes;
}

/** Replace ALL of an entry's refs and module rows (the REST upsert's edit semantics). */
export function replaceLinks(
  db: DB, owner: InsertedEntry, modules: string[], primary: string | null, refs: RefRowInput[],
): void {
  if (owner.ulid !== null) {
    db.prepare(`DELETE FROM refs WHERE entry_ulid = ?`).run(owner.ulid);
    db.prepare(`DELETE FROM entry_modules WHERE entry_ulid = ?`).run(owner.ulid);
  } else {
    db.prepare(`DELETE FROM refs WHERE entry_id = ?`).run(owner.id);
    db.prepare(`DELETE FROM entry_modules WHERE entry_id = ?`).run(owner.id);
  }
  insertEntryModules(db, owner, modules, primary);
  insertRefs(db, owner, refs);
}
```

- [ ] **Step 6: Route `addEntry` through it.** In `core/src/ops/add.ts`, delete lines 129–200 (from the comment `// Pre-0005 DBs (staged migration not yet applied)` through the closing `});` of `tx`) and put this in their place:

```ts
  const tx = db.transaction((a: AddEntryArgs) => {
    const owner = insertEntryRow(db, {
      type: a.type,
      kind,
      title: a.title,
      summary: a.summary,
      description: a.description ?? null,
      status: a.status ?? "active",
      agent: a.agent ?? null,
      module: primaryModule,
      task_id: a.task_id ?? null,
      tokens_estimate: tokens,
      category,
    });
    insertEntryModules(db, owner, orderedModules, primaryModule);
    insertRefs(db, owner, a.refs ?? []);
    return owner.id;
  });
```

Change the imports at the top of `add.ts`: remove `hasUlidColumns` from the `../db.js` import, delete the `newUlid` and `resolveAuthor` imports, and add:

```ts
import { insertEntryRow, insertEntryModules, insertRefs } from "../entry-write.js";
```

- [ ] **Step 7: Route both rollup inserts through it.** In `core/src/ops/rollup.ts`, in `rollup()` delete the `withUlid` / `insertRollup` block (the lines from `// rollup.ts owns its own insert path` through the end of the `db.prepare(...)` call). Inside `runGroup`, replace everything from `const result = insertRollup.run(` through the end of the `// 1. Batch insert refs` loop with:

```ts
    // rollup.ts owns its own insert path because addEntry() rejects type='rollup'.
    const owner = insertEntryRow(db, {
      type: "rollup",
      kind: "signal",
      status: "active",
      ...rollupParams,
    });
    const newId = owner.id;

    // 1. Link the rollup to its originals (trigger/backfill resolve target_ulid).
    insertRefs(db, owner, group.entry_ids.map((id) => ({ ref_type: "entry" as const, ref_value: String(id) })));
```

Make the identical change in `archive()`: delete its `withUlid` / `insertRollup` block, and replace everything from `const result = insertRollup.run(` through the end of the `// Link the breadcrumb` loop with:

```ts
    const owner = insertEntryRow(db, {
      type: "rollup",
      kind: "signal",
      status: "active",
      task_id: null,
      ...archiveParams,
    });
    const newId = owner.id;

    // Link the breadcrumb to the originals it archived.
    insertRefs(db, owner, group.entry_ids.map((id) => ({ ref_type: "entry" as const, ref_value: String(id) })));
```

Leave the "deprecate originals" loops unchanged. Ids are unique locally until sync lands (see "What this plan deliberately does not do"). Remove `hasUlidColumns`, `newUlid` and `resolveAuthor` from rollup.ts's imports if they are now unused, and add `import { insertEntryRow, insertRefs } from "../entry-write.js";`.

In `core/src/index.ts` add:
```ts
export * from './schema.js';
export * from './entry-write.js';
```

- [ ] **Step 8: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/entry-write.test.ts test/migrate-0005.test.ts test/migrate-0006.test.ts`
Expected: PASS at both levels. 0005's `inserts work on a pre-0005 DB` test (if present) must still pass, which proves the pre-0005 branch of `insertEntryRow`.

- [ ] **Step 9: Checkpoint: user commits** (suggested: `refactor(core): one schema-aware write path for entries and links (0005 + 0006)`)

---

### Task 4: Update, refs, supersede, delete, and the startup backfill

**Files:**
- Modify: `core/src/ops/update.ts`, `core/src/ops/supersede.ts`, `core/src/backfill.ts`, `core/src/index.ts`
- Create: `core/src/ops/delete.ts`
- Test: `core/test/write-paths-0006.test.ts`

**Interfaces:**
- Consumes: `ownerOf`, `insertRefs`, `deleteRef`, `liveEntry`, `hasUlidPrimaryKey`, `hasUlidColumns`.
- Produces: `deleteEntry(db: DB, id: number): { id: number; tombstoned: boolean }` (throws `no entry found with id N`); `BackfillReport.unresolvedEntryRefs: Array<{ entry_id: number | null; entry_ulid: string | null; ref_value: string }>`.

- [ ] **Step 1: Write the failing tests** in `core/test/write-paths-0006.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { updateEntry, updateEntryRefs } from '../src/ops/update.js';
import { supersede } from '../src/ops/supersede.js';
import { deleteEntry } from '../src/ops/delete.js';
import { backfillUlids } from '../src/backfill.js';
import { newUlid } from '../src/ulid.js';

const ulidOf = (db: any, id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid;

testAtEachLevel('updateEntryRefs adds and removes by ulid', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  const b = addEntry(db, { type: 'decision', title: 'b', summary: 's' }).id;
  const r1 = updateEntryRefs(db, { id: b, add: [{ ref_type: 'entry', ref_value: String(a) }] });
  assert.equal(r1.added.length, 1);
  const link = db.prepare(`SELECT entry_ulid, target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
  assert.deepEqual(link, { entry_ulid: ulidOf(db, b), target_ulid: ulidOf(db, a) });
  const r2 = updateEntryRefs(db, { id: b, remove: [{ ref_type: 'entry', ref_value: String(a) }] });
  assert.equal(r2.removed.length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM refs`).get() as any).c, 0);
});

testAtEachLevel('supersede sets superseded_by_ulid', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  const b = addEntry(db, { type: 'decision', title: 'b', summary: 's' }).id;
  supersede(db, { ids: [a], by: b });
  const row = db.prepare(`SELECT superseded_by, superseded_by_ulid, deprecated FROM entries WHERE id = ?`).get(a) as any;
  assert.deepEqual(row, { superseded_by: b, superseded_by_ulid: ulidOf(db, b), deprecated: 1 });
});

testAtEachLevel('deleteEntry: tombstone at 0006, hard delete before', (db, level) => {
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', refs: [{ ref_type: 'file', ref_value: 'f' }] }).id;
  const res = deleteEntry(db, a);
  if (level === '0006') {
    assert.equal(res.tombstoned, true);
    const row = db.prepare(`SELECT deleted_at FROM entries WHERE id = ?`).get(a) as any;
    assert.ok(row.deleted_at, 'row kept, deleted_at set');
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM refs`).get() as any).c, 1, 'refs kept for sync');
    assert.throws(() => deleteEntry(db, a), /no entry found/);
  } else {
    assert.equal(res.tombstoned, false);
    assert.equal(db.prepare(`SELECT 1 FROM entries WHERE id = ?`).get(a), undefined);
  }
});

test('updateEntry refuses a tombstoned entry', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's' }).id;
    deleteEntry(db, a);
    assert.throws(() => updateEntry(db, { id: a, title: 'x' }), /no entry found/);
  } finally { cleanup(); }
});

test('backfill never stamps author after 0006 (E-685 #7)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, author) VALUES (?, 900, 'handoff', 'signal', 'synced', 's', NULL)`).run(newUlid());
    backfillUlids(db);
    assert.equal((db.prepare(`SELECT author FROM entries WHERE id = 900`).get() as any).author, null);
  } finally { cleanup(); }
});

testAtEachLevel('backfill resolves a link once its target appears', (db) => {
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', refs: [{ ref_type: 'entry', ref_value: 'E-777' }] }).id;
  assert.equal(backfillUlids(db).unresolvedEntryRefs.length, 1);
  const lateUlid = newUlid();
  db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, 777, 'handoff', 'signal', 'late', 's')`).run(lateUlid);
  const report = backfillUlids(db);
  assert.equal(report.unresolvedEntryRefs.length, 0);
  const link = db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ?`).get(ulidOf(db, a)) as any;
  assert.equal(link.target_ulid, lateUlid);
});
```

Note: at `[0005]`, the raw insert in the last test passes `ulid` and `id` explicitly. That is legal at 0005 (`id` is the INTEGER PK, `ulid` a plain column).

- [ ] **Step 2: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/write-paths-0006.test.ts`
Expected: FAIL (`delete.js` missing; supersede at 0006 leaves `superseded_by_ulid` NULL because the new trigger only repairs; backfill stamps author).

- [ ] **Step 3: Implement `core/src/ops/delete.ts`**

```ts
import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";

/**
 * After 0006: a tombstone (deleted_at). The row, its refs and its module rows
 * stay, so the delete can travel as data when sync lands. Before 0006: the
 * legacy hard delete (cascade triggers remove refs/module rows).
 */
export function deleteEntry(db: DB, id: number): { id: number; tombstoned: boolean } {
  if (!Number.isInteger(id) || id < 1) throw new Error("id must be a positive integer");
  if (hasUlidPrimaryKey(db)) {
    const info = db
      .prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
      .run(id);
    if (info.changes === 0) throw new Error(`no entry found with id ${id}`);
    return { id, tombstoned: true };
  }
  const info = db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
  if (info.changes === 0) throw new Error(`no entry found with id ${id}`);
  return { id, tombstoned: false };
}
```

Add `export * from './ops/delete.js';` to `core/src/index.ts`.

- [ ] **Step 4: `core/src/ops/update.ts`**

In `updateEntry`, change the UPDATE statement to skip tombstones:

```ts
  const info = db
    .prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = @id AND ${liveEntry(db, "entries")}`)
    .run(params);
```

In `updateEntryRefs`, replace everything from `const exists = db.prepare(` through the end of `tx();` with:

```ts
  const owner = ownerOf(db, args.id);
  if (!owner) throw new Error(`no entry found with id ${args.id}`);

  const added: RefInput[] = [];
  const removed: RefInput[] = [];

  const tx = db.transaction(() => {
    for (const r of toRemove) {
      if (deleteRef(db, owner, r) > 0) removed.push(r);
    }
    for (const r of toAdd) {
      if (insertRefs(db, owner, [r]) > 0) added.push(r);
    }
  });
  tx();
```

Add these imports:
```ts
import { liveEntry } from "../schema.js";
import { ownerOf, insertRefs, deleteRef } from "../entry-write.js";
```

- [ ] **Step 5: `core/src/ops/supersede.ts`.** Replace everything from `// 'by' must exist.` to the end of the function with:

```ts
  // 'by' must exist (and not be tombstoned).
  const byOwner = ownerOf(db, by);
  if (!byOwner) {
    throw new Error(`'by' entry ${toEntryId(by)} does not exist`);
  }

  // 'by' must not supersede itself.
  if (ids.includes(by)) {
    throw new Error(`'by' (${toEntryId(by)}) cannot be one of the superseded 'ids'`);
  }

  // Every id must exist.
  const uniqueIds = [...new Set(ids)];
  const missing = uniqueIds.filter((id) => ownerOf(db, id) === null);
  if (missing.length > 0) {
    throw new Error(
      `the following 'ids' do not exist: ${missing.map(toEntryId).join(", ")}`,
    );
  }

  // Write the ULID twin ourselves; 0006's trigger only repairs legacy writers.
  const update = hasUlidColumns(db)
    ? db.prepare(`UPDATE entries SET superseded_by = ?, superseded_by_ulid = ?, deprecated = 1 WHERE id = ?`)
    : db.prepare(`UPDATE entries SET superseded_by = ?, deprecated = 1 WHERE id = ?`);
  const tx = db.transaction((targetIds: number[]) => {
    for (const id of targetIds) {
      if (hasUlidColumns(db)) update.run(by, byOwner.ulid, id);
      else update.run(by, id);
    }
  });
  tx(uniqueIds);

  return { superseded: uniqueIds, by };
```

Add imports: `import { hasUlidColumns } from "../db.js";` and `import { ownerOf } from "../entry-write.js";`.

- [ ] **Step 6: `core/src/backfill.ts`**

Replace the author block:

```ts
    // Author is stamped ONCE, by the 0006 pre-flight (E-685 #7). After 0006 a
    // NULL author means "arrived without one" (e.g. synced) and must stay NULL.
    const author = hasUlidPrimaryKey(db) ? null : resolveAuthor();
    const authors = author
      ? db.prepare(`UPDATE entries SET author = ? WHERE author IS NULL`).run(author).changes
      : 0;
```

Replace the "Entry links" block (from `const pending = db` through the end of its `for` loop) with a version keyed by `entry_ulid`:

```ts
    // Entry links: parsed in JS with the same rules as the SQL trigger. Keyed by
    // entry_ulid (filled for every row from 0005 on); id is only a label (E-648),
    // so the lowest ulid wins if two entries ever share a number.
    const pending = db
      .prepare(
        `SELECT entry_id, entry_ulid, ref_value FROM refs
          WHERE ref_type = 'entry' AND target_ulid IS NULL
          ORDER BY entry_ulid, ref_value`,
      )
      .all() as Array<{ entry_id: number | null; entry_ulid: string | null; ref_value: string }>;
    const ulidOf = db.prepare(`SELECT ulid FROM entries WHERE id = ? ORDER BY ulid LIMIT 1`);
    const setTarget = db.prepare(
      `UPDATE refs SET target_ulid = ? WHERE entry_ulid = ? AND ref_type = 'entry' AND ref_value = ?`,
    );
    const unresolvedEntryRefs: BackfillReport["unresolvedEntryRefs"] = [];
    for (const r of pending) {
      const id = parseEntryRef(r.ref_value);
      const hit = id === null ? undefined : (ulidOf.get(id) as { ulid: string | null } | undefined);
      if (hit?.ulid && r.entry_ulid) setTarget.run(hit.ulid, r.entry_ulid, r.ref_value);
      else unresolvedEntryRefs.push(r);
    }
```

Change the interface field to `unresolvedEntryRefs: Array<{ entry_id: number | null; entry_ulid: string | null; ref_value: string }>;` and add `import { hasUlidPrimaryKey } from "./schema.js";`.

The remaining `refs` / `entry_modules` / `superseded` fill statements stay. At 0006 they match zero rows, because the columns are NOT NULL or already filled.

- [ ] **Step 7: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/write-paths-0006.test.ts test/entry-write.test.ts test/migrate-0005.test.ts test/migrate-0006.test.ts`
Expected: PASS.

- [ ] **Step 8: Checkpoint: user commits** (suggested: `feat(core): tombstone deletes; ulid-keyed refs/supersede/backfill (E-685 #2, #7)`)

---

### Task 5: Read paths: FTS join, membership by ulid, tombstone filter

**Files:**
- Modify: `core/src/ops/search.ts:100-140`, `core/src/ops/get.ts`, `core/src/ops/module.ts:110-150`, `core/src/ops/task.ts:~233`, `core/src/ops/export.ts:150-200`, `core/src/ops/rollup.ts:73-99` and `:330-345`
- Test: `core/test/read-paths-0006.test.ts`

**Interfaces:**
- Consumes: `liveEntry`, `ftsJoin`, `deleteEntry`.
- Produces: `EntryFull` gains `ulid?: string; deleted_at?: string | null` (via `SELECT *`); export rows gain `ulid`.

- [ ] **Step 1: Write the failing tests** in `core/test/read-paths-0006.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { deleteEntry } from '../src/ops/delete.js';
import { searchEntries } from '../src/ops/search.js';
import { listRecent } from '../src/ops/list-recent.js';
import { getEntry } from '../src/ops/get.js';
import { getModule } from '../src/ops/module.js';
import { getTask } from '../src/ops/task.js';
import { exportEntries } from '../src/ops/export.js';
import { rollup, archive } from '../src/ops/rollup.js';

const search = (db: any, query: string, extra: object = {}) =>
  searchEntries(db, { query, kind: 'any', include_deprecated: false, limit: 50, ...extra } as any).results.map((r: any) => r.id);

testAtEachLevel('readers find an entry by text, module and task, with its links', (db) => {
  db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`).run();
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-002', 't')`).run();
  const a = addEntry(db, { type: 'decision', title: 'quokka decision', summary: 's', module: 'm1', task_id: 'T-002',
    refs: [{ ref_type: 'file', ref_value: 'q.ts' }] }).id;
  assert.deepEqual(search(db, 'quokka'), [a]);
  assert.deepEqual(search(db, 'quokka', { module: 'm1' }), [a]);
  assert.deepEqual(getModule(db, 'm1').recent_decisions.map((r: any) => r.id), [a]);
  assert.deepEqual(getTask(db, 'T-002').recent_entries.map((r: any) => r.id), [a]);
  const full = getEntry(db, a)!;
  assert.deepEqual(full.refs, [{ ref_type: 'file', ref_value: 'q.ts' }]);
  assert.deepEqual(full.modules, ['m1']);
  const exported = exportEntries(db, { format: 'json' } as any) as any;
  const row = JSON.stringify(exported);
  assert.ok(row.includes('q.ts') && row.includes('quokka decision'));
});

test('a tombstoned entry disappears from every list but stays readable by number', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`).run();
    db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-003', 't')`).run();
    const keep = addEntry(db, { type: 'decision', title: 'wombat keep', summary: 's', module: 'm1', task_id: 'T-003' }).id;
    const gone = addEntry(db, { type: 'decision', title: 'wombat gone', summary: 's', module: 'm1', task_id: 'T-003' }).id;
    deleteEntry(db, gone);

    assert.deepEqual(search(db, 'wombat'), [keep], 'FTS search');
    assert.ok(!listRecent(db, { kind: 'any', since: '1d' } as any).results.some((r: any) => r.id === gone), 'list_recent');
    assert.ok(!getModule(db, 'm1').recent_decisions.some((r: any) => r.id === gone), 'module card');
    assert.ok(!getTask(db, 'T-003').recent_entries.some((r: any) => r.id === gone), 'task card');
    assert.ok(!JSON.stringify(exportEntries(db, { format: 'json' } as any)).includes('wombat gone'), 'export');
    const dry = rollup(db, { task_id: 'T-003', dry_run: true } as any);
    assert.ok(!dry.groups.some((g: any) => g.entry_ids.includes(gone)), 'rollup selection');
    db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00', type = 'handoff', category = 'Activity'`).run();
    const adry = archive(db, { older_than: '30d', dry_run: true } as any);
    assert.ok(!adry.groups.some((g: any) => g.entry_ids.includes(gone)), 'archive selection');

    const full = getEntry(db, gone)!;                    // D5b: still readable by number
    assert.ok(full && (full as any).deleted_at, 'getEntry returns the tombstone with deleted_at');
    db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);
  } finally { cleanup(); }
});
```

If `exportEntries`'s argument or return shape differs from `{ format: 'json' }`, check `ExportArgs` in `core/src/ops/export.ts` and pass its minimal valid argument. The assertion is on the serialized result, so the exact shape does not matter.

- [ ] **Step 2: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/read-paths-0006.test.ts`
Expected: FAIL at `[0006]` (the FTS join uses `rowid`; module/task/export/list still return the tombstone).

- [ ] **Step 3: `search.ts`.** Import `import { liveEntry, ftsJoin } from "../schema.js";`. After the `include_deprecated` block add:

```ts
  where.push(liveEntry(db, "e")); // tombstones never appear in search or list_recent
```

Change the module filter line to:

```ts
  if (args.module)   { where.push("e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)"); params.push(args.module); }
```

In the FTS SQL, replace the two lines `FROM entries_fts` / `JOIN entries e ON e.id = entries_fts.rowid` with:

```ts
      FROM entries_fts
      ${ftsJoin(db, "e")}
```

- [ ] **Step 4: `get.ts`.** Add `import { hasUlidPrimaryKey } from "../schema.js";`, add `ulid?: string;` and `deleted_at?: string | null;` to the `EntryFull` interface, and replace the body of `getEntry` with:

```ts
export function getEntry(db: DB, id: number): EntryFull | null {
  // A tombstoned entry is still returned, with deleted_at set (decision D5b):
  // links like E-214 keep showing what they pointed at. If an E-number is
  // ever shared, prefer the live entry, then the lowest ulid. (deleted_at only
  // exists from 0006 on.)
  const order = hasUlidPrimaryKey(db) ? "ORDER BY deleted_at IS NOT NULL, ulid" : "";
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ? ${order} LIMIT 1`)
    .get(id) as (Omit<EntryFull, "refs" | "modules"> & { ulid: string }) | undefined;
  if (!row) return null;

  const refs = db
    .prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_ulid = ? ORDER BY ref_type, ref_value`)
    .all(row.ulid) as EntryRef[];

  const modules = (
    db
      .prepare(`SELECT module FROM entry_modules WHERE entry_ulid = ? ORDER BY is_primary DESC, module ASC`)
      .all(row.ulid) as Array<{ module: string }>
  ).map((m) => m.module);

  return { ...row, modules, refs };
}
```

- [ ] **Step 5: `module.ts`.** At the top of `getModule`, after `module` is loaded, add `const live = liveEntry(db, "entries");`. In all four entry queries (indexes, recent_decisions, top_gotchas, recent_handoffs), replace

```sql
    WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)
```
with
```ts
    WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
```

(Each query is a template literal, so `${live}` interpolates.) Import `liveEntry` from `../schema.js`.

- [ ] **Step 6: `task.ts` `getTask`.** Change `WHERE task_id = ? AND deprecated = 0` to `` WHERE task_id = ? AND deprecated = 0 AND ${liveEntry(db, "entries")} `` and import `liveEntry`.

- [ ] **Step 7: `export.ts`.** Before building `sql`, add `where.push(liveEntry(db, "entries"));`. Add `ulid` to the SELECT list (first column), and add `ulid: string` to `ExportEntryRow`. Replace the block from `const ids = rows.map((r) => r.id);` through the end of the module-rows loop with:

```ts
  const ulids = rows.map((r) => r.ulid);
  const refsByUlid = new Map<string, Array<{ ref_type: string; ref_value: string }>>();
  const modulesByUlid = new Map<string, string[]>();
  if (ulids.length > 0) {
    const placeholders = ulids.map(() => "?").join(",");
    const refRows = db
      .prepare(
        `SELECT entry_ulid, ref_type, ref_value FROM refs WHERE entry_ulid IN (${placeholders}) ORDER BY entry_ulid ASC, ref_type ASC, ref_value ASC`,
      )
      .all(...ulids) as Array<{ entry_ulid: string; ref_type: string; ref_value: string }>;
    for (const rr of refRows) {
      const list = refsByUlid.get(rr.entry_ulid) ?? [];
      list.push({ ref_type: rr.ref_type, ref_value: rr.ref_value });
      refsByUlid.set(rr.entry_ulid, list);
    }

    const moduleRows = db
      .prepare(
        `SELECT entry_ulid, module FROM entry_modules WHERE entry_ulid IN (${placeholders}) ORDER BY entry_ulid ASC, is_primary DESC, module ASC`,
      )
      .all(...ulids) as Array<{ entry_ulid: string; module: string }>;
    for (const mr of moduleRows) {
      const list = modulesByUlid.get(mr.entry_ulid) ?? [];
      list.push(mr.module);
      modulesByUlid.set(mr.entry_ulid, list);
    }
  }
```

Then everywhere below it in `exportEntries`, replace `refsByEntryId.get(r.id)` with `refsByUlid.get(r.ulid)` and `modulesByEntryId.get(r.id)` with `modulesByUlid.get(r.ulid)` (grep the file for `ByEntryId`, which must end with 0 matches). Delete the now-unused `RefRow` / `ModuleRow` types if nothing else uses them. The old `ids` code did not chunk its `IN (...)` list, so neither does this one (parity). better-sqlite3's bundled SQLite allows 32,766 parameters, far beyond the 10k-entry target.

- [ ] **Step 8: `rollup.ts` selection.** In both queries in `selectEntries`, and in the archive `sql` string, add this line after `AND deprecated = 0`:

```ts
         AND ${liveEntry(db, "entries")}
```

(These are template literals; `archive`'s `sql` uses a backtick string, so interpolate the same way.) Import `liveEntry`.

- [ ] **Step 9: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/read-paths-0006.test.ts test/entry-write.test.ts test/write-paths-0006.test.ts`
Expected: PASS at both levels.

- [ ] **Step 10: Checkpoint: user commits** (suggested: `feat(core): reads join by ulid and hide tombstones (0005 + 0006)`)

---

### Task 6: Doctor knows 0006, and the false "orphan entry refs" are gone

**Files:**
- Modify: `core/src/ops/doctor.ts`
- Test: `core/test/doctor-0006.test.ts`

**Interfaces:**
- Consumes: `parseEntryRef`, `testAtEachLevel`.
- Produces: doctor check names `data.duplicate_entry_ids` (warn), `data.tombstones` (ok, informational), `fts.integrity` (error on failure), in addition to the existing ones. `data.orphan_refs.entry` is rebased on `parseEntryRef`.

- [ ] **Step 1: Write the failing tests** in `core/test/doctor-0006.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { deleteEntry } from '../src/ops/delete.js';
import { doctor } from '../src/ops/doctor.js';
import { newUlid } from '../src/ulid.js';

const check = (db: any, name: string) => doctor(db).checks.find((c) => c.name === name)!;

testAtEachLevel('a fresh DB is healthy at every level', (db) => {
  const r = doctor(db);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.severity !== 'ok')));
  for (const n of ['schema.tables', 'schema.indexes', 'schema.triggers', 'fts.integrity']) {
    assert.equal(check(db, n).severity, 'ok', n);
  }
});

// Regression for the 144 false positives: CAST('E-214' AS INTEGER) = 0.
testAtEachLevel('E- and # links to existing entries are not orphans', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  addEntry(db, { type: 'decision', title: 'b', summary: 's', refs: [
    { ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'entry', ref_value: `#${a}` },
    { ref_type: 'entry', ref_value: `E-${String(a).padStart(5, '0')}` }] });
  assert.equal(check(db, 'data.orphan_refs.entry').severity, 'ok');
  addEntry(db, { type: 'decision', title: 'c', summary: 's', refs: [{ ref_type: 'entry', ref_value: 'E-99999' }] });
  assert.equal(check(db, 'data.orphan_refs.entry').severity, 'warn');
});

test('duplicate E-numbers and tombstones are reported at 0006', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's' }).id;
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, ?, 'handoff', 'signal', 'dup', 's')`).run(newUlid(), a);
    assert.equal(check(db, 'data.duplicate_entry_ids').severity, 'warn');
    deleteEntry(db, a);
    assert.match(check(db, 'data.tombstones').detail, /1 tombstoned/);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/doctor-0006.test.ts`
Expected: FAIL (`fts.integrity` missing; the 0006 schema sets are unknown, so `schema.*` reports missing/extra; the E- links are reported as orphans).

- [ ] **Step 3: Implement.** In `core/src/ops/doctor.ts`, add the 0006 sets below the 0005 sets. They are **complete** sets, because 0006 rebuilds the objects instead of adding to them:

```ts
// Migration 0006 rebuilds entries/refs/entry_modules/tasks/modules and the FTS
// table, so its expected objects are a complete list, not a delta.
const EXPECTED_TABLES_0006 = new Set([
  "entries", "refs", "tasks", "modules", "dispatches", "entry_modules", "schema_migrations",
  "entries_fts", "entries_fts_config", "entries_fts_content", "entries_fts_data",
  "entries_fts_docsize", "entries_fts_idx", "sqlite_sequence", "entry_revisions", "local_counters",
]);

const EXPECTED_INDEXES_0006 = new Set([
  "idx_entries_id", "idx_entries_type", "idx_entries_module", "idx_entries_task",
  "idx_entries_created", "idx_entries_kind", "idx_entries_status", "idx_entries_deprecated",
  "idx_entries_category", "idx_entries_superseded",
  "idx_refs_value", "idx_refs_type", "idx_refs_target_ulid",
  "idx_entry_modules_module",
  "idx_tasks_status", "idx_tasks_module", "idx_tasks_assignee",
  "idx_dispatches_agent", "idx_dispatches_module", "idx_dispatches_created", "idx_dispatches_entry",
  "idx_entry_revisions_entry",
]);

const EXPECTED_TRIGGERS_0006 = new Set([
  "trg_entries_updated_at", "trg_entries_fts_ai", "trg_entries_fts_ad", "trg_entries_fts_au",
  "trg_entries_ulid_immutable", "trg_entries_fill_superseded_ulid", "trg_entries_revision",
  "trg_refs_fill_target_ulid", "trg_refs_cascade_delete", "trg_entry_modules_cascade_delete",
  "trg_tasks_updated_at", "trg_modules_updated_at",
  "trg_dispatches_updated_at", "trg_dispatches_updated_at_insert",
]);
```

Add `import { parseEntryRef } from "../ulid.js";`. In `doctor()`, replace the `has0005` detection and the three `expected*` lines with:

```ts
  const applied = (version: string): boolean => {
    try {
      return !!db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(version);
    } catch {
      return false;
    }
  };
  const has0005 = applied("0005_ulid_expand");
  const has0006 = applied("0006_ulid_contract");

  const expectedTables = has0006 ? EXPECTED_TABLES_0006
    : has0005 ? union(EXPECTED_TABLES, EXPECTED_TABLES_0005) : EXPECTED_TABLES;
  const expectedIndexes = has0006 ? EXPECTED_INDEXES_0006
    : has0005 ? union(EXPECTED_INDEXES, EXPECTED_INDEXES_0005) : EXPECTED_INDEXES;
  const expectedTriggers = has0006 ? EXPECTED_TRIGGERS_0006
    : has0005 ? union(EXPECTED_TRIGGERS, EXPECTED_TRIGGERS_0005) : EXPECTED_TRIGGERS;
```

Replace check **5) data.orphan_refs.entry** (the query and its `checks.push`) with a JS-parsed version:

```ts
  // 5) data.orphan_refs.entry: parsed with the same rules as the link triggers.
  //    The old SQL used CAST(ref_value AS INTEGER), which is 0 for "E-214" and
  //    "#116", so every non-numeric link was reported as an orphan (144 false
  //    positives on the real DB, 2026-09-29).
  const liveIds = new Set(
    (db.prepare(`SELECT id FROM entries WHERE id IS NOT NULL`).all() as Array<{ id: number }>).map((r) => r.id),
  );
  const orphanEntryRefs = (
    db.prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type = 'entry' ORDER BY entry_id ASC, ref_value ASC`)
      .all() as Array<{ entry_id: number | null; ref_value: string }>
  ).filter((r) => {
    const target = parseEntryRef(r.ref_value);
    return target === null || !liveIds.has(target);
  });
  checks.push({
    name: "data.orphan_refs.entry",
    severity: orphanEntryRefs.length > 0 ? "warn" : "ok",
    detail:
      orphanEntryRefs.length > 0
        ? `found ${orphanEntryRefs.length} orphan entry ref(s)`
        : "no orphan entry refs",
    items:
      orphanEntryRefs.length > 0
        ? orphanEntryRefs.map((r) => `${toEntryId(r.entry_id ?? 0)} -> ${r.ref_value}`)
        : undefined,
  });
```

In the existing **data.entries_without_module** check, change `id NOT IN (SELECT entry_id FROM entry_modules)` to `ulid NOT IN (SELECT entry_ulid FROM entry_modules)` when `has0005`, and keep the old form otherwise (pre-0005 has no `entry_ulid`):

```ts
  const withoutModuleSql = has0005
    ? `SELECT id FROM entries WHERE deprecated = 0 AND ulid NOT IN (SELECT entry_ulid FROM entry_modules WHERE entry_ulid IS NOT NULL) ORDER BY id`
    : `SELECT id FROM entries WHERE deprecated = 0 AND id NOT IN (SELECT entry_id FROM entry_modules) ORDER BY id`;
```

Just before the FTS checks, add:

```ts
  if (has0006) {
    const dupIds = db
      .prepare(`SELECT id, COUNT(*) AS n FROM entries WHERE id IS NOT NULL GROUP BY id HAVING n > 1 ORDER BY id`)
      .all() as Array<{ id: number; n: number }>;
    checks.push({
      name: "data.duplicate_entry_ids",
      severity: dupIds.length > 0 ? "warn" : "ok",
      detail: dupIds.length > 0 ? `${dupIds.length} E-number(s) used by more than one entry` : "every E-number is unique",
      items: dupIds.length > 0 ? dupIds.map((r) => `${toEntryId(r.id)} x${r.n}`) : undefined,
    });
    const tomb = (db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NOT NULL`).get() as { c: number }).c;
    checks.push({ name: "data.tombstones", severity: "ok", detail: `${tomb} tombstoned entr${tomb === 1 ? "y" : "ies"}` });
  }

  // fts.integrity: row-count parity cannot see a corrupted index (E-684).
  // The strict form (rank = 1) also compares against the content table; it
  // passed on the live 0005 index on 2026-09-29, so "error" is safe to ship.
  // Several sessions + the REST server share the file: a lock is not corruption.
  let ftsIntegrity = "ok";
  let ftsBusy = false;
  try {
    db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);
  } catch (e) {
    ftsIntegrity = (e as Error).message;
    ftsBusy = (e as { code?: string }).code === "SQLITE_BUSY" || (e as { code?: string }).code === "SQLITE_LOCKED";
  }
  checks.push({
    name: "fts.integrity",
    severity: ftsIntegrity === "ok" ? "ok" : ftsBusy ? "warn" : "error",
    detail:
      ftsIntegrity === "ok" ? "fts index consistent"
        : ftsBusy ? `fts integrity-check skipped: database busy (${ftsIntegrity}); rerun doctor`
        : `fts integrity-check failed: ${ftsIntegrity}`,
  });
```

- [ ] **Step 4: Run the tests and confirm they pass** (background subagent)

Run: `cd internal-tools/core && npx tsx --test test/doctor-0006.test.ts test/migrate-0005.test.ts`
Expected: PASS. 0005's doctor tests must still pass (pre-0006 branch).

- [ ] **Step 5: Checkpoint: user commits** (suggested: `fix(core): doctor knows 0006; link check no longer flags E-/# refs (D10)`)

---

### Task 7: REST server: no `rowid`, writes through core, doctor through core

**Files:**
- Modify: `server/src/tools/collab.ts`
- Modify: `test/helpers/server.mjs`, `test/api.upsert.test.mts:24,38` (reads by `rowid`), `test/api.reassign-module.test.mts:29,44,50` (reads/writes `entry_id`), every `seedEntry(` caller including `test/golden/rest.golden.test.mts:19-21`
- Create: `test/api.contract-0005.test.mts`, `test/api.contract-0006.test.mts`. These are **two files**: `server.js` is imported once per process and `tools/collab.ts` binds its DB when it loads, so a second `startTestServer` in the same file would silently reuse the first test's DB.

**Interfaces:**
- Consumes: `addEntry`, `getEntry`, `deleteEntry`, `supersede`, `doctor`, `ownerOf`, `replaceLinks`, `insertEntryModules`, `liveEntry`, `ftsJoin`, `hasUlidColumns`, `migrate`.
- Produces: `startTestServer({ level?: '0005' | '0006' })`; `seedEntry(db, opts)` now uses `addEntry`.

- [ ] **Step 1: Update `test/helpers/server.mjs`**

```js
export async function startTestServer({ level = '0005' } = {}) {
  const tmpFile = path.join(os.tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmpFile;
  process.env.COLLAB_DB_CREATE = '1'; // test DBs are created on purpose
  // dynamic import AFTER env is set so the singleton binds to the temp DB
  const { start } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'server', 'dist', 'server.js')).href);
  const { getDb, migrate } = await import('@collab-mcp/core');
  const { server, port } = await start(0, '127.0.0.1');
  const db = getDb();
  // The server only applies released migrations; opt this DB into staged 0006.
  if (level === '0006') migrate(db, { includeStaged: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(() => {
    for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(tmpFile + s); } catch {} }
    resolve();
  }));
  return { baseUrl, db, close };
}

export async function seedEntry(db, { type = 'decision', category = 'Reference',
  title = 'T', summary = 'S', description = '', agent = 'Claude', module = null,
  deprecated = 0 } = {}) {
  // Through core, so the row is valid at 0005 AND 0006 (ulid, id, author).
  const { addEntry } = await import('@collab-mcp/core');
  const { id } = addEntry(db, { type, category, title, summary, description, agent, module: module ?? undefined });
  if (deprecated) db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(id);
  return id;
}
```

`seedEntry` becomes `async`. Update every existing caller in `test/*.test.mts` from `seedEntry(db, …)` to `await seedEntry(db, …)` (grep `seedEntry(` and make it 0 non-awaited calls). The old `kind` option is dropped because `kind` now always follows `type`. If a test relied on a mismatched `kind`, report it rather than re-adding the option.

After go-live the server applies 0006 itself, so the **existing** API tests will run at 0006. Make them schema-neutral now:
- `api.upsert.test.mts` lines 24 and 38: `WHERE rowid = ?` → `WHERE id = ?`.
- `api.reassign-module.test.mts`: never read the legacy `entry_id` label (D3). Line 29 becomes `srv.db.prepare("SELECT module FROM entry_modules WHERE entry_ulid = (SELECT ulid FROM entries WHERE id = ?) AND module = 'target'").get(id)`. Line 50 gets the same `entry_ulid = (SELECT ulid FROM entries WHERE id = ?)` form. Line 44's raw insert becomes `srv.db.prepare("INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES ((SELECT ulid FROM entries WHERE id = ?), ?, 'target', 0)").run(e3, e3)`.

- [ ] **Step 2: Write the failing REST tests.** Create `test/api.contract-0006.test.mts` with the content below. Then create `test/api.contract-0005.test.mts` as an identical copy with `const level = '0005';`. Each file runs in its own process.

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

const level = '0006';
{
  test(`REST entry lifecycle [${level}]`, async () => {
    const { baseUrl, db, close } = await startTestServer({ level });
    try {
      const post = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const get = (p) => fetch(baseUrl + p).then((r) => r.json());
      db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1'), ('m2', 'M2')`).run();

      const a = await seedEntry(db, { title: 'platypus anchor', module: 'm1' });
      const created = await post('/api/collab/entry/upsert', { type: 'decision', title: 'platypus new', summary: 's', module: 'm1', refs: [{ ref_type: 'entry', ref_value: `E-${a}` }] });
      assert.equal(created.ok, true);
      assert.equal(created.id, a + 1, 'E-number continues');

      const entry = await get(`/api/collab/entry?id=${created.id}`);
      assert.deepEqual(entry.modules, ['m1']);
      assert.deepEqual(entry.refs, [{ ref_type: 'entry', ref_value: `E-${a}` }]);

      await post('/api/collab/entry/upsert', { id: created.id, type: 'decision', title: 'platypus edited', summary: 's', module: 'm2', refs: [] });
      const edited = await get(`/api/collab/entry?id=${created.id}`);
      assert.equal(edited.title, 'platypus edited');
      assert.deepEqual(edited.modules, ['m2']);
      assert.deepEqual(edited.refs, []);

      const found = (await get('/api/collab/search?q=platypus&kind=any')).results.map((r) => r.id).sort();
      assert.deepEqual(found, [a, created.id].sort());

      assert.equal((await post('/api/collab/entry/reassign-module', { ids: [a], module: 'm2' })).updated, 1);
      assert.equal((await post('/api/collab/entry/supersede', { ids: [a], by: created.id })).ok, true);

      await post('/api/collab/entry/delete', { id: created.id });
      const after = (await get('/api/collab/search?q=platypus&kind=any')).results.map((r) => r.id);
      assert.ok(!after.includes(created.id), 'deleted entry hidden from search');
      const stats = await get('/api/collab/stats');
      assert.ok(!stats.recent.some((r) => r.id === created.id), 'deleted entry hidden from stats');

      const doc = await post('/api/collab/doctor', {});
      assert.equal(doc.ok, true, JSON.stringify(doc.checks.filter((c) => c.severity !== 'ok')));
    } finally { await close(); }
  });
}
```

- [ ] **Step 3: User builds the server, then run the test and confirm it fails** (user: `cd internal-tools && npm -w @collab-mcp/server run build`; then background subagent)

Run: `cd internal-tools && npx tsx --test test/api.contract-0005.test.mts test/api.contract-0006.test.mts`
Expected: the 0005 file passes or fails only on the delete/stats assertions. The 0006 file FAILS: the upsert's INSERT has no `ulid`, and `rowid` lookups return the wrong rows.

- [ ] **Step 4: Rewrite the entry routes in `server/src/tools/collab.ts`**

Change the core import to:

```ts
import {
  getDb, estimateTokens, KIND_BY_TYPE, SLUG_REGEX, validateEntryInput, buildFtsMatch,
  addEntry, getEntry, deleteEntry, supersede, doctor, ownerOf, replaceLinks, insertEntryModules,
  liveEntry, ftsJoin,
} from '@collab-mcp/core';
```

`runSearch`: replace the opening query and the module filter.

```ts
  let query = `
    SELECT e.id, e.type, e.kind, e.category, e.title, e.summary, e.module, e.agent, e.created_at,
           snippet(entries_fts, -1, '[[HL]]', '[[/HL]]', '...', 10) as snippet
    FROM entries_fts
    ${ftsJoin(db, 'e')}
    WHERE e.deprecated = 0 AND ${liveEntry(db, 'e')}
  `;
```
```ts
  if (module) {
    query += ` AND e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)`;
    params.push(module);
  }
```

`GET /api/collab/stats`: add `AND ${liveEntry(db, 'entries')}` to the `total`, `by_category`, `by_type` and `by_status` WHERE clauses (make them template literals). Change `recent` to:

```ts
      const recent = db.prepare(`
        SELECT id, type, category, title, summary, agent, module, created_at
        FROM entries WHERE deprecated=0 AND ${liveEntry(db, 'entries')} ORDER BY created_at DESC LIMIT 10
      `).all();
```

and `top_modules` to count live entries only:

```ts
      const top_modules = db.prepare(`
        SELECT em.module AS module, COUNT(*) AS count
        FROM entry_modules em JOIN entries e ON e.ulid = em.entry_ulid
        WHERE ${liveEntry(db, 'e')}
        GROUP BY em.module ORDER BY count DESC, em.module ASC LIMIT 10
      `).all();
```

`GET /api/collab/entry`: use core.

```ts
  'GET /api/collab/entry': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const id = Number(url.searchParams.get('id'));
    try {
      const entry = getEntry(db, id);
      if (!entry) return send(404, { error: 'Not found' });
      send(200, entry);
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },
```

`POST /api/collab/entry/upsert`: replace the `try { … }` body (from `const tokens = estimateTokens(description);` through `send(200, { ok: true, id: entryId });`) with:

```ts
      const normRefs = (Array.isArray(refs) ? refs : []).map((r: any) => ({
        ref_type: r.ref_type || r.type,
        ref_value: r.ref_value || r.value,
      }));

      if (!id) {
        // Create: core owns id/ulid/author/links at every schema level.
        const { id: newId } = addEntry(db, {
          type, title, summary, description, agent: agent || undefined,
          module: primaryModule ?? undefined, modules: orderedModules, category: resolvedCategory,
          task_id: task_id || undefined, refs: normRefs,
        });
        return send(200, { ok: true, id: newId });
      }

      const owner = ownerOf(db, Number(id));
      if (!owner) return send(404, { error: `entry ${id} not found` });
      const tokens = estimateTokens(description);
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE entries SET type=?, kind=?, title=?, summary=?, description=?, agent=?, module=?, task_id=?, tokens_estimate=?, category=?
          WHERE id = ? AND ${liveEntry(db, 'entries')}
        `).run(type, kind, title, summary, description, agent, primaryModule, task_id, tokens, resolvedCategory, owner.id);
        replaceLinks(db, owner, orderedModules, primaryModule, normRefs);
      });
      tx();
      send(200, { ok: true, id: owner.id });
```

`POST /api/collab/entry/delete`:

```ts
  'POST /api/collab/entry/delete': async (req, res, send, body) => {
    try {
      const r = deleteEntry(db, Number(body.id)); // tombstone after 0006
      send(200, { ok: true, ...r });
    } catch (err: any) {
      const status = /no entry found/.test(err.message) ? 404 : 500;
      send(status, { error: err.message });
    }
  },
```

`POST /api/collab/entry/supersede`: keep the request validation (`ids` array, numeric `by`, `by` not in `ids`), and replace everything from `const byRow =` to `send(200, …)` with:

```ts
      const uniqueIds = [...new Set(ids)] as number[];
      const r = supersede(db, { ids: uniqueIds, by });
      send(200, { ok: true, superseded: r.superseded, by: r.by });
    } catch (err: any) {
      const status = /does not exist|cannot be one of/.test(err.message) ? 400 : 500;
      send(status, { error: err.message });
    }
```

(Remove the old inner `try`'s trailing `catch` so the braces balance: there is exactly one `try/catch` in the handler.)

`POST /api/collab/entry/reassign-module`: replace the statements from `const uniqueIds =` to `send(200, …)` with a version that works at both levels (no `ON CONFLICT(entry_id, module)`: that clause names a PK that no longer exists at 0006):

```ts
      const uniqueIds = [...new Set(ids)] as number[];
      let updated = 0;
      const tx = db.transaction(() => {
        for (const id of uniqueIds) {
          const owner = ownerOf(db, id);
          if (!owner) continue;
          db.prepare('UPDATE entries SET module = ? WHERE id = ?').run(module, owner.id);
          db.prepare('DELETE FROM entry_modules WHERE entry_ulid = ? AND is_primary = 1').run(owner.ulid);
          // Promote an existing secondary membership, or add a new primary one.
          const promoted = db.prepare('UPDATE entry_modules SET is_primary = 1 WHERE entry_ulid = ? AND module = ?').run(owner.ulid, module).changes;
          if (promoted === 0) insertEntryModules(db, owner, [module], module);
          updated += 1;
        }
      });
      tx();
      send(200, { ok: true, updated, module });
```

`GET /api/collab/module-card`: in the three entry queries, replace `SELECT rowid AS id` with `SELECT id`, and replace `WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)` with `` WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${liveEntry(db, 'entries')} `` (make the strings template literals).

`POST /api/collab/doctor`: replace the whole handler body with the core call. This removes the hand copy that E-685 #5 flagged:

```ts
  // --- DOCTOR (core is the single implementation; E-685 #5) ---
  'POST /api/collab/doctor': async (req, res, send) => {
    try { send(200, doctor(db)); } catch (err: any) { send(500, { error: err.message }); }
  },
```

`GET /api/collab/export`: change the query start to `'SELECT id, ulid, type, kind, …'` (drop `rowid AS id`, add `ulid`), and append `` ` AND ${liveEntry(db, 'entries')}` `` after `WHERE deprecated=0`. Make the module filter `' AND ulid IN (SELECT entry_ulid FROM entry_modules WHERE module=?)'`, and change the two per-entry lookups to use `entry_ulid = ?` with `e.ulid`.

Delete the now-unused `CATEGORY_BY_TYPE` import only if nothing else in the file uses it (grep first).

Final check: `grep -n "rowid" server/src/tools/collab.ts` must print nothing.

- [ ] **Step 5: User rebuilds the server, then run the REST tests and confirm they pass** (user: `npm -w @collab-mcp/server run build`; background subagent)

Run: `cd internal-tools && npx tsx --test test/api.contract-0005.test.mts test/api.contract-0006.test.mts test/api.upsert.test.mts test/api.supersede.test.mts test/api.reassign-module.test.mts test/api.search.test.mts test/api.stats.test.mts test/api.ai.test.mts`
Expected: PASS. If an older API test asserted an exact error string that changed (for example supersede's "these ids do not exist" becoming core's wording), update the assertion to the core message and list it in the changelog.

- [ ] **Step 6: Checkpoint: user commits** (suggested: `fix(server): no rowid-as-id; entry writes and doctor through core (E-685 #5, #6)`)

---

### Task 8: Scripts write through core

**Files:**
- Modify: `mcp/src/scripts/log-collab.ts`, `mcp/src/scripts/sweep-deps.ts:340-395`, `mcp/src/scripts/manual-search.ts:17-40`

**Interfaces:**
- Consumes: `getDb`, `migrate`, `addEntry`, `initModule` (from `@collab-mcp/core`; relative source imports like `rehearse-0005.ts` if core/dist is stale).

- [ ] **Step 1: Confirm the failure mode** (background subagent, on a scratch copy only)

Run:
```bash
cd internal-tools && IT=$(pwd) && T=$(mktemp -d) \
  && COLLAB_DB_PATH=$T/c.db COLLAB_DB_CREATE=1 npx tsx -e "import('./core/src/db.ts').then(m=>{const db=m.getDb(); m.migrate(db,{includeStaged:true}); m.closeDb();})" \
  && cd "$T" && COLLAB_DB_PATH=$T/c.db npx tsx "$IT/mcp/src/scripts/log-collab.ts" handoff t s
```
Expected: FAIL. `log-collab.ts` opens `./collab.db` in the cwd (a *different* file from `COLLAB_DB_PATH`, which is the E-550/E-689 bug class), and at 0006 a raw INSERT has no `ulid`.

- [ ] **Step 2: Rewrite `log-collab.ts`**

```ts
import { getDb, migrate, addEntry, initModule, closeDb, type EntryType, type Category } from "@collab-mcp/core";

const [type, title, summary, description, moduleName, category, status] = process.argv.slice(2);

if (!type || !title || !summary) {
  console.error("Usage: tsx log-collab.ts <type> <title> <summary> [description] [moduleName] [category] [status]");
  process.exit(1);
}

// Same DB resolution as every other entry point (COLLAB_DB_PATH), never ./collab.db (E-550, E-689).
const db = getDb();
try {
  migrate(db);
  if (moduleName && !db.prepare("SELECT 1 FROM modules WHERE slug = ?").get(moduleName)) {
    initModule(db, { slug: moduleName, name: moduleName } as any);
    console.log(`Created placeholder module: ${moduleName}`);
  }
  const { id } = addEntry(db, {
    type: type as EntryType,
    title,
    summary,
    description: description || undefined,
    status: (status as "draft" | "active") || "active",
    agent: "Gemini",
    module: moduleName || undefined,
    category: (category as Category) || undefined,
  });
  console.log(`Inserted entry E-${id}`);
} catch (e) {
  console.error("Error logging to DB:", e);
  process.exitCode = 1;
} finally {
  closeDb();
}
```

(If `initModule`'s args differ, check `InitModuleArgs` in `core/src/ops/module.ts` and pass `slug` + `name` in its shape.)

- [ ] **Step 3: `sweep-deps.ts`.** Replace `const dbPath = path.resolve('collab.db'); const db = new Database(dbPath);` with `const db = getDb(); migrate(db);`. Replace the gotcha INSERT with:

```ts
      addEntry(db, {
        type: 'gotcha',
        title: `Dependency audit blocked on ${gotcha.repo}`,
        summary: `Audit blocked on ${gotcha.repo}: ${gotcha.error}`.slice(0, 200),
        description: `The dependency audit sweep encountered an error on service ${gotcha.repo}: ${gotcha.error}. Analysis skipped.`,
        agent: 'Gemini',
        module: 'dependency-audit',
        category: 'Reference',
      });
```

Replace the changelog `insertStmt` / `info` / `entry_modules` lines with:

```ts
    const { id: entryId } = addEntry(db, {
      type: 'changelog', title, summary, description, agent: 'Gemini', module: 'dependency-audit', category: 'Activity',
    });
```

and `db.close()` with `closeDb()`. Update the imports (`getDb, migrate, addEntry, closeDb` from `@collab-mcp/core`), and drop `better-sqlite3` if it is now unused.

- [ ] **Step 4: `manual-search.ts`.** Replace the seed `insert` statement and its loop with `for (const r of rows) addEntry(db, { type: r.type as any, title: r.title, summary: r.summary, description: r.description, status: r.status as any, agent: r.agent as any, module: r.module ?? undefined, task_id: r.task_id ?? undefined });`. Drop the `kind` and `tokens_estimate` fields from the row objects (core derives both), and import `addEntry`.

- [ ] **Step 5: Verify** (background subagent)

Run: `cd internal-tools/mcp && npx tsc --noEmit -p .` and repeat Step 1's command with `COLLAB_DB_PATH` pointing at the scratch DB, run from a *different* cwd.
Expected: tsc is clean; the entry lands in `$T/c.db` (check with `SELECT id, ulid FROM entries`), and no `collab.db` appears in the cwd.

- [ ] **Step 6: Checkpoint: user commits** (suggested: `fix(mcp): scripts write through core and COLLAB_DB_PATH, never ./collab.db`)

---

### Task 9: Real-DB rehearsal (+ cr-sqlite probe), golden snapshots, go-live runbook

**Files:**
- Create: `mcp/src/scripts/rehearse-0006.ts`
- Modify: `test/golden/snapshot.mjs`, `mcp/tsconfig.json`. Change the `exclude` line to `["node_modules", "dist", "src/scripts/rehearse-0005.ts", "src/scripts/rehearse-0006.ts"]`. The script imports core **source** through `../../../core/src`, which is outside mcp's `rootDir`, so if tsc compiles it the build output moves away from `dist/server.js` (the bug 5393dae fixed).

**Interfaces:**
- Consumes: core `migrate`, `doctor`, `searchEntries` (relative **source** imports, as in `rehearse-0005.ts`).

- [ ] **Step 1: Create `mcp/src/scripts/rehearse-0006.ts`**

```ts
#!/usr/bin/env node
/**
 * Rehearse 0006 on a COPY of a real collab DB. Never writes to the source.
 *   npx tsx src/scripts/rehearse-0006.ts <path-to-collab.db>
 * Optional: CRSQLITE_PATH=<dir>/crsqlite (no extension) also runs crsql_as_crr
 * on a second copy (cr-sqlite v0.16.3 prebuilt from its GitHub release; its npm
 * postinstall is broken on Node 22, so it is never a package dependency).
 */
import Database from "better-sqlite3";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative SOURCE imports: "@collab-mcp/core" is core/dist, stale until rebuilt.
import { migrate as migrateProd } from "../../../core/src/db.js";
import { doctor } from "../../../core/src/ops/doctor.js";
import { searchEntries } from "../../../core/src/ops/search.js";

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });
const PROBE_TERMS = ["migration", "supporthub", "timesheet", "ulid", "relay"];
const SYNCED = ["entries", "refs", "entry_modules", "entry_revisions", "tasks", "modules"];

const source = process.argv[2];
if (!source) throw new Error("usage: rehearse-0006.ts <path-to-collab.db>");
const sourceStat = statSync(source);

const dir = mkdtempSync(join(tmpdir(), "rehearse-0006-"));
const copyA = join(dir, "a.db");
const src = new Database(source, { readonly: true, fileMustExist: true });
src.prepare("VACUUM INTO ?").run(copyA);
src.close();

const a = new Database(copyA);
const one = (sql: string) => (a.prepare(sql).get() as any)?.c as number;
const rows = (sql: string) => JSON.stringify(a.prepare(sql).all());
const hits = () =>
  Object.fromEntries(
    PROBE_TERMS.map((t) => [
      t,
      searchEntries(a, { query: t, kind: "any", include_deprecated: false, limit: 50 } as any).results
        .map((r: any) => r.id).sort((x: number, y: number) => x - y),
    ]),
  );

// ---- before (0005) ----
const ENTRY_COLS = `ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category, superseded_by, author, superseded_by_ulid`;
const before = {
  entries: rows(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`),
  refs: rows(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`),
  modules: rows(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`),
  tasks: rows(`SELECT * FROM tasks ORDER BY id`),
  moduleRows: rows(`SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules ORDER BY slug`),
  revisions: one(`SELECT COUNT(*) c FROM entry_revisions`),
  expectedCounter: one(`SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='entries'),0), COALESCE((SELECT MAX(id) FROM entries),0)) c`),
  search: hits(),
};
const t0 = Date.now();
const applied = migrate(a);
const migrateMs = Date.now() - t0;

// ---- after (0006) ----
const after = {
  entries: rows(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`),
  refs: rows(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`),
  modules: rows(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`),
  tasks: rows(`SELECT * FROM tasks ORDER BY id`),
  moduleRows: rows(`SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules ORDER BY slug`),
  revisions: one(`SELECT COUNT(*) c FROM entry_revisions`),
  counter: one(`SELECT value c FROM local_counters WHERE name='entry_number'`),
  search: hits(),
};
let ftsIntegrity = "ok";
try { a.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`); }
catch (e) { ftsIntegrity = (e as Error).message; }
const doctorChecks = doctor(a).checks;
a.close();

// ---- optional: cr-sqlite on a copy of the migrated copy ----
const crr: Record<string, string> = {};
if (process.env.CRSQLITE_PATH) {
  const copyB = join(dir, "b.db");
  const m = new Database(copyA);
  m.prepare("VACUUM INTO ?").run(copyB);
  m.close();
  const b = new Database(copyB);
  b.loadExtension(process.env.CRSQLITE_PATH);
  for (const t of SYNCED) {
    try { b.prepare("SELECT crsql_as_crr(?)").get(t); crr[t] = "ok"; }
    catch (e) { crr[t] = (e as Error).message; }
  }
  b.prepare("SELECT crsql_finalize()").get();
  b.close();
}

const liveStat = statSync(source);
const criteria: Array<[string, boolean]> = [
  ["applied0006", applied.includes("0006_ulid_contract")],
  ["entriesUnchanged", before.entries === after.entries],
  ["refsUnchanged", before.refs === after.refs],
  ["entryModulesUnchanged", before.modules === after.modules],
  ["tasksUnchanged", before.tasks === after.tasks],
  ["modulesUnchanged", before.moduleRows === after.moduleRows],
  ["noNewRevisions", before.revisions === after.revisions],
  ["counterSeeded", after.counter === before.expectedCounter],
  ["searchUnchanged", JSON.stringify(before.search) === JSON.stringify(after.search)],
  ["ftsIntegrity", ftsIntegrity === "ok"],
  ["doctorNoErrors", doctorChecks.every((c) => c.severity !== "error")],
  ["crrOk", Object.values(crr).every((v) => v === "ok")],
  ["liveDbUntouched", liveStat.size === sourceStat.size && liveStat.mtimeMs === sourceStat.mtimeMs],
];
const failed = criteria.filter(([, pass]) => !pass).map(([n]) => n);
console.log(JSON.stringify({
  applied, migrateMs, counter: after.counter, crr: process.env.CRSQLITE_PATH ? crr : "skipped (CRSQLITE_PATH not set)",
  doctor: doctorChecks.filter((c) => c.severity !== "ok").map((c) => ({ name: c.name, severity: c.severity, detail: c.detail })),
  copies: dir, failed,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
```

Note: `updated_at` is part of `entriesUnchanged`, which catches a trigger firing during the copy. `liveDbUntouched` can flap if a live session writes during the run. If it fails, rerun with the sessions stopped before concluding anything.

- [ ] **Step 2: Run the rehearsal on the real DB** (background subagent; read-only on the source)

Run: `cd internal-tools/mcp && CRSQLITE_PATH=<scratch>/crspike/bin/crsqlite npx tsx src/scripts/rehearse-0006.ts ../mcp/collab.db`
Expected: `failed: []`, `crr` all `ok`, counter = today's `max(seq, max(id))`, migration under 1 s. The binary is the one from the 2026-09-29 spike: `https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-win-x86_64.zip`. If it is unavailable, run without `CRSQLITE_PATH` and report `crr: skipped` as **unverified**, not passed.

- [ ] **Step 3: Make golden snapshots line-ending-insensitive.** In `test/golden/snapshot.mjs`, change the compare to:

```js
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(actual.replace(/\r\n/g, '\n'), expected, `golden mismatch for ${name}`);
```

Then (user builds the server first) regenerate: `cd internal-tools && UPDATE_GOLDEN=1 npx tsx --test test/golden/rest.golden.test.mts`, then rerun without `UPDATE_GOLDEN`. Expected: PASS. **Review the snapshot diff before committing:** `rest_doctor.json` must now show `data.orphan_refs.entry: ok` and a new `fts.integrity: ok`. Any other change needs a reason in the changelog.

- [ ] **Step 4: Log to collab** (executor): a `changelog` in `collab-mcp` with the rehearsal JSON summary (counts, `migrateMs`, `crr`, `failed`), and a `handoff` whose next step is "user runs the go-live runbook below".

- [ ] **Step 5: Checkpoint: user commits** (suggested: `test(mcp): 0006 real-DB rehearsal with cr-sqlite probe; golden snapshots EOL-safe`)

#### Go-live runbook (the user runs this; never an agent)

1. Merge `collab-0006-contract` into `collabv1`. It is safe to merge before go-live, because every path is tested at 0005.
2. Stop **every** Claude/Codex session **and** the REST server/UI. Any of them applies migrations on start. The first one to start would migrate while the others hold the old schema in memory.
3. Build: `cd internal-tools && npm -w @collab-mcp/core run build && npm -w @collab-mcp/server run build && npm --prefix mcp run build`.
4. Move `mcp/migrations/staged/0006_ulid_contract.sql` to `mcp/migrations/`, using a **move**, not a copy (a copy trips `DuplicateMigrationError`).
5. `cd mcp && npx tsx src/migrate.ts`. Expect `applied: 0006_ulid_contract`. A `PreflightError` lists the rows to fix, and nothing will have changed.
6. Confirm `mcp/collab.db.bak-0006_ulid_contract-*` exists.
7. Start ONE session and run `collab_doctor`. Expect no errors, `data.orphan_refs.entry: ok`, `fts.integrity: ok`, `data.tombstones: 0 tombstoned entries`, and `data.duplicate_entry_ids: ok`.
8. `collab_add` a test entry. Its id must be `max(seq, max(id)) + 1`, never a reused number.
9. Start the REST server and UI, and check that the entry count matches doctor's `fts.count_parity`.
10. Start the remaining sessions.

**Rollback:** stop everything, replace `mcp/collab.db` with the `.bak-0006_ulid_contract-*` file, delete the stale `mcp/collab.db-wal` / `-shm` next to it, move the SQL back to `staged/`. The merged code runs on 0005, which Review Focus #1 guarantees.

---

## What this plan deliberately does not do

- **No sync, relay or central E-number allocator (E-648).** `nextEntryNumber` is local only. Until the allocator exists, E-numbers stay unique per machine but will collide across machines. That is why `id` has no UNIQUE and doctor reports duplicates.
- **Id-keyed lookups stay.** `getEntry(id)`, `updateEntry`, `supersede`, and rollup's "deprecate originals" still look up by E-number. That is correct while numbers are locally unique. The sync plan must move them to ULIDs, or to "lowest ulid wins" as `ownerOf` already does.
- **Remote merges and FTS (E-643).** The spike showed the FTS triggers still fire for *local* writes on a CRR table. Whether cr-sqlite's *merge* path fires them is the post-sync re-index task, not this plan.
- **Revision ordering by wall clock (E-685 #9)** is left as-is until the D5 three-way merge is built.
- **Dropping the legacy columns** (`refs.entry_id`, `entry_modules.entry_id`, `entries.superseded_by`) waits for a later contract step, once nothing writes them.
- **Tasks' `T-NNN` counter** (derived from `max`) will collide across machines. It belongs to the sync plan.
- **The `'Jules'` assignee.** The REST task-assign route accepts it, but the tasks CHECK has never allowed it. This is a pre-existing bug that is copied unchanged.
- **T-011** (hubs and dangling links) runs on the finished 0006 schema, after go-live.
