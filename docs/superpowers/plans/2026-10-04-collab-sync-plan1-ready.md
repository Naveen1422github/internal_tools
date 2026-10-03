# Sync v1, Plan 1 of 3: Notes Ready for Sharing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a notes database *able* to be shared without sharing anything yet. That means: load the cr-sqlite extension wherever a shared DB is opened, add a one-time "enable sharing" operation, require post-office-issued E-numbers once sharing is on (refusing the write if none can be had), and surface `needs_merge` notes. A database with sharing off behaves exactly as today.

**Architecture:** A new `core/src/sync/` folder holds four small units: `extension.ts` (find + load cr-sqlite), `state.ts` (the local-only `sync_state` table), `allocator.ts` (a pluggable "give me a number for this ULID" interface; the real HTTP one comes in Plan 2), and `enable.ts` (turn tables into CRRs). `insertEntryRow` gains a pre-assigned `{ulid, id}` path and refuses to mint numbers locally once sharing is on. `addEntryAsync` is the one entry point that asks the allocator first. A staged migration `0007_sync_prep` adds `entries.needs_merge` and `sync_state`.

**Tech Stack:** TypeScript 5.3, better-sqlite3 11, cr-sqlite v0.16.3 prebuilt (loadable extension), node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md` (D2, D6, D7 amended by collab E-708, D8, D9).

## Global Constraints

- Sharing OFF (no `sync_state.enabled = '1'`) ⇒ zero behaviour change: local E-numbers, no extension needed, every existing test passes unchanged.
- Sharing ON ⇒ every new entry's E-number comes from the allocator. If the allocator is missing or fails, **nothing is written** and the error says why (E-708: refuse to save). The ULID is minted locally as today.
- Synced tables = `entries`, `refs`, `entry_modules`, `entry_revisions`, `modules`. **Never** `tasks` (D5), the FTS tables, `local_counters` or `sync_state`.
- A DB that has CRR tables but is opened without the extension must **fail loudly** at `getDb`, never half-work.
- `0007_sync_prep.sql` goes in `mcp/migrations/staged/`, not live. Go-live happens with Plan 3.
- Never commit `vendor/` binaries (gitignored). Never run anything against `mcp/collab.db` (the live DB). Tests use temp DBs.
- Agents never touch git outside their branch. Commit per task on the plan's branch (the user authorized it for this work).

## Review Focus

1. **A writer without the extension on a shared DB** (e.g. the REST server started with the extension missing). Expected: `getDb` throws `CrsqliteMissingError` naming the path and the fix (`npm run fetch:crsqlite`). Pinned in Task 1.
2. **Allocator throws or hangs mid-write.** Expected: no row in `entries`, `refs` or `entry_modules`, and an error mentioning the post office. Pinned in Task 3 ("allocator failure writes nothing").
3. **Rollup/archive while sharing is on** (they mint entries through `insertEntryRow`, not `addEntry`). Expected: a clear refusal, not a locally minted number. Pinned in Task 3.
4. **`enableSync` run twice, or on a pre-0006/pre-0007 DB.** Expected: the second run is a no-op; old schemas are refused with a message. Pinned in Task 2.
5. **FTS still consistent after enabling CRRs and writing.** Pinned in Task 2 and Task 3 (`assertFtsIntact`).

---

### Task 1: Find and load cr-sqlite

**Files:**
- Create: `scripts/fetch-crsqlite.mjs`
- Create: `core/src/sync/extension.ts`
- Modify: `core/src/db.ts` (getDb + closeDb)
- Modify: `core/src/index.ts` (exports)
- Modify: `package.json` (root script `fetch:crsqlite`)
- Modify: `.gitignore` (add `vendor/`)
- Test: `core/test/sync-prep.test.ts`

**Interfaces produced:**
- `crsqlitePath(): string | null` returns the extension path without file suffix (as `loadExtension` wants), or null if not present.
- `hasCrrTables(db): boolean` is true if any `*__crsql_clock` table exists (works without the extension).
- `loadCrsqlite(db): void` loads it or throws `CrsqliteMissingError`.
- `isCrsqliteLoaded(db): boolean`.
- `class CrsqliteMissingError extends Error`.

- [ ] **Step 1: The fetch script.** Create `scripts/fetch-crsqlite.mjs`:

```js
#!/usr/bin/env node
// Downloads the cr-sqlite v0.16.3 loadable extension for this OS/CPU into
// vendor/crsqlite/. Binaries are never committed (see .gitignore).
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const VERSION = 'v0.16.3';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor', 'crsqlite');
const want = {
  'win32-x64': ['win', 'x86_64'],
  'linux-x64': ['linux', 'x86_64'],
  'linux-arm64': ['linux', 'aarch64'],
  'darwin-arm64': ['darwin', 'aarch64'],
  'darwin-x64': ['darwin', 'x86_64'],
}[`${process.platform}-${process.arch}`];
if (!want) { console.error(`no cr-sqlite build known for ${process.platform}-${process.arch}`); process.exit(1); }

const rel = await (await fetch(`https://api.github.com/repos/vlcn-io/cr-sqlite/releases/tags/${VERSION}`,
  { headers: { 'User-Agent': 'collab-fetch-crsqlite' } })).json();
const asset = (rel.assets ?? []).find((a) => a.name.endsWith('.zip') && want.every((w) => a.name.includes(w)));
if (!asset) { console.error(`no ${want.join('-')} zip in ${VERSION}: ${(rel.assets ?? []).map((a) => a.name).join(', ')}`); process.exit(1); }

mkdirSync(out, { recursive: true });
const zip = join(out, asset.name);
writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', out]);
else execFileSync('unzip', ['-o', zip, '-d', out]);
const lib = readdirSync(out).find((f) => /^crsqlite\.(dll|so|dylib)$/.test(f));
if (!lib || !existsSync(join(out, lib))) { console.error('extracted, but no crsqlite.(dll|so|dylib) found in ' + out); process.exit(1); }
console.log(`cr-sqlite ${VERSION} -> ${join(out, lib)}`);
```

Add to the root `package.json` scripts: `"fetch:crsqlite": "node scripts/fetch-crsqlite.mjs"`. Add a `vendor/` line to `.gitignore` under "Build artifacts".

Run: `npm run fetch:crsqlite`. Expected: `cr-sqlite v0.16.3 -> .../vendor/crsqlite/crsqlite.(so|dll)`. If the zip layout nests the library in a subfolder, move it up to `vendor/crsqlite/` in the script and report the deviation.

- [ ] **Step 2: Write the failing tests.** Create `core/test/sync-prep.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, getDb, closeDb } from '../src/db.js';
import { crsqlitePath, hasCrrTables, loadCrsqlite, isCrsqliteLoaded, CrsqliteMissingError } from '../src/sync/extension.js';

/** Fresh on-disk DB at 0007 (0007 is staged, so includeStaged). */
export function db0007(): { db: Database.Database; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-sync-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  migrateTo(db, '0007', { includeStaged: true });
  return { db, path, cleanup: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test('the cr-sqlite extension is available (run npm run fetch:crsqlite)', () => {
  assert.ok(crsqlitePath(), 'vendor/crsqlite missing: run `npm run fetch:crsqlite`');
});

test('a plain DB has no CRR tables and loads without the extension', () => {
  const { db, cleanup } = db0007();
  try {
    assert.equal(hasCrrTables(db), false);
    assert.equal(isCrsqliteLoaded(db), false);
  } finally { cleanup(); }
});

test('loadCrsqlite makes crsql functions available', () => {
  const { db, cleanup } = db0007();
  try {
    loadCrsqlite(db);
    assert.equal(isCrsqliteLoaded(db), true);
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

test('getDb refuses a CRR database when the extension cannot be found', () => {
  const { db, path, cleanup } = db0007();
  try {
    loadCrsqlite(db);
    db.prepare(`SELECT crsql_as_crr('modules')`).get();
    db.prepare('SELECT crsql_finalize()').get();
    db.close();
    const saved = process.env.COLLAB_CRSQLITE_PATH;
    process.env.COLLAB_CRSQLITE_PATH = join(tmpdir(), 'definitely-not-here', 'crsqlite');
    try {
      assert.throws(() => getDb(path), CrsqliteMissingError);
    } finally {
      if (saved === undefined) delete process.env.COLLAB_CRSQLITE_PATH; else process.env.COLLAB_CRSQLITE_PATH = saved;
      closeDb();
    }
    const again = getDb(path); // default path finds vendor/ -> loads fine
    assert.equal(isCrsqliteLoaded(again), true);
    closeDb(); // must finalize without throwing
  } finally { cleanup(); }
});
```

- [ ] **Step 3: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-prep.test.ts`. Expected: FAIL, `Cannot find module '../src/sync/extension.js'`. (`migrateTo '0007'` also fails until Task 2 creates the migration. Create an empty-bodied `mcp/migrations/staged/0007_sync_prep.sql` now with only the `BEGIN; INSERT INTO schema_migrations (version) VALUES ('0007_sync_prep'); COMMIT;` lines so Task 1 can run; Task 2 fills it in.)

- [ ] **Step 4: Implement `core/src/sync/extension.ts`:**

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "../db.js";

// cr-sqlite is a loadable SQLite extension. Once any table is a CRR, its
// triggers call crsql_* functions, so EVERY connection that writes this file
// must load the extension or its writes fail (spec D2, risks).
const __dirname = dirname(fileURLToPath(import.meta.url));
// core/src/sync (tsx) and core/dist/sync (built) are both 3 levels below internal-tools/.
const DEFAULT_BASE = join(__dirname, "../../../vendor/crsqlite/crsqlite");
const SUFFIXES = [".dll", ".so", ".dylib"];

export class CrsqliteMissingError extends Error {
  constructor(dbPath: string, tried: string) {
    super(
      `[collab-mcp] ${dbPath} shares notes (it has cr-sqlite tables), but the cr-sqlite extension was not found at ${tried}.\n` +
        `[collab-mcp] Fix: run \`npm run fetch:crsqlite\` in internal-tools, or set COLLAB_CRSQLITE_PATH.`,
    );
    this.name = "CrsqliteMissingError";
  }
}

/** Extension path WITHOUT suffix (loadExtension adds it), or null if absent. */
export function crsqlitePath(): string | null {
  const base = process.env.COLLAB_CRSQLITE_PATH || DEFAULT_BASE;
  return SUFFIXES.some((s) => existsSync(base + s)) || existsSync(base) ? base : null;
}

export function hasCrrTables(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_\\_crsql\\_clock' ESCAPE '\\' LIMIT 1`).get();
}

export function isCrsqliteLoaded(db: DB): boolean {
  try { db.prepare(`SELECT crsql_db_version()`).get(); return true; } catch { return false; }
}

export function loadCrsqlite(db: DB): void {
  if (isCrsqliteLoaded(db)) return;
  const p = crsqlitePath();
  if (!p) throw new CrsqliteMissingError(db.name, process.env.COLLAB_CRSQLITE_PATH || DEFAULT_BASE);
  db.loadExtension(p);
}
```

In `core/src/db.ts`, import `{ hasCrrTables, loadCrsqlite, isCrsqliteLoaded }` from `./sync/extension.js`. In `getDb`, right after `db.pragma("foreign_keys = ON");`:

```ts
  if (hasCrrTables(db)) {
    try { loadCrsqlite(db); } catch (e) { db.close(); throw e; }
  }
```

Replace `closeDb`'s body with:

```ts
  if (_db) {
    // cr-sqlite requires finalize before close on a connection that loaded it.
    if (isCrsqliteLoaded(_db)) { try { _db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ } }
    _db.close();
    _db = null;
    _dbPath = null;
  }
```

Add `export * from './sync/extension.js';` to `core/src/index.ts`.

Note: `hasCrrTables` must run against `sqlite_master` only. It must never touch a CRR table before the extension is loaded.

- [ ] **Step 5: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-prep.test.ts test/db-path.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(core): find and load cr-sqlite; refuse shared DBs without it (sync v1 plan 1)`

---

### Task 2: Migration 0007 + `sync_state` + `enableSync`

**Files:**
- Modify: `mcp/migrations/staged/0007_sync_prep.sql`
- Create: `core/src/sync/state.ts`, `core/src/sync/enable.ts`
- Create: `mcp/src/scripts/sync-enable.ts` (+ `"sync:enable": "tsx src/scripts/sync-enable.ts"` in `mcp/package.json` scripts, matching how the other scripts are run there; check and adapt)
- Modify: `core/src/index.ts`, `core/test/helpers/levels.ts` (type only)
- Test: `core/test/sync-prep.test.ts` (append)

**Interfaces produced:**
- `hasSyncState(db): boolean`, `getSyncValue(db, key): string | null`, `setSyncValue(db, key, value): void`, `isSyncEnabled(db): boolean` (`sync_state.enabled === '1'`).
- `SYNCED_TABLES: readonly ["entries","refs","entry_modules","entry_revisions","modules"]`.
- `enableSync(db, opts?: { backup?: boolean }): { alreadyEnabled: boolean; tables: string[]; backup: string | null }`.

- [ ] **Step 1: Fill in the migration.** Write `mcp/migrations/staged/0007_sync_prep.sql`:

```sql
-- ============================================================
-- Collab — sync v1 preparation (spec 2026-10-04, plan 1)
-- Migration: 0007_sync_prep
--
-- Additive only. entries.needs_merge: set by the post office when two edits
-- of one entry cannot be merged (spec D8). sync_state: LOCAL-ONLY key/value
-- (never a CRR) holding this machine's sharing settings.
-- ============================================================
BEGIN;

ALTER TABLE entries ADD COLUMN needs_merge INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

INSERT INTO schema_migrations (version) VALUES ('0007_sync_prep');

COMMIT;
```

In `core/test/helpers/levels.ts` change only the type: `export type Level = '0005' | '0006' | '0007';`. Keep `LEVELS` unchanged.

- [ ] **Step 2: Append the failing tests:**

```ts
import { isSyncEnabled, setSyncValue, getSyncValue } from '../src/sync/state.js';
import { enableSync, SYNCED_TABLES } from '../src/sync/enable.js';
import { assertFtsIntact, dbAt } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';

test('0007 adds needs_merge and sync_state; sharing starts off', () => {
  const { db, cleanup } = db0007();
  try {
    assert.ok(db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name='needs_merge'`).get());
    assert.equal(isSyncEnabled(db), false);
    setSyncValue(db, 'x', 'y');
    assert.equal(getSyncValue(db, 'x'), 'y');
  } finally { cleanup(); }
});

test('enableSync turns exactly the synced tables into CRRs, is idempotent, keeps FTS intact', () => {
  const { db, path, cleanup } = db0007();
  try {
    addEntry(db, { type: 'decision', title: 'before sharing', summary: 's', module: 'm' });
    const r = enableSync(db, { backup: true });
    assert.equal(r.alreadyEnabled, false);
    assert.deepEqual(r.tables, [...SYNCED_TABLES]);
    assert.ok(r.backup && r.backup.startsWith(path + '.bak-sync-enable-'));
    for (const t of SYNCED_TABLES) assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(`${t}__crsql_clock`), t);
    for (const t of ['tasks', 'local_counters', 'sync_state']) assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(`${t}__crsql_clock`), undefined, t);
    assert.equal(isSyncEnabled(db), true);
    assert.equal(enableSync(db).alreadyEnabled, true);
    assertFtsIntact(db);
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

test('enableSync refuses a database without migration 0007', () => {
  const { db, cleanup } = dbAt('0006');
  try { assert.throws(() => enableSync(db), /0007/); } finally { cleanup(); }
});
```

- [ ] **Step 3: Run and confirm it fails.** Expected: FAIL, cannot find `../src/sync/state.js`.

- [ ] **Step 4: Implement.** `core/src/sync/state.ts`:

```ts
import type { DB } from "../db.js";

// sync_state is LOCAL-ONLY (never a CRR): this machine's sharing settings.
export function hasSyncState(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'`).get();
}
export function getSyncValue(db: DB, key: string): string | null {
  if (!hasSyncState(db)) return null;
  const r = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setSyncValue(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
/** Sharing is on for this DB: E-numbers must come from the post office (spec D7, E-708). */
export function isSyncEnabled(db: DB): boolean {
  return getSyncValue(db, "enabled") === "1";
}
```

`core/src/sync/enable.ts`:

```ts
import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { loadCrsqlite } from "./extension.js";
import { hasSyncState, isSyncEnabled, setSyncValue } from "./state.js";

// Spec D5: notes only. tasks, FTS, local_counters and sync_state stay local.
export const SYNCED_TABLES = ["entries", "refs", "entry_modules", "entry_revisions", "modules"] as const;

export function enableSync(
  db: DB,
  opts: { backup?: boolean } = {},
): { alreadyEnabled: boolean; tables: string[]; backup: string | null } {
  if (!hasUlidPrimaryKey(db)) throw new Error("enableSync needs migration 0006 (ULID primary key)");
  if (!hasSyncState(db)) throw new Error("enableSync needs migration 0007_sync_prep");
  if (isSyncEnabled(db)) return { alreadyEnabled: true, tables: [...SYNCED_TABLES], backup: null };

  let backup: string | null = null;
  if (opts.backup) {
    backup = `${db.name}.bak-sync-enable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    db.prepare("VACUUM INTO ?").run(backup);
  }
  loadCrsqlite(db);
  const tx = db.transaction(() => {
    for (const t of SYNCED_TABLES) db.prepare(`SELECT crsql_as_crr(?)`).get(t);
    setSyncValue(db, "enabled", "1");
  });
  tx();
  return { alreadyEnabled: false, tables: [...SYNCED_TABLES], backup };
}
```

If `crsql_as_crr` cannot run inside a transaction (an error mentioning a transaction), run the loop outside the transaction, set the flag last, and report the deviation.

Export both modules from `core/src/index.ts`. Create `mcp/src/scripts/sync-enable.ts`:

```ts
// One-time: turn a notes DB into a shareable one (spec D2). NEVER run on the
// live DB before the Plan 3 go-live; it takes a backup first.
import { getDb, closeDb, enableSync } from "@collab-mcp/core";
const r = enableSync(getDb(), { backup: true });
console.log(r.alreadyEnabled ? "sharing was already enabled" : `sharing enabled on: ${r.tables.join(", ")}\nbackup: ${r.backup}`);
closeDb();
```

- [ ] **Step 5: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-prep.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(core): migration 0007 (staged) + sync_state + enableSync (sync v1 plan 1)`

---

### Task 3: Numbers from the post office, or no write

**Files:**
- Create: `core/src/sync/allocator.ts`
- Modify: `core/src/entry-write.ts` (`EntryRowInput.assigned`, `insertEntryRow`)
- Modify: `core/src/ops/add.ts` (`assigned` passthrough + `addEntryAsync`)
- Modify: `mcp/src/server.ts` (collab_add uses `addEntryAsync`)
- Modify: `server/src/tools/collab.ts` (REST create uses `addEntryAsync`)
- Modify: `mcp/src/scripts/log-collab.ts`, `mcp/src/scripts/add-log.ts`, `mcp/src/scripts/parse-codex-output.ts` (use `addEntryAsync`; they are ESM, so top-level `await` works. If a script isn't, wrap it in an async main.)
- Modify: `core/src/index.ts`
- Test: `core/test/sync-prep.test.ts` (append)

**Interfaces produced:**
- `interface Allocator { allocate(ulid: string): Promise<number> }`
- `setAllocator(a: Allocator | null): void`, `getAllocator(): Allocator | null`
- `class PostOfficeUnreachableError extends Error`, `class SyncAllocationRequiredError extends Error`
- `addEntryAsync(db, args: AddEntryArgs): Promise<AddEntryResult>` (same result shape as `addEntry`)
- `EntryRowInput.assigned?: { ulid: string; id: number }` (internal)

- [ ] **Step 1: Append the failing tests:**

```ts
import { setAllocator, PostOfficeUnreachableError, SyncAllocationRequiredError } from '../src/sync/allocator.js';
import { addEntryAsync } from '../src/ops/add.js';
import { rollup } from '../src/ops/rollup.js';

function sharedDb() {
  const h = db0007();
  enableSync(h.db);
  return h;
}
const count = (db: any, t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

test('sharing off: addEntryAsync behaves like addEntry (local numbers)', async () => {
  const { db, cleanup } = db0007();
  try {
    setAllocator(null);
    const a = await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' });
    assert.ok(a.id >= 1);
  } finally { cleanup(); }
});

test('sharing on: the number comes from the allocator', async () => {
  const { db, cleanup } = sharedDb();
  try {
    const seen: string[] = [];
    setAllocator({ allocate: async (ulid) => { seen.push(ulid); return 9001; } });
    const r = await addEntryAsync(db, { type: 'gotcha', title: 'shared', summary: 's', module: 'm', refs: [{ ref_type: 'file', ref_value: 'x.ts' }] });
    assert.equal(r.id, 9001);
    const row = db.prepare(`SELECT ulid, id FROM entries WHERE id = 9001`).get() as { ulid: string; id: number };
    assert.equal(row.ulid, seen[0]);
    assert.equal(count(db, 'refs'), 1);
    assertFtsIntact(db);
  } finally { setAllocator(null); db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

test('sharing on: allocator failure writes nothing and names the post office', async () => {
  const { db, cleanup } = sharedDb();
  try {
    setAllocator({ allocate: async () => { throw new Error('ECONNREFUSED'); } });
    const before = [count(db, 'entries'), count(db, 'refs'), count(db, 'entry_modules')];
    await assert.rejects(addEntryAsync(db, { type: 'decision', title: 't', summary: 's', module: 'm', refs: [{ ref_type: 'file', ref_value: 'y' }] }), PostOfficeUnreachableError);
    assert.deepEqual([count(db, 'entries'), count(db, 'refs'), count(db, 'entry_modules')], before);
    setAllocator(null);
    await assert.rejects(addEntryAsync(db, { type: 'decision', title: 't', summary: 's' }), /post office/i);
  } finally { setAllocator(null); db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

test('sharing on: sync-only paths refuse to mint numbers locally', () => {
  const { db, cleanup } = sharedDb();
  try {
    assert.throws(() => addEntry(db, { type: 'decision', title: 't', summary: 's' }), SyncAllocationRequiredError);
    assert.throws(() => rollup(db, { task_id: 'T-999' } as any), (e: any) => e instanceof SyncAllocationRequiredError || /no entries|nothing to roll up/i.test(String(e.message)));
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});
```

The rollup assertion accepts either outcome because an empty task has nothing to roll up. If `rollup`'s signature differs, adapt the call. Then add a second assertion that creates one `handoff` with `task_id: 'T-999'` via `addEntryAsync` (with a stub allocator) before calling rollup, and expects `SyncAllocationRequiredError`.

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, cannot find `../src/sync/allocator.js`.

- [ ] **Step 3: Implement `core/src/sync/allocator.ts`:**

```ts
// Sharing on => E-numbers come only from the post office (spec D7, collab
// E-648/E-708). The real HTTP allocator is registered by Plan 2; tests use stubs.
export interface Allocator {
  allocate(ulid: string): Promise<number>;
}
let current: Allocator | null = null;
export function setAllocator(a: Allocator | null): void { current = a; }
export function getAllocator(): Allocator | null { return current; }

export class PostOfficeUnreachableError extends Error {
  constructor(detail: string) {
    super(`[collab-mcp] Not saved: this notes database is shared, and a note number could not be obtained from the post office (${detail}). Nothing was written. Start the post office (or reconnect), then retry.`);
    this.name = "PostOfficeUnreachableError";
  }
}
export class SyncAllocationRequiredError extends Error {
  constructor() {
    super(`[collab-mcp] This notes database is shared, so new note numbers must come from the post office. Use addEntryAsync. (rollup/archive are not available while sharing is on in v1.)`);
    this.name = "SyncAllocationRequiredError";
  }
}
```

In `core/src/entry-write.ts`, import `isSyncEnabled` from `./sync/state.js` and `SyncAllocationRequiredError` from `./sync/allocator.js`. Add `assigned?: { ulid: string; id: number };` to `EntryRowInput`. In `insertEntryRow`, make the 0006 branch:

```ts
  if (hasUlidPrimaryKey(db)) {
    if (row.assigned) {
      cols.push("ulid", "author", "id");
      run(db, cols, { ...values, ulid: row.assigned.ulid, author: resolveAuthor(), id: row.assigned.id });
      return { id: row.assigned.id, ulid: row.assigned.ulid };
    }
    if (isSyncEnabled(db)) throw new SyncAllocationRequiredError();
    const ulid = newUlid();
    const id = nextEntryNumber(db);
    cols.push("ulid", "author", "id");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id });
    return { id, ulid };
  }
```

Make sure `assigned` is not part of the `cols`/`values` column list. `values` spreads `row`, but only the names in `cols` are bound, so this is already safe. Confirm it. Before 0006, `assigned` is ignored, because sharing can't be enabled there.

In `core/src/ops/add.ts`: add `assigned?: { ulid: string; id: number };` to `AddEntryArgs` with the comment `// internal: set only by addEntryAsync`. Pass `assigned: a.assigned` into the `insertEntryRow` call. Then add:

```ts
import { isSyncEnabled } from "../sync/state.js";
import { getAllocator, PostOfficeUnreachableError } from "../sync/allocator.js";
import { newUlid } from "../ulid.js";

/**
 * The entry point for every async caller. Sharing off: identical to addEntry.
 * Sharing on: ask the post office for the number FIRST; if that fails,
 * nothing is written (E-708: refuse to save).
 */
export async function addEntryAsync(db: DB, args: AddEntryArgs): Promise<AddEntryResult> {
  if (!isSyncEnabled(db)) return addEntry(db, args);
  const allocator = getAllocator();
  if (!allocator) throw new PostOfficeUnreachableError("no post office connection is configured on this machine");
  const ulid = newUlid();
  let id: number;
  try {
    id = await allocator.allocate(ulid);
  } catch (e) {
    throw new PostOfficeUnreachableError((e as Error).message);
  }
  return addEntry(db, { ...args, assigned: { ulid, id } });
}
```

Use the file's existing names for the result type (it may be called `AddEntryResult` or be inferred; adapt the return annotation). Check that `newUlid` is exported from `../ulid.js` (it is, per `entry-write.ts`).

Callers:
- `mcp/src/server.ts`, collab_add handler: `const result = await addEntryAsync(db, {...})`. Add `addEntryAsync` to the core import list.
- `server/src/tools/collab.ts`, create branch: `const { id: newId } = await addEntryAsync(db, {...})`. Add `addEntryAsync` to its core import.
- `mcp/src/scripts/log-collab.ts`, `add-log.ts`, `parse-codex-output.ts`: `await addEntryAsync(...)` in place of `addEntry(...)`.

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-prep.test.ts test/write-paths-0006.test.ts test/entry-write.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck.** Run `npm -w @collab-mcp/core run build && npx tsc --noEmit -p mcp && npx tsc --noEmit -p server`. Expected: no errors. If `server` has no `tsconfig.json` at that path, use the one its `package.json` build script uses and report it.

- [ ] **Step 6: Commit** `feat(core): sharing on => numbers from the post office or no write (E-708, sync v1 plan 1)`

---

### Task 4: Show `needs_merge`

**Files:**
- Modify: `core/src/ops/module.ts` (ModuleCard + getModule)
- Modify: `core/src/ops/doctor.ts` (two checks)
- Test: `core/test/sync-prep.test.ts` (append)

**Interfaces produced:** `ModuleCard.needs_merge: Array<{ id: number; title: string }>` (empty when none or before 0007). Doctor checks `sync.needs_merge` (warn) and `sync.extension` (error if CRR tables exist but the extension isn't loaded on this connection).

- [ ] **Step 1: Append the failing tests:**

```ts
import { getModule, initModule } from '../src/ops/module.js';
import { doctor } from '../src/ops/doctor.js';

test('needs_merge notes surface on the card and in doctor', () => {
  const { db, cleanup } = db0007();
  try {
    initModule(db, { slug: 'm' });
    const id = addEntry(db, { type: 'decision', title: 'forked', summary: 's', module: 'm' }).id;
    assert.deepEqual(getModule(db, 'm').needs_merge, []);
    db.prepare(`UPDATE entries SET needs_merge = 1 WHERE id = ?`).run(id);
    assert.deepEqual(getModule(db, 'm').needs_merge, [{ id, title: 'forked' }]);
    const c = doctor(db).checks.find((x) => x.name === 'sync.needs_merge')!;
    assert.equal(c.severity, 'warn');
    assert.deepEqual(c.items, [`E-${String(id).padStart(5, '0')}`]);
  } finally { cleanup(); }
});

test('the card carries an empty needs_merge before 0007', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    initModule(db, { slug: 'm' });
    assert.deepEqual(getModule(db, 'm').needs_merge, []);
    assert.equal(doctor(db).checks.find((x) => x.name === 'sync.needs_merge'), undefined);
  } finally { cleanup(); }
});

test('doctor: sync.extension is ok on a shared DB opened with the extension', () => {
  const { db, cleanup } = db0007();
  try {
    enableSync(db);
    assert.equal(doctor(db).checks.find((x) => x.name === 'sync.extension')!.severity, 'ok');
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `needs_merge` is undefined.

- [ ] **Step 3: Implement.** In `module.ts`, add `needs_merge: Array<{ id: number; title: string }>;` to `ModuleCard`, and `needs_merge: [],` to the unknown-module early return. Before the final return:

```ts
  // Spec D8: forks the post office could not merge wait here for a person.
  const hasNeedsMerge = !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get();
  const needs_merge = hasNeedsMerge
    ? (db.prepare(
        `SELECT id, title FROM entries
          WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
            AND needs_merge = 1 AND deprecated = 0
          ORDER BY created_at DESC LIMIT 5`,
      ).all(slug) as ModuleCard["needs_merge"])
    : [];
```

Add `needs_merge` to the returned object. In `doctor.ts`, import `{ hasCrrTables, isCrsqliteLoaded }` from `../sync/extension.js` and insert before the `// fts.integrity:` comment:

```ts
  // Sync v1 (plan 1): forks awaiting a person, and the extension a shared DB needs.
  if (db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get()) {
    const nm = db.prepare(`SELECT id FROM entries WHERE needs_merge = 1 AND deprecated = 0 ORDER BY id`).all() as Array<{ id: number }>;
    checks.push({
      name: "sync.needs_merge",
      severity: nm.length > 0 ? "warn" : "ok",
      detail: nm.length > 0 ? `${nm.length} note(s) have edits the post office could not merge; pick the final text` : "no unmerged edits",
      items: nm.length > 0 ? nm.map((r) => toEntryId(r.id)) : undefined,
    });
  }
  if (hasCrrTables(db)) {
    const loaded = isCrsqliteLoaded(db);
    checks.push({
      name: "sync.extension",
      severity: loaded ? "ok" : "error",
      detail: loaded ? "cr-sqlite loaded" : "this DB shares notes but cr-sqlite is not loaded on this connection: writes will fail",
    });
  }
```

- [ ] **Step 4: Run and confirm it passes, plus the regressions.** Run: `cd core && npx tsx --test test/sync-prep.test.ts test/hub.test.ts test/doctor-0006.test.ts test/read-paths-0006.test.ts`, then the full suite: `npm -w @collab-mcp/core test`. Expected: all pass. 153 passed before this plan; report the new total.

- [ ] **Step 5: Commit** `feat(core): needs_merge on the card and in doctor; doctor checks the sync extension (sync v1 plan 1)`

---

### Task 5: Real-data check on a copy (Claude, locally, after merge review)

No new code. Never touches `mcp/collab.db` directly.

- [ ] Copy the live DB with `VACUUM INTO` into the scratchpad. Run `migrate(includeStaged)` on the copy, then `enableSync` on the copy. Record the time taken and the size before and after.
- [ ] On the copy: doctor shows 0 errors and `sync.extension` ok, and FTS integrity is ok. With a stub allocator, `addEntryAsync` writes a searchable note. With no allocator, it refuses and writes nothing.
- [ ] Confirm that sharing off (the live DB as-is, 0007 not applied) still passes the hub and card checks with the rebuilt code.
- [ ] Log a collab changelog with the numbers. Plan 2 (post office) is next.

## Out of scope for Plan 1
- The HTTP allocator, members, keys and merge logic: Plan 2.
- Courier, setup command, autostart and the two-laptop test: Plan 3.
- Releasing 0007 to the live DB and running `sync:enable` for real: the Plan 3 go-live.
