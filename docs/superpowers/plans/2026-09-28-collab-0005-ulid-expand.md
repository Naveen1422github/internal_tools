# Collab Migration 0005 (ULID expand phase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every collab entry a permanent, machine-independent ULID. Carry that key into `refs`, `entry_modules` and `superseded_by`, add `author`, `modules.hub` and an edit-history table. The existing integer `id` stays the working key throughout, so nothing that runs today breaks.

**Architecture:** This is the *expand* half of an expand/contract migration. 0005 only **adds** columns, tables and triggers, and backfills them. The old integer keys keep working, so every current tool, script and the live MCP server run unchanged. **0006 (a separate plan, written after 0005 passes its rehearsal on the real DB)** is the *contract* half. It rebuilds `entries` with the ULID as primary key, makes `id` a nullable label, replaces the external-content FTS index and switches all reads to ULIDs.

How each new key gets written:
- **Entry ULIDs** come from JS at the three core insert sites.
- **`refs` and `entry_modules` keys** are filled by SQLite triggers, so they're filled no matter which connection inserts the row.
- **A startup backfill** repairs rows written by paths that skip core. It's idempotent and runs on every `migrate()`.

**Tech Stack:** TypeScript 5.3, better-sqlite3 (SQLite 3.4x+), node:test via `tsx --test`, no new dependencies. The ULID encoder is ~40 lines in core.

**Spec:** collab **E-674** (scope and order), **E-646** (the original 0005 list, corrected by E-674: `id` must be NULLABLE), **E-648** (only the allocator hands out E-numbers), **E-651** (links keyed by `(entry_ulid, ref_type, ref_value)`, text edits = revisions + three-way merge), **E-657** (`modules.hub`), **E-643** (synced rows bypass FTS triggers).

## Why two migrations, not one

`migrate()` runs on every server start, and the collab MCP server is live while we work. A single 0005 that changes the primary key would break every collab tool the moment anyone restarts, before the ~230 id-based call sites are rewritten.

Splitting it gives three things:
- **Nothing breaks mid-work.** Old code keeps working after 0005 ships.
- **The real data gets checked.** The rehearsal proves the backfill on all 673 entries before anything is dropped.
- **0006 becomes mechanical.** Every ULID already exists and has been verified by the time it runs.

## Decisions baked into this plan (confirm at review)

| # | Decision | Default in this plan | Why |
|---|---|---|---|
| D1 | How old entries sort when two share the same second | Time part = `created_at`. The random part starts with the E-number (32 bits), then 48 bits of `sha256(id\|created_at\|title)` | The real DB has 3 same-second groups and **0** cases where `created_at` order disagrees with id order. So "sort by ULID" = "sort by E-number" for all history, and a re-run produces the same ULIDs. **This holds for history only.** After 0005, a row inserted by the REST server or `log-collab.ts` gets its ULID from a whole-second `created_at`, so it can sort up to 1 s before a core-inserted neighbour. Harmless, and 0006 routes every insert through core. |
| D2 | What `author` means | Who owns the machine that wrote the row: `COLLAB_AUTHOR` env var, else the OS username. This is separate from `agent` (Claude/Codex). Existing rows are backfilled with the local author. | The user's own correction: attribution is its own column, never baked into the ID. |
| D3 | Uniqueness of `ulid` | **Plain index, not UNIQUE** | cr-sqlite forbids unique indexes besides the PK (E-646). 0006 makes it the PK. |
| D4 | What happens to entry links that point nowhere | Kept as they are, `target_ulid` left NULL, reported by doctor. Never deleted. | The real DB has 144 non-numeric entry links (`E-214`, `#116`). All should resolve, and anything that doesn't must be visible. |
| D6 | What `updated_at` means | "Content last changed". The timestamp trigger watches content columns only, so the backfill leaves all 673 historical timestamps untouched. | Otherwise every entry would look edited on migration day, which breaks `since`-style "recently changed" views. |
| D5 | When edit history starts | A trigger records a root snapshot (the pre-edit text) on an entry's first edit, then one row per edit | A three-way merge (E-651) needs a common ancestor. History has to start before the first concurrent edit, not when the relay ships. |

Deferred to the 0006 plan, flagged here so they aren't forgotten:
- **FTS index:** an FTS table that keeps its own copy of the text (`ulid UNINDEXED`) vs. the current shared-storage one. Recommendation: own copy, because VACUUM can renumber hidden rowids once `id` is no longer the INTEGER PK.
- **Tombstones:** a `deleted_at` column, and turning the server's hard delete at `server/src/tools/collab.ts:236` into a tombstone.
- **PKs and defaults:** NOT NULL PKs on `tasks`/`modules`, and defaults on every NOT NULL column.
- **Silent `rowid`-as-id bugs:** `server/src/tools/collab.ts:10, :113, :166, :236` all equate `rowid` with the E-number. That stops being true in 0006.
- **The local E-number counter:** seed it from `sqlite_sequence.seq` (678 today; 673 rows exist, so `MAX(id)+1` would reuse deleted numbers).
- **cr-sqlite check:** load the spike DLL and run `crsql_as_crr` on each table.

## Global Constraints

- **No Turso step anywhere in this plan.** 0005 is a local schema change only. Any later sync or seed to Turso must filter to SupportHub data only (user rule, 2026-09-28).
- **Never run `npm run build`, the root `npm test`, or anything that builds.** Core tests run as targeted files: `cd internal-tools/core && npx tsx --test test/<file>.test.ts`. Tests are **run by a background subagent** that returns pass/fail counts plus each failure's name, assertion and file:line. Never paste raw output inline.
- **Never touch the git index.** No `git add`, `git commit`, `git stash` or `git reset` in any step. Each task ends with a **"Checkpoint: user commits"** step.
- **Precondition:** the uncommitted `core/src/db.ts` changes (the `resolveDbPath` work) must be committed by the user **before Task 2**, which edits the same file.
- **0005 lives in `mcp/migrations/staged/` until go-live.** Every running server, including the *old* `core/dist` build, scans `mcp/migrations/` straight from source (`core/dist/db.js:13`). A file dropped there is applied on the next session start, with no backup and no backfill. Only tests and the rehearsal opt in to staged files, and Task 7 moves the file after the servers are stopped and rebuilt.
- **Never open the live DB for writing** (`internal-tools/mcp/collab.db`, via `COLLAB_DB_PATH` in `.mcp.json`) until Task 7. Rehearsals work on copies.
- Summary ≤ 200 chars and the other existing CHECKs stay untouched. 0005 adds no CHECK constraints.
- No UNIQUE index on any new column (cr-sqlite rule).

## Review Focus

1. **An entry inserted by a script that skips core** (`mcp/src/scripts/log-collab.ts`, `server/src/tools/collab.ts:207`) must get a ULID by the next `migrate()`. Its refs and module rows must get `entry_ulid` too. → Task 4 test `backfill repairs a row inserted without a ulid`.
2. **Links written in legacy formats** (`E-214`, `E-00214`, `#116`, ` 214 `, `e-7`) must resolve to the same ULID in the SQL trigger and in the JS backfill. If the two parsers drift, links resolve differently depending on which path wrote them. → Task 3 parity test.
3. **A link to an entry that doesn't exist yet** (a forward reference) or never existed must not fail the insert. It stays `target_ulid NULL` and doctor lists it. → Task 3 and Task 6 tests.
4. **Running `migrate()` twice, or migrating two separate copies of the same DB**, must produce identical ULIDs. → Task 4 determinism test and the Task 7 rehearsal.
5. **Editing an entry to the same text** (the server's full-row UPDATE at `collab.ts:200` rewrites every field) must not add a revision row. → Task 5 test.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `core/src/ulid.ts` | Create | Crockford encoding, `newUlid()` (monotonic), `ulidFromLegacy()`, `parseSqliteUtc()`, `parseEntryRef()` |
| `core/src/author.ts` | Create | `resolveAuthor()` |
| `core/src/backfill.ts` | Create | `backfillUlids(db)`: the idempotent repair pass, returns a report |
| `core/src/db.ts` | Modify `migrate()` | Back up before pending migrations, then run `backfillUlids` after the SQL files |
| `core/src/index.ts` | Modify | Export `ulid`, `author`, `backfill` |
| `mcp/migrations/staged/0005_ulid_expand.sql` | Create (moved to `mcp/migrations/` in Task 7) | Columns, indexes, `entry_revisions`, fill triggers, revision trigger |
| `core/src/ops/add.ts` | Modify insert | Write `ulid` + `author` |
| `core/src/ops/rollup.ts` | Modify 2 inserts | Write `ulid` + `author` |
| `core/src/ops/doctor.ts` | Modify | Register new objects and add 2 data checks |
| `mcp/src/scripts/rehearse-0005.ts` | Create | Migrate a **copy** of a real DB and print a verification report |
| `core/test/ulid.test.ts`, `core/test/migrate-0005.test.ts` | Create | Tests |
| `test/golden/__snapshots__/rest_modules.json`, `rest_doctor.json` | Regenerate (user) | Expected diff: `"hub": null` per module, plus the new doctor checks |

`log-collab.ts` and the server's own insert at `collab.ts:207` are **deliberately not edited**. The triggers and startup backfill cover them, and Review Focus #1 proves it. The server gets rewritten in 0006 anyway.

---

### Task 1: ULID and author primitives

**Files:**
- Create: `core/src/ulid.ts`, `core/src/author.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/ulid.test.ts`

**Interfaces:**
- Produces:
  - `newUlid(now?: number): string`
  - `ulidFromLegacy(id: number, createdAt: string, title: string): string`
  - `parseSqliteUtc(createdAt: string): number`
  - `parseEntryRef(value: string): number | null`
  - `resolveAuthor(): string | null`

- [ ] **Step 1: Write the failing tests** in `core/test/ulid.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid, ulidFromLegacy, parseSqliteUtc, parseEntryRef } from '../src/ulid.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('newUlid is 26 Crockford chars', () => {
  assert.match(newUlid(), ULID_RE);
});

test('newUlid is strictly increasing within the same millisecond', () => {
  const t = 1_790_000_000_000;
  const a = newUlid(t), b = newUlid(t), c = newUlid(t);
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
});

test('newUlid never goes backwards when the clock does', () => {
  const a = newUlid(1_790_000_000_500);
  const b = newUlid(1_790_000_000_100);
  assert.ok(b > a);
});

test('parseSqliteUtc reads SQLite datetime() as UTC, not local time', () => {
  assert.equal(parseSqliteUtc('2026-04-22 20:14:14'), Date.UTC(2026, 3, 22, 20, 14, 14));
  assert.equal(parseSqliteUtc('2026-04-22 20:14:14.25'), Date.UTC(2026, 3, 22, 20, 14, 14, 250));
  assert.throws(() => parseSqliteUtc('22/04/2026'), /unparseable created_at/);
});

test('ulidFromLegacy is deterministic', () => {
  assert.equal(
    ulidFromLegacy(155, '2026-05-01 10:00:00', 'INDEX'),
    ulidFromLegacy(155, '2026-05-01 10:00:00', 'INDEX'),
  );
});

test('ulidFromLegacy orders same-second entries by id (D1)', () => {
  const same = '2026-04-22 20:14:14';
  const ids = [9, 10, 2, 1000, 11];
  const byUlid = [...ids].sort((x, y) =>
    ulidFromLegacy(x, same, 't' + x) < ulidFromLegacy(y, same, 't' + y) ? -1 : 1);
  assert.deepEqual(byUlid, [2, 9, 10, 11, 1000]);
});

test('ulidFromLegacy time part sorts across seconds', () => {
  assert.ok(ulidFromLegacy(999, '2026-04-22 20:14:14', 'a') < ulidFromLegacy(1, '2026-04-22 20:14:15', 'b'));
});

test('parseEntryRef accepts every legacy format seen in the real DB', () => {
  for (const [input, want] of [
    ['214', 214], ['E-214', 214], ['E-00214', 214], ['e-214', 214], ['#116', 116],
    [' 214 ', 214], ['E214', 214],
  ] as const) assert.equal(parseEntryRef(input), want, input);
});

test('parseEntryRef rejects junk', () => {
  for (const input of ['', '0', 'E-', 'abc', '12a', 'T-011', '-5', '1.5']) {
    assert.equal(parseEntryRef(input), null, input);
  }
});
```

- [ ] **Step 2: Run them and confirm they fail** (background subagent): `cd internal-tools/core && npx tsx --test test/ulid.test.ts`. Expected: FAIL, cannot find module `../src/ulid.js`.

- [ ] **Step 3: Implement `core/src/ulid.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

// Crockford base32, the ULID alphabet (no I, L, O, U).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;
const RAND_LIMIT = 1n << 80n;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new Error(`ULID time out of range: ${ms}`);
  let out = "";
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) out = CROCKFORD[t % 32] + out;
  return out;
}

function encodeRandom(bits: bigint): string {
  let out = "";
  for (let i = 0, b = bits; i < 16; i++, b >>= 5n) out = CROCKFORD[Number(b & 31n)] + out;
  return out;
}

function randomBits80(): bigint {
  let b = 0n;
  for (const byte of randomBytes(10)) b = (b << 8n) | BigInt(byte);
  return b;
}

let lastMs = -1;
let lastRand = 0n;

/**
 * Monotonic ULID. Within one millisecond (or if the clock steps backwards)
 * the random part is incremented instead of redrawn, so ids from this process
 * always sort in creation order.
 */
export function newUlid(now: number = Date.now()): string {
  if (now <= lastMs) {
    lastRand += 1n;
    if (lastRand >= RAND_LIMIT) throw new Error("ULID random part overflowed within one millisecond");
  } else {
    lastMs = now;
    lastRand = randomBits80();
  }
  return encodeTime(lastMs) + encodeRandom(lastRand);
}

/** SQLite datetime('now') text is UTC with no zone marker; JS would read it as local time. */
export function parseSqliteUtc(createdAt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(createdAt);
  if (!m) throw new Error(`unparseable created_at: ${createdAt}`);
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/**
 * Deterministic ULID for a pre-0005 entry (decision D1).
 * Random part = id in the top 32 bits, so same-second entries sort by E-number,
 * then 48 bits of a hash so two unrelated databases don't collide.
 */
export function ulidFromLegacy(id: number, createdAt: string, title: string): string {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) throw new Error(`legacy id out of range: ${id}`);
  const h = createHash("sha256").update(`${id}|${createdAt}|${title}`).digest();
  let low = 0n;
  for (let i = 0; i < 6; i++) low = (low << 8n) | BigInt(h[i]);
  return encodeTime(parseSqliteUtc(createdAt)) + encodeRandom((BigInt(id) << 48n) | low);
}

/**
 * Legacy entry-link value -> E-number, or null. Accepts "214", "E-214",
 * "E-00214", "E214", "#116" (any case, surrounding spaces). MUST stay in
 * lockstep with the SQL parser in 0005's trg_refs_fill_ulids; a parity test
 * guards this.
 */
export function parseEntryRef(value: string): number | null {
  const m = /^(?:#|E-?)?(\d+)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
```

Implement `core/src/author.ts`:

```ts
import { userInfo } from "node:os";

/** Who owns this machine's writes (decision D2). Distinct from `agent`. */
export function resolveAuthor(): string | null {
  const fromEnv = process.env.COLLAB_AUTHOR?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username || null;
  } catch {
    return null; // userInfo throws on some sandboxed/containerised hosts
  }
}
```

Add to `core/src/index.ts`:

```ts
export * from './ulid.js';
export * from './author.js';
```

- [ ] **Step 4: Run and confirm pass** (background subagent, same command). Expected: 9/9 pass.
- [ ] **Step 5: Checkpoint: user commits.**

---

### Task 2: Migration runner: backup, then backfill hook

**Precondition:** the user has committed the existing uncommitted `core/src/db.ts` changes.

**Files:**
- Modify: `core/src/db.ts` (`migrate()`)
- Create: `core/src/backfill.ts` (a stub in this task, filled in Task 4)
- Test: `core/test/migrate-0005.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces:
  - `migrate(db?: DB, opts?: MigrateOptions): string[]`
  - `migrateTo(db: DB, upTo: string, opts?: MigrateOptions): string[]`
  - `MigrateOptions = { includeStaged?: boolean }` (default false = production behaviour)
  - `backfillUlids(db: DB): BackfillReport`
  - `BackfillReport = { entries: number; refs: number; entryModules: number; superseded: number; authors: number; unresolvedEntryRefs: Array<{ entry_id: number; ref_value: string }>; skippedEntries: Array<{ id: number; created_at: string; error: string }> }`

- [ ] **Step 1: Write the failing tests** (a new file; later tasks add more cases to it)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate as migrateProd, migrateTo } from '../src/db.js';

// Tests exercise the staged 0005; production callers never pass includeStaged.
const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });

export function tempDb(): { db: Database.Database; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0005-'));
  const path = join(dir, 'collab.db');
  return { db: new Database(path), dir, path };
}

// Stays `todo` until Task 3 adds the 0005 file (with nothing pending, no backup is due).
test('migrate backs up an existing DB before applying pending migrations', { todo: 'needs 0005 (Task 3)' }, () => {
  const { db, dir } = tempDb();
  try {
    migrateTo(db, '0004');   // a pre-0005 DB...
    db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('decision', 'signal', 't', 's')`).run();
    migrate(db);             // ...upgraded: must snapshot first
    const baks = readdirSync(dir).filter((f) => f.startsWith('collab.db.bak-0005_ulid_expand-'));
    assert.equal(baks.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate does not back up a brand-new empty DB', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain migrate() never applies staged migrations', () => {
  const { db, dir } = tempDb();
  try {
    migrateProd(db);
    const staged = db.prepare(`SELECT version FROM schema_migrations WHERE version LIKE '0005%'`).all();
    assert.deepEqual(staged, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate is idempotent', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.deepEqual(migrate(db), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run and confirm it fails** (background subagent): `cd internal-tools/core && npx tsx --test test/migrate-0005.test.ts`. Expected: FAIL at import, `migrateTo` is not exported.

- [ ] **Step 3: Implement.** In `core/src/db.ts`, change `migrate` and add `migrateTo`:

```ts
import { backfillUlids } from "./backfill.js";

// Migrations written but not yet released. Only tests and rehearsals read them
// (includeStaged). Going live = moving the file up one folder, after every
// server is stopped, because every running build scans MIGRATIONS_DIR.
const STAGED_DIR = join(MIGRATIONS_DIR, "staged");

export interface MigrateOptions {
  includeStaged?: boolean;
}

interface Pending {
  version: string;
  file: string;
}

function listSql(dir: string): Pending[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ version: f.replace(/\.sql$/, ""), file: join(dir, f) }));
}

function pendingMigrations(db: DB, upTo: string | undefined, opts: MigrateOptions): Pending[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as string),
  );
  return [...listSql(MIGRATIONS_DIR), ...(opts.includeStaged ? listSql(STAGED_DIR) : [])]
    .sort((a, b) => (a.version < b.version ? -1 : 1))
    .filter((m) => !applied.has(m.version) && (upTo === undefined || m.version.slice(0, 4) <= upTo));
}

/**
 * Copy the DB aside before changing its schema. Skipped for in-memory DBs and
 * for brand-new files (no entries table yet = nothing to lose).
 * VACUUM INTO writes a consistent snapshot even with WAL, and never touches
 * the source's rowids.
 */
function backupBeforeMigrating(db: DB, firstPending: string): void {
  if (db.memory) return;
  const hasEntries = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'`)
    .get();
  if (!hasEntries) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  db.prepare("VACUUM INTO ?").run(`${db.name}.bak-${firstPending}-${stamp}`);
}

function applyMigrations(db: DB, pending: Pending[]): string[] {
  if (pending.length > 0) backupBeforeMigrating(db, pending[0].version);
  for (const m of pending) {
    // Each migration file owns its BEGIN/COMMIT; we just exec.
    db.exec(readFileSync(m.file, "utf-8"));
  }
  // Runs every startup, not only when 0005 applies: it repairs rows written by
  // paths that bypass core (scripts, the REST server). Cheap: WHERE ... IS NULL.
  const hasUlid = (db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'ulid'`).get());
  if (hasUlid) backfillUlids(db);
  return pending.map((m) => m.version);
}

/** Apply any un-applied migrations in lexical order. Idempotent. */
export function migrate(db: DB = getDb(), opts: MigrateOptions = {}): string[] {
  return applyMigrations(db, pendingMigrations(db, undefined, opts));
}

/** Test helper: apply migrations whose 4-digit prefix is <= `upTo` (e.g. "0004"). */
export function migrateTo(db: DB, upTo: string, opts: MigrateOptions = {}): string[] {
  return applyMigrations(db, pendingMigrations(db, upTo, opts));
}
```

Add `existsSync` to the `node:fs` import.

Create the `core/src/backfill.ts` stub:

```ts
import type { DB } from "./db.js";

export interface BackfillReport {
  entries: number;
  refs: number;
  entryModules: number;
  superseded: number;
  authors: number;
  unresolvedEntryRefs: Array<{ entry_id: number; ref_value: string }>;
  skippedEntries: Array<{ id: number; created_at: string; error: string }>;
}

export function backfillUlids(_db: DB): BackfillReport {
  return { entries: 0, refs: 0, entryModules: 0, superseded: 0, authors: 0, unresolvedEntryRefs: [], skippedEntries: [] };
}
```

The file imports `type { DB }` from db.ts while db.ts imports the function from backfill.ts. That's a type-only cycle, so it's safe under ESM.

- [ ] **Step 4: Run and confirm pass** (background subagent). Expected: 3 pass, 1 todo.
- [ ] **Step 5: Checkpoint: user commits.**

---

### Task 3: `0005_ulid_expand.sql` (staged)

**Files:**
- Create: `mcp/migrations/staged/0005_ulid_expand.sql` (**not** `mcp/migrations/`, see Global Constraints)
- Test: `core/test/migrate-0005.test.ts` (add cases)

**Interfaces:**
- Consumes:
  - `migrate`, `migrateTo` (Task 2)
  - `parseEntryRef` (Task 1), used for the parity test
- Produces these columns:
  - `entries.ulid`, `entries.author`, `entries.superseded_by_ulid`
  - `refs.entry_ulid`, `refs.target_ulid`
  - `entry_modules.entry_ulid`
  - `modules.hub`
  - the `entry_revisions` table
- Produces these triggers:
  - `trg_refs_fill_ulids`
  - `trg_entry_modules_fill_ulid`
  - `trg_entries_fill_superseded_ulid`
  - `trg_entries_revision`
- Produces these indexes:
  - `idx_entries_ulid`
  - `idx_refs_entry_ulid`
  - `idx_refs_target_ulid`
  - `idx_entry_modules_entry_ulid`
  - `idx_entry_revisions_entry`

- [ ] **Step 1: Write the failing tests** (append to `migrate-0005.test.ts`)

```ts
import { migrateTo } from '../src/db.js';
import { parseEntryRef } from '../src/ulid.js';

function insertEntry(db: Database.Database, id: number, ulid: string | null, title = 't' + id) {
  db.prepare(`INSERT INTO entries (id, type, kind, title, summary, ulid) VALUES (?, 'decision', 'signal', ?, 's', ?)`)
    .run(id, title, ulid);
}

test('0005 adds the new columns and table', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const cols = (t: string) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((r: any) => r.name);
    for (const c of ['ulid', 'author', 'superseded_by_ulid']) assert.ok(cols('entries').includes(c), c);
    for (const c of ['entry_ulid', 'target_ulid']) assert.ok(cols('refs').includes(c), c);
    assert.ok(cols('entry_modules').includes('entry_ulid'));
    assert.ok(cols('modules').includes('hub'));
    assert.ok(cols('entry_revisions').includes('parent_rev_id'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('no UNIQUE index on any new column (cr-sqlite rule)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const uniques = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%'`).all();
    assert.deepEqual(uniques, []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refs trigger fills entry_ulid and target_ulid for every legacy link format', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    insertEntry(db, 214, 'U214');
    insertEntry(db, 116, 'U116');
    const values = ['214', 'E-214', 'E-00214', 'e-214', 'E214', '#116', ' 214 ', 'T-011', 'abc', '0', '999'];
    const ins = db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'entry', ?)`);
    for (const v of values) ins.run(v);
    const rows = db.prepare(`SELECT ref_value, entry_ulid, target_ulid FROM refs WHERE entry_id = 1`).all() as any[];
    for (const r of rows) {
      assert.equal(r.entry_ulid, 'U1');
      // Parity: the SQL parser must agree with parseEntryRef on every input (Review Focus #2).
      const id = parseEntryRef(r.ref_value);
      const want = id === 214 ? 'U214' : id === 116 ? 'U116' : null;
      assert.equal(r.target_ulid, want, `ref_value=${JSON.stringify(r.ref_value)}`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('non-entry refs get entry_ulid but never target_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'file', '214')`).run();
    const r = db.prepare(`SELECT entry_ulid, target_ulid FROM refs`).get() as any;
    assert.deepEqual(r, { entry_ulid: 'U1', target_ulid: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('entry_modules trigger fills entry_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (1, 'demo', 1)`).run();
    assert.equal((db.prepare(`SELECT entry_ulid FROM entry_modules`).get() as any).entry_ulid, 'U1');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setting superseded_by fills superseded_by_ulid', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    insertEntry(db, 2, 'U2');
    db.prepare(`UPDATE entries SET superseded_by = 2, deprecated = 1 WHERE id = 1`).run();
    assert.equal((db.prepare(`SELECT superseded_by_ulid FROM entries WHERE id = 1`).get() as any).superseded_by_ulid, 'U2');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

Also flip Task 2's backup test from `todo` to live.

- [ ] **Step 2: Run and confirm they fail** (background subagent). Expected: FAIL, `no such column: ulid`.

- [ ] **Step 3: Write `mcp/migrations/staged/0005_ulid_expand.sql`**

```sql
-- ============================================================
-- Collab — team-sync schema, EXPAND phase (E-674, E-646, E-648, E-651, E-657)
-- Migration: 0005_ulid_expand
--
-- Additive only. The integer id stays the working key; every existing read and
-- write keeps working. 0006 (contract) makes ulid the PK and drops the old keys.
--
-- Who fills what:
--   entries.ulid            -> JS at insert (core) + startup backfill (stragglers)
--   refs/entry_modules keys -> triggers below (connection-independent)
--   superseded_by_ulid      -> trigger below
--   entry_revisions         -> trigger below
-- No UNIQUE indexes: cr-sqlite forbids them besides the PK (E-646).
-- ============================================================

BEGIN;

ALTER TABLE entries ADD COLUMN ulid TEXT;                -- permanent identity; PK in 0006
ALTER TABLE entries ADD COLUMN author TEXT;              -- machine owner (D2); not the agent
ALTER TABLE entries ADD COLUMN superseded_by_ulid TEXT;  -- ULID twin of superseded_by
CREATE INDEX IF NOT EXISTS idx_entries_ulid ON entries(ulid);

ALTER TABLE refs ADD COLUMN entry_ulid TEXT;   -- the owning entry
ALTER TABLE refs ADD COLUMN target_ulid TEXT;  -- ref_type='entry' only: the entry pointed at
CREATE INDEX IF NOT EXISTS idx_refs_entry_ulid  ON refs(entry_ulid);
CREATE INDEX IF NOT EXISTS idx_refs_target_ulid ON refs(target_ulid);

ALTER TABLE entry_modules ADD COLUMN entry_ulid TEXT;
CREATE INDEX IF NOT EXISTS idx_entry_modules_entry_ulid ON entry_modules(entry_ulid);

ALTER TABLE modules ADD COLUMN hub TEXT;  -- ULID of the module's hub entry (E-657)

-- ------------------------------------------------------------
-- updated_at means "content last changed" (decision D6). The old trigger fired
-- on ANY update, so backfilling ulid/author would stamp all history with the
-- migration time. Re-create it to watch content columns only; the new
-- bookkeeping columns (ulid, author, superseded_by_ulid) never bump it.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_entries_updated_at;
CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category, superseded_by
ON entries
FOR EACH ROW
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ------------------------------------------------------------
-- Edit history for three-way merge (E-651, decision D5).
-- rev_id is random, not a per-entry counter: two machines editing at once
-- must never mint the same revision key.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_revisions (
  rev_id        TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entry_ulid    TEXT NOT NULL DEFAULT '',
  parent_rev_id TEXT,
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_entry_revisions_entry ON entry_revisions(entry_ulid, created_at);

-- ------------------------------------------------------------
-- Fill triggers. The legacy link parser here MUST match parseEntryRef()
-- in core/src/ulid.ts: "214", "E-214", "E-00214", "E214", "#116", any case,
-- trimmed. A parity test enforces it.
-- ------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_refs_fill_ulids
AFTER INSERT ON refs
BEGIN
  UPDATE refs SET
    entry_ulid = COALESCE(NEW.entry_ulid, (SELECT ulid FROM entries WHERE id = NEW.entry_id)),
    target_ulid = CASE WHEN NEW.ref_type <> 'entry' THEN NULL ELSE COALESCE(NEW.target_ulid, (
      SELECT e.ulid FROM entries e WHERE e.id = (
        SELECT CAST(d AS INTEGER) FROM (
          SELECT CASE
            WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
            WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
            WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
            ELSE s
          END AS d
          FROM (SELECT upper(trim(NEW.ref_value)) AS s)
        )
        WHERE d <> '' AND d NOT GLOB '*[^0-9]*' AND CAST(d AS INTEGER) > 0
      )
    )) END
  WHERE entry_id = NEW.entry_id AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END;

CREATE TRIGGER IF NOT EXISTS trg_entry_modules_fill_ulid
AFTER INSERT ON entry_modules
WHEN NEW.entry_ulid IS NULL
BEGIN
  UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = NEW.entry_id)
  WHERE entry_id = NEW.entry_id AND module = NEW.module;
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT ulid FROM entries WHERE id = NEW.superseded_by)
   WHERE id = NEW.id;
END;

-- First real edit records the pre-edit text as the root (the merge base),
-- then every real edit appends a child of the latest revision.
-- `IS NOT` treats NULL = NULL, so a full-row rewrite with identical text is a no-op.
CREATE TRIGGER IF NOT EXISTS trg_entries_revision
AFTER UPDATE OF title, summary, description ON entries
WHEN NEW.ulid IS NOT NULL
 AND (OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.description IS NOT NEW.description)
BEGIN
  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description, created_at)
  SELECT NEW.ulid, NULL, OLD.title, OLD.summary, OLD.description, OLD.created_at
   WHERE NOT EXISTS (SELECT 1 FROM entry_revisions WHERE entry_ulid = NEW.ulid);

  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description)
  VALUES (
    NEW.ulid,
    (SELECT rev_id FROM entry_revisions WHERE entry_ulid = NEW.ulid ORDER BY created_at DESC, rowid DESC LIMIT 1),
    NEW.title, NEW.summary, NEW.description
  );
END;

INSERT INTO schema_migrations (version) VALUES ('0005_ulid_expand');

COMMIT;

-- Verify after apply:
--   SELECT COUNT(*) FROM entries WHERE ulid IS NULL;                        -- expect 0 (after backfill)
--   SELECT COUNT(*) FROM refs WHERE entry_ulid IS NULL;                     -- expect 0
--   SELECT COUNT(*) FROM refs WHERE ref_type='entry' AND target_ulid IS NULL; -- = unresolved list
```

Note for the implementer: the `CAST(d AS INTEGER) > 0` guard is what makes `'0'` resolve to NULL, matching `parseEntryRef`. If the parity test fails on one input, fix the SQL. `parseEntryRef` is the specification.

- [ ] **Step 4: Run and confirm pass** (background subagent): all tests in `migrate-0005.test.ts` and `ulid.test.ts`.
- [ ] **Step 5: Checkpoint: user commits.**

---

### Task 4: `backfillUlids`: the idempotent repair pass

**Files:**
- Modify: `core/src/backfill.ts` (replace the stub)
- Modify: `core/src/index.ts` (add `export * from './backfill.js';`)
- Test: `core/test/migrate-0005.test.ts` (add cases)

**Interfaces:**
- Consumes:
  - `ulidFromLegacy`, `parseEntryRef` (Task 1)
  - `resolveAuthor` (Task 1)
  - the 0005 columns (Task 3)
- Produces: `backfillUlids(db: DB): BackfillReport`, called by `migrate()` on every run.

- [ ] **Step 1: Write the failing tests**

```ts
import { backfillUlids } from '../src/backfill.js';

function seedLegacy(db: Database.Database) {
  // Build a pre-0005 DB with realistic data, then migrate it.
  migrateTo(db, '0004');
  const ins = db.prepare(`INSERT INTO entries (id, type, kind, title, summary, created_at) VALUES (?, 'decision', 'signal', ?, 's', ?)`);
  ins.run(1, 'first', '2026-04-22 20:14:14');
  ins.run(2, 'same second', '2026-04-22 20:14:14');
  ins.run(5, 'later', '2026-05-01 09:00:00');           // ids 3,4 "deleted"
  db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (5, 'entry', 'E-00001'), (5, 'entry', '#2'), (5, 'entry', '3'), (5, 'file', 'a.ts')`).run();
  db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (1, 'demo', 1), (5, 'demo', 1)`).run();
  db.prepare(`UPDATE entries SET superseded_by = 5, deprecated = 1 WHERE id = 1`).run();
}

test('migrating a legacy DB assigns every ULID and every link key', () => {
  const { db, dir } = tempDb();
  try {
    seedLegacy(db);
    migrate(db);
    const q = (sql: string) => (db.prepare(sql).get() as any).c;
    assert.equal(q(`SELECT COUNT(*) c FROM entries WHERE ulid IS NULL`), 0);
    assert.equal(q(`SELECT COUNT(*) c FROM entries WHERE author IS NULL`), 0);
    assert.equal(q(`SELECT COUNT(*) c FROM refs WHERE entry_ulid IS NULL`), 0);
    assert.equal(q(`SELECT COUNT(*) c FROM entry_modules WHERE entry_ulid IS NULL`), 0);
    const u = (id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid;
    assert.equal((db.prepare(`SELECT superseded_by_ulid s FROM entries WHERE id = 1`).get() as any).s, u(5));
    const t = (v: string) => (db.prepare(`SELECT target_ulid t FROM refs WHERE ref_value = ?`).get(v) as any).t;
    assert.equal(t('E-00001'), u(1));
    assert.equal(t('#2'), u(2));
    assert.equal(t('3'), null);                         // points at a deleted entry: kept, unresolved
    assert.equal(t('a.ts'), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ULID order equals E-number order (D1)', () => {
  const { db, dir } = tempDb();
  try {
    seedLegacy(db);
    migrate(db);
    const byUlid = db.prepare(`SELECT id FROM entries ORDER BY ulid`).all().map((r: any) => r.id);
    const byId = db.prepare(`SELECT id FROM entries ORDER BY id`).all().map((r: any) => r.id);
    assert.deepEqual(byUlid, byId);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two separate copies migrate to identical ULIDs (Review Focus #4)', () => {
  const a = tempDb(), b = tempDb();
  try {
    seedLegacy(a.db); seedLegacy(b.db);
    migrate(a.db); migrate(b.db);
    const all = (db: Database.Database) => db.prepare(`SELECT id, ulid FROM entries ORDER BY id`).all();
    assert.deepEqual(all(a.db), all(b.db));
  } finally {
    a.db.close(); b.db.close();
    rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
  }
});

test('backfill is idempotent and reports unresolved links', () => {
  const { db, dir } = tempDb();
  try {
    seedLegacy(db);
    migrate(db);
    const snapshot = db.prepare(`SELECT id, ulid FROM entries ORDER BY id`).all();
    const report = backfillUlids(db);
    assert.equal(report.entries, 0);
    assert.deepEqual(report.unresolvedEntryRefs, [{ entry_id: 5, ref_value: '3' }]);
    assert.deepEqual(db.prepare(`SELECT id, ulid FROM entries ORDER BY id`).all(), snapshot);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backfill preserves updated_at; a real edit still bumps it (D6)', () => {
  const { db, dir } = tempDb();
  try {
    migrateTo(db, '0004');
    db.prepare(`INSERT INTO entries (id, type, kind, title, summary, created_at, updated_at) VALUES (1, 'decision', 'signal', 't', 's', '2026-04-22 20:14:14', '2026-04-23 08:00:00')`).run();
    migrate(db);
    assert.equal((db.prepare(`SELECT updated_at u FROM entries WHERE id = 1`).get() as any).u, '2026-04-23 08:00:00');
    db.prepare(`UPDATE entries SET title = 't2' WHERE id = 1`).run();
    assert.notEqual((db.prepare(`SELECT updated_at u FROM entries WHERE id = 1`).get() as any).u, '2026-04-23 08:00:00');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backfill repairs a row inserted without a ulid (Review Focus #1)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    // What log-collab.ts and the REST server do: raw insert, no ulid.
    db.prepare(`INSERT INTO entries (id, type, kind, title, summary) VALUES (7, 'gotcha', 'signal', 'raw', 's')`).run();
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (7, 'file', 'x.ts')`).run();
    db.prepare(`INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (7, 'demo', 1)`).run();
    const report = backfillUlids(db);
    assert.equal(report.entries, 1);
    const ulid = (db.prepare(`SELECT ulid FROM entries WHERE id = 7`).get() as any).ulid;
    assert.match(ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal((db.prepare(`SELECT entry_ulid e FROM refs WHERE entry_id = 7`).get() as any).e, ulid);
    assert.equal((db.prepare(`SELECT entry_ulid e FROM entry_modules WHERE entry_id = 7`).get() as any).e, ulid);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unparseable created_at is skipped and reported, never thrown', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    db.prepare(`INSERT INTO entries (id, type, kind, title, summary, created_at) VALUES (3, 'gotcha', 'signal', 'odd', 's', '22/04/2026')`).run();
    db.prepare(`INSERT INTO entries (id, type, kind, title, summary) VALUES (4, 'gotcha', 'signal', 'fine', 's')`).run();
    const report = backfillUlids(db);                       // must not throw
    assert.deepEqual(report.skippedEntries.map((s) => s.id), [3]);
    assert.equal(report.entries, 1);                        // entry 4 still filled
    assert.doesNotThrow(() => migrate(db));                 // and startup keeps working
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a forward link resolves once its target exists (Review Focus #3)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'entry', 'E-9')`).run();
    assert.equal((db.prepare(`SELECT target_ulid t FROM refs`).get() as any).t, null);
    insertEntry(db, 9, 'U9');
    backfillUlids(db);
    assert.equal((db.prepare(`SELECT target_ulid t FROM refs`).get() as any).t, 'U9');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run and confirm they fail** (background subagent). Expected: FAIL, because the stub assigns nothing (`ulid IS NULL` count is 3, not 0).

- [ ] **Step 3: Implement `core/src/backfill.ts`**

```ts
import type { DB } from "./db.js";
import { ulidFromLegacy, parseEntryRef } from "./ulid.js";
import { resolveAuthor } from "./author.js";

export interface BackfillReport {
  entries: number;
  refs: number;
  entryModules: number;
  superseded: number;
  authors: number;
  unresolvedEntryRefs: Array<{ entry_id: number; ref_value: string }>;
  skippedEntries: Array<{ id: number; created_at: string; error: string }>;
}

/**
 * Fill every ULID-shaped column that is still NULL. Idempotent; runs on every
 * migrate(). Entries get a DETERMINISTIC ulid (ulidFromLegacy), so a row
 * repaired here gets the same ulid on every machine that holds it.
 * Unresolvable entry links are reported, never deleted (decision D4).
 *
 * MUST NOT THROW on bad data: it runs inside every server start, so one odd
 * row would stop every collab session from opening. Bad rows are skipped,
 * reported, and surfaced by doctor's data.entries_without_ulid.
 */
export function backfillUlids(db: DB): BackfillReport {
  const run = db.transaction((): BackfillReport => {
    const missing = db
      .prepare(`SELECT id, created_at, title FROM entries WHERE ulid IS NULL ORDER BY id`)
      .all() as Array<{ id: number; created_at: string; title: string }>;
    const setUlid = db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`);
    const skippedEntries: BackfillReport["skippedEntries"] = [];
    let filled = 0;
    for (const r of missing) {
      try {
        setUlid.run(ulidFromLegacy(r.id, r.created_at, r.title), r.id);
        filled++;
      } catch (e) {
        skippedEntries.push({ id: r.id, created_at: r.created_at, error: (e as Error).message });
      }
    }
    if (skippedEntries.length > 0) {
      console.error(`[collab-mcp] backfill skipped ${skippedEntries.length} entries with unusable created_at; run collab_doctor`);
    }

    const author = resolveAuthor();
    const authors = author
      ? db.prepare(`UPDATE entries SET author = ? WHERE author IS NULL`).run(author).changes
      : 0;

    const refs = db.prepare(`
      UPDATE refs SET entry_ulid = (SELECT ulid FROM entries WHERE id = refs.entry_id)
       WHERE entry_ulid IS NULL
    `).run().changes;

    const entryModules = db.prepare(`
      UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = entry_modules.entry_id)
       WHERE entry_ulid IS NULL
    `).run().changes;

    const superseded = db.prepare(`
      UPDATE entries SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = entries.superseded_by)
       WHERE superseded_by IS NOT NULL AND superseded_by_ulid IS NULL
    `).run().changes;

    // Entry links: parsed in JS with the same rules as the SQL trigger.
    const pending = db
      .prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type = 'entry' AND target_ulid IS NULL ORDER BY entry_id, ref_value`)
      .all() as Array<{ entry_id: number; ref_value: string }>;
    const ulidOf = db.prepare(`SELECT ulid FROM entries WHERE id = ?`);
    const setTarget = db.prepare(
      `UPDATE refs SET target_ulid = ? WHERE entry_id = ? AND ref_type = 'entry' AND ref_value = ?`,
    );
    const unresolvedEntryRefs: BackfillReport["unresolvedEntryRefs"] = [];
    for (const r of pending) {
      const id = parseEntryRef(r.ref_value);
      const hit = id === null ? undefined : (ulidOf.get(id) as { ulid: string | null } | undefined);
      if (hit?.ulid) setTarget.run(hit.ulid, r.entry_id, r.ref_value);
      else unresolvedEntryRefs.push(r);
    }

    return { entries: filled, refs, entryModules, superseded, authors, unresolvedEntryRefs, skippedEntries };
  });
  return run();
}
```

Note for the implementer: `UPDATE entries SET ulid/author/superseded_by_ulid` must **not** change `updated_at`. 0005 narrows `trg_entries_updated_at` to content columns (D6), and the test `backfill preserves updated_at` pins it. The FTS update trigger still re-indexes each backfilled row. That's harmless, and 0006 replaces that index anyway.

- [ ] **Step 4: Run and confirm pass** (background subagent).
- [ ] **Step 5: Checkpoint: user commits.**

---

### Task 5: Core write paths stamp `ulid` + `author`; revisions verified

**Files:**
- Modify: `core/src/ops/add.ts:127-151` (insert statement and params)
- Modify: `core/src/ops/rollup.ts` (both `insertRollup` statements, ~:214 and ~:368)
- Test: `core/test/migrate-0005.test.ts` (add cases)

**Interfaces:**
- Consumes: `newUlid`, `resolveAuthor` (Task 1)
- Produces: `addEntry(...)`'s return shape is **unchanged** (`{ id, ... }`), so the MCP and REST responses keep their E-numbers.

- [ ] **Step 1: Write the failing tests**

```ts
import { addEntry } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';

test('addEntry stamps ulid and author, and triggers key its refs/modules', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    process.env.COLLAB_AUTHOR = 'tester';
    const target = addEntry(db, { type: 'decision', title: 'target', summary: 's', module: 'demo' });
    const { id } = addEntry(db, {
      type: 'gotcha', title: 'x', summary: 's', module: 'demo',
      refs: [{ ref_type: 'entry', ref_value: `E-${String(target.id).padStart(5, '0')}` }],
    });
    const row = db.prepare(`SELECT ulid, author FROM entries WHERE id = ?`).get(id) as any;
    assert.match(row.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(row.author, 'tester');
    const ref = db.prepare(`SELECT entry_ulid, target_ulid FROM refs WHERE entry_id = ?`).get(id) as any;
    assert.equal(ref.entry_ulid, row.ulid);
    assert.equal(ref.target_ulid, (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(target.id) as any).ulid);
  } finally { delete process.env.COLLAB_AUTHOR; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a real edit writes a root + child revision; an identical rewrite writes none (Review Focus #5)', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const { id } = addEntry(db, { type: 'decision', title: 'v1', summary: 's1', module: 'demo' });
    const count = () => (db.prepare(`SELECT COUNT(*) c FROM entry_revisions`).get() as any).c;

    db.prepare(`UPDATE entries SET title = title, summary = summary, description = description WHERE id = ?`).run(id);
    assert.equal(count(), 0);

    updateEntry(db, { id, title: 'v2' });
    const revs = db.prepare(`SELECT title, parent_rev_id FROM entry_revisions ORDER BY created_at, rowid`).all() as any[];
    assert.equal(revs.length, 2);
    assert.deepEqual([revs[0].title, revs[0].parent_rev_id], ['v1', null]);   // root = pre-edit text
    assert.equal(revs[1].title, 'v2');
    assert.ok(revs[1].parent_rev_id);

    updateEntry(db, { id, summary: 's3' });
    assert.equal(count(), 3);                                                  // no second root
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

import { rollup } from '../src/ops/rollup.js';

test('rollup inserts get a ulid and author', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    // Insert rollup-eligible rows directly (addEntry's task auto-advance needs a tasks row we don't care about here).
    for (const t of ['a', 'b']) {
      db.prepare(`INSERT INTO entries (type, kind, title, summary, task_id, module, ulid) VALUES ('session-note', 'log', ?, 's', 'T-900', 'demo', ?)`)
        .run(t, 'U' + t);
    }
    const result = rollup(db, { task_id: 'T-900', agent: 'Claude' });
    assert.ok(result.created_entries.length > 0, 'rollup created nothing: check which types/kinds it groups');
    const nulls = (db.prepare(`SELECT COUNT(*) c FROM entries WHERE type = 'rollup' AND (ulid IS NULL OR author IS NULL)`).get() as any).c;
    assert.equal(nulls, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

If the `created_entries.length > 0` assertion fails, rollup's grouping filters out `session-note`/`log` rows. Read `rollup.ts:183` onward, pick the type it does roll up, and change only the seed rows. The ulid/author assertion stays exactly as written.

Without `COLLAB_AUTHOR`, `author` comes from the OS username. That's non-null on dev machines, so the assertion holds.

- [ ] **Step 2: Run and confirm they fail** (background subagent). Expected: the first test fails on `row.ulid` being NULL before the next backfill.

- [ ] **Step 3: Implement.** In `add.ts`, add `ulid, author` to the column list and `@ulid, @author` to VALUES, then in `insertEntry.run({...})`:

```ts
      ulid: newUlid(),
      author: resolveAuthor(),
```

with `import { newUlid } from "../ulid.js"; import { resolveAuthor } from "../author.js";`. Make the same two-column addition to **both** `insertRollup` statements in `rollup.ts` and their `.run({...})` params.

- [ ] **Step 4: Run and confirm pass** (background subagent): `ulid.test.ts` + `migrate-0005.test.ts`, plus the existing `validate.test.ts` and `db-path.test.ts` to catch regressions.
- [ ] **Step 5: Checkpoint: user commits.**

---

### Task 6: Doctor knows the new schema and reports gaps

**Files:**
- Modify: `core/src/ops/doctor.ts` (`EXPECTED_TABLES`, `EXPECTED_INDEXES`, `EXPECTED_TRIGGERS`, plus two new checks after check 9)
- Test: `core/test/migrate-0005.test.ts` (add cases)

**Interfaces:**
- Consumes: the 0005 schema
- Produces two new doctor checks:
  - `data.entries_without_ulid` (severity error if > 0)
  - `data.unresolved_entry_refs` (warn if > 0, with items `E-00005 -> "3"`)

- [ ] **Step 1: Write the failing tests**

```ts
import { doctor } from '../src/ops/doctor.js';

test('doctor on a fresh 0005 DB reports no schema drift', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    const r = doctor(db);
    for (const name of ['schema.tables', 'schema.indexes', 'schema.triggers']) {
      const c = r.checks.find((x) => x.name === name);
      assert.equal(c?.severity, 'ok', `${name}: ${JSON.stringify(c?.items)}`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('doctor flags unresolved entry links and missing ulids', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    insertEntry(db, 1, 'U1');
    db.prepare(`INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (1, 'entry', 'E-404')`).run();
    insertEntry(db, 2, null);
    const r = doctor(db);
    const unresolved = r.checks.find((x) => x.name === 'data.unresolved_entry_refs');
    assert.equal(unresolved?.severity, 'warn');
    assert.deepEqual(unresolved?.items, ['E-00001 -> "E-404"']);
    assert.equal(r.checks.find((x) => x.name === 'data.entries_without_ulid')?.severity, 'error');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run and confirm they fail** (background subagent). Expected: schema checks warn `extra:…` for the new objects, and the two data checks don't exist yet.

- [ ] **Step 3: Implement.** Add these to the expected sets:
  - **Tables:** `entry_revisions`
  - **Indexes:** `idx_entries_ulid`, `idx_refs_entry_ulid`, `idx_refs_target_ulid`, `idx_entry_modules_entry_ulid`, `idx_entry_revisions_entry`. Autoindexes are already excluded (`doctor.ts:125`), so the `entry_revisions` PK needs no entry.
  - **Triggers:** `trg_refs_fill_ulids`, `trg_entry_modules_fill_ulid`, `trg_entries_fill_superseded_ulid`, `trg_entries_revision`

Then add, after check 9:

```ts
  // 10) data.entries_without_ulid — should be 0 after migrate()'s backfill
  const noUlid = db.prepare(`SELECT id FROM entries WHERE ulid IS NULL ORDER BY id`).all() as Array<{ id: number }>;
  checks.push({
    name: "data.entries_without_ulid",
    severity: noUlid.length > 0 ? "error" : "ok",
    detail: noUlid.length > 0
      ? `found ${noUlid.length} entries without a ulid; restart the server (migrate() backfills them)`
      : "every entry has a ulid",
    items: noUlid.length > 0 ? noUlid.map((r) => toEntryId(r.id)) : undefined,
  });

  // 11) data.unresolved_entry_refs — entry links whose target could not be matched (kept, never deleted)
  const unresolved = db.prepare(`
    SELECT entry_id, ref_value FROM refs
     WHERE ref_type = 'entry' AND target_ulid IS NULL
     ORDER BY entry_id, ref_value
  `).all() as Array<{ entry_id: number; ref_value: string }>;
  checks.push({
    name: "data.unresolved_entry_refs",
    severity: unresolved.length > 0 ? "warn" : "ok",
    detail: unresolved.length > 0
      ? `found ${unresolved.length} entry links that point at no existing entry`
      : "every entry link resolves",
    items: unresolved.length > 0 ? unresolved.map((r) => `${toEntryId(r.entry_id)} -> ${JSON.stringify(r.ref_value)}`) : undefined,
  });
```

Renumber the following comments (fts checks become 12 and 13).

- [ ] **Step 4: Run and confirm pass** (background subagent).
- [ ] **Step 5: Golden snapshots (user runs, since it needs the server build).** Regenerate `test/golden/__snapshots__/rest_modules.json` and `rest_doctor.json`. **Expected diff, nothing else:** `"hub": null` on each module, the updated doctor schema counts, and the two new checks. Any other diff is a regression, so stop and report it.
- [ ] **Step 6: Checkpoint: user commits.**

---

### Task 7: Rehearsal on a copy of the real DB, then the live apply

**Files:**
- Create: `mcp/src/scripts/rehearse-0005.ts`

**Interfaces:**
- Consumes:
  - `getDb`, `closeDb`, `migrate` (core)
  - `backfillUlids` (Task 4)
  - `doctor` (Task 6)

- [ ] **Step 1: Write the script.** It opens the source **read-only**, snapshots it with `VACUUM INTO` into a temp dir, migrates the copy **twice** (two separate copies), and prints a report. It never writes to the source.

```ts
#!/usr/bin/env node
/**
 * Rehearse 0005 on a COPY of a real collab DB. Never writes to the source.
 *   npx tsx src/scripts/rehearse-0005.ts <path-to-collab.db>
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative SOURCE imports on purpose: "@collab-mcp/core" resolves to core/dist,
// which is the old build until the user rebuilds. tsx runs the .ts directly.
import { migrate as migrateProd } from "../../../core/src/db.js";
import { doctor } from "../../../core/src/ops/doctor.js";
import { searchEntries } from "../../../core/src/ops/search.js";

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });
// Terms that must find the same entry ids before and after (E-643: rows existing != search finding them).
const PROBE_TERMS = ["migration", "supporthub", "timesheet"];

const source = process.argv[2];
if (!source) throw new Error("usage: rehearse-0005.ts <path-to-collab.db>");

const dir = mkdtempSync(join(tmpdir(), "rehearse-0005-"));
const src = new Database(source, { readonly: true, fileMustExist: true });
const copyA = join(dir, "a.db"), copyB = join(dir, "b.db");
src.prepare("VACUUM INTO ?").run(copyA);
src.prepare("VACUUM INTO ?").run(copyB);
const beforeUpdatedAt = new Map(
  (src.prepare("SELECT id, updated_at FROM entries").all() as any[]).map((r) => [r.id, r.updated_at]),
);
src.close();

const a = new Database(copyA), b = new Database(copyB);
const hits = (db: Database.Database) =>
  Object.fromEntries(PROBE_TERMS.map((t) => [t, searchEntries(db, { query: t, kind: "any", limit: 50 }).results.map((r: any) => r.id).sort()]));
const searchBefore = hits(a);
const appliedA = migrate(a); migrate(b);
const searchAfter = hits(a);
let ftsIntegrity = "ok";
try { a.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')"); }
catch (e) { ftsIntegrity = (e as Error).message; }

const one = (db: Database.Database, sql: string) => (db.prepare(sql).get() as any).c as number;
const ids = (sql: string) => a.prepare(sql).all().map((r: any) => r.id);
const same = JSON.stringify(ids("SELECT id FROM entries ORDER BY ulid")) === JSON.stringify(ids("SELECT id FROM entries ORDER BY id"));
const deterministic =
  JSON.stringify(a.prepare("SELECT id, ulid FROM entries ORDER BY id").all()) ===
  JSON.stringify(b.prepare("SELECT id, ulid FROM entries ORDER BY id").all());
const updatedAtChanged = (a.prepare("SELECT id, updated_at FROM entries").all() as any[])
  .filter((r) => beforeUpdatedAt.get(r.id) !== r.updated_at).length;

const report = {
  applied: appliedA,
  entries: one(a, "SELECT COUNT(*) c FROM entries"),
  entriesWithoutUlid: one(a, "SELECT COUNT(*) c FROM entries WHERE ulid IS NULL"),
  refsWithoutEntryUlid: one(a, "SELECT COUNT(*) c FROM refs WHERE entry_ulid IS NULL"),
  entryModulesWithoutUlid: one(a, "SELECT COUNT(*) c FROM entry_modules WHERE entry_ulid IS NULL"),
  entryLinks: one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry'"),
  entryLinksUnresolved: one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry' AND target_ulid IS NULL"),
  supersededResolved: `${one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by_ulid IS NOT NULL")} / ${one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by IS NOT NULL")}`,
  ulidOrderEqualsIdOrder: same,
  deterministicAcrossCopies: deterministic,
  updatedAtChanged,
  ftsIntegrity,
  searchUnchanged: JSON.stringify(searchBefore) === JSON.stringify(searchAfter),
  doctor: doctor(a).checks.filter((c) => c.severity !== "ok").map((c) => ({ name: c.name, severity: c.severity, detail: c.detail, items: c.items?.slice(0, 20) })),
  copies: dir,
};
console.log(JSON.stringify(report, null, 2));
a.close(); b.close();
```

- [ ] **Step 2: Run it against the live DB path** (it only reads the source): `cd internal-tools/mcp && npx tsx src/scripts/rehearse-0005.ts C:/Users/NaveenPrajapati/Downloads/dev/frontend2/internal-tools/mcp/collab.db`.

**Pass criteria:**
- `entriesWithoutUlid`, `refsWithoutEntryUlid` and `entryModulesWithoutUlid` are all 0
- `ulidOrderEqualsIdOrder` and `deterministicAcrossCopies` are both true
- `supersededResolved` is `4 / 4`
- `ftsIntegrity` is `"ok"` and `searchUnchanged` is true
- `entryLinksUnresolved` is reviewed **by the user**: expected 0 of 964, since the earlier probe found no numeric link to a missing entry and the 144 prefixed ones should all parse. Every item in the list is either explained or fixed.
- `updatedAtChanged` is 0 (D6)
- The doctor output shows no `error`.

- [ ] **Step 3: If any criterion fails, stop.** Log a gotcha to collab (module `collab-mcp`) with the report, and don't continue.

- [ ] **Step 4: Live apply (the user runs this; order matters):**
  1. Close every Claude/Codex session using the collab MCP server, and stop the REST server. Nothing may hold `collab.db` open.
  2. **Build** core and mcp, so every server that starts later runs the new `migrate()` with its backup and backfill.
  3. **Release** the migration: move `mcp/migrations/staged/0005_ulid_expand.sql` to `mcp/migrations/0005_ulid_expand.sql`.
  4. `cd internal-tools/mcp && npx tsx src/migrate.ts`. The new `migrate()` writes `collab.db.bak-0005_ulid_expand-<stamp>` first. Confirm the file exists before going on.
  5. Restart one session and run `collab_doctor`. Expect `data.entries_without_ulid` = ok.
  6. `collab_get` any entry and confirm it now shows `ulid` and `author`.

  Rollback: stop the servers, replace `collab.db` with the `.bak-0005…` file, and move the SQL back to `staged/`.

- [ ] **Step 5: Log the result to collab**, as a changelog in module `collab-mcp` linked to E-674: the rehearsal report numbers, the backup filename, and the unresolved-link verdict. Then write the 0006 plan.
- [ ] **Step 6: Checkpoint: user commits.**

---

## What this plan deliberately does not do

- It doesn't change any read path, any MCP tool's input or output shape (beyond new fields appearing in `collab_get`), the FTS index, or the server's `rowid` usage. All of that is 0006.
- **No Turso, no relay, no cr-sqlite loading.** The cr-sqlite `crsql_as_crr` check belongs to 0006, once `ulid` is the PK.
- No T-011, no post-sync re-index. These come after 0006, per E-674's order.
