# Sync v1, Plan 2 of 3: The Post Office

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Code-block convention:** a code block whose first line is `// file: <path>` (or `-- file:`) is the COMPLETE content of a new file; create it verbatim (the marker line included, it is a harmless comment). Edits to existing files are described in prose with the exact snippet.

**Goal:** Build the post office: the one program that hands out E-numbers, keeps the ordered log of every shared change, merges simultaneous edits (or flags them `needs_merge`), knows who the members are, and rings the doorbell of the other machines. Also make `@collab-mcp/core` ready to talk to it: an HTTPS allocator with the E-713 retry rules, revisions written by code (not by a trigger), and the change codec the courier (Plan 3) will reuse.

**Architecture:** A new workspace package `post-office/` (`@collab-mcp/post-office`). Its store is ONE SQLite file: a normal notes schema (core migrations to 0007, `enableSync`, so it is a cr-sqlite database holding every shared row) plus local `po_*` tables (`po_meta` with the counter, `po_members`, `po_allocations`, `po_deliveries`, `po_shared_modules`). Accepting a batch = record each change in `po_deliveries` (de-duplicated by its cr-sqlite identity), apply it through `crsql_changes`, merge forked revisions with node-diff3, flag status/type divergence, then record the post office's own writes (merges, flags) as deliveries too, all in ONE transaction. An HTTPS server (Node `https`, self-signed certificate built with `node:crypto`, trust by fingerprint pinning) serves join, allocate, push/pull changes, shared modules, team status and an SSE doorbell. Admin commands run against the store file directly. Core gains `sync/{errors,cert,joincode,http,http-allocator,changes}.ts` and `revisions.ts`.

**Tech Stack:** TypeScript 5.3, Node ≥ 20.9 built-ins (`https`, `tls`, `crypto`, `http`), better-sqlite3 11, cr-sqlite 0.16.3, node-diff3 3.2.1 (MIT), node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md` (D3, D7 + E-708 + E-713, D8, D9, D10, D12, D13, D14, D15; Components 1 and 3; failure table rows "Post office down", "Same note edited on both", "Key revoked", "Impostor post office").

## Global Constraints

- **Settled, never re-opened:** local-first SQLite; cr-sqlite replicates (no hand-rolled CRDT); no last-writer-wins for TEXT (revisions + three-way merge on the post office only); no ID blocks, no number ranges, no "number pending"; post office unreachable ⇒ save refused, nothing written (E-708); tasks never sync; HTTPS + pinning even on a LAN; revoke ⇒ 401 at once.
- **E-713:** the allocator is idempotent by ULID; `addEntryAsync` keeps ONE ulid across its bounded retries (3 tries, 1.5 s per try, 250 ms / 750 ms pauses ≈ 5 s worst case); every input check runs BEFORE a number is asked for. Accepted residual gap: the process dies between allocation and the local save (that number is skipped, never reused).
- Sharing OFF ⇒ zero behaviour change. All 167 core tests keep passing unchanged.
- `0007_sync_prep.sql` stays in `mcp/migrations/staged/` (this plan amends it; it is unreleased). Nothing here enables sync on a real DB. The post office store uses `includeStaged` for its OWN new file only.
- Every connection that writes a cr-sqlite DB loads the extension: the store is opened through `openStore`/`createStore`, which load it; admin commands use the same functions.
- Node built-ins first. New dependency: **node-diff3** (MIT, zero deps) for the three-way merge. No certificate library: the self-signed certificate is ~80 lines of DER on `node:crypto`.
- Windows is the real platform: no POSIX-only paths or shell calls in runtime code; data dir under `%LOCALAPPDATA%` on Windows; `path.win32` is unit-tested.
- Never commit `vendor/`, `dist/`, certificates, keys, join codes, or store files. `.gitignore` gains `*.pem` and `post-office-data/`.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `mcp/migrations/staged/0007_sync_prep.sql` | modify | + `entry_revisions.merged_from`, drop `trg_entries_revision` |
| `core/src/revisions.ts` | new | revision rows written by code: root, parent, heads, fold on resolve |
| `core/src/ops/update.ts` | modify | `updateEntry` records a revision; `resolveNeedsMerge` |
| `core/src/ops/doctor.ts` | modify | 0007 no longer expects `trg_entries_revision` |
| `server/src/tools/collab.ts` | modify | REST edit records a revision |
| `core/src/sync/enable.ts` | modify | bookkeeping triggers skip changes cr-sqlite is applying |
| `core/src/sync/errors.ts` | new | `PostOfficeUnreachableError`, `SyncAllocationRequiredError`, `PinMismatchError`, `AccessRevokedError` |
| `core/src/sync/allocator.ts` | modify | `resolveAllocator`, `allocateWithRetry` (E-713), retry policy |
| `core/src/ops/add.ts` | modify | `validateAddEntryArgs` before allocation; retry with one ulid |
| `core/src/sync/cert.ts` | new | self-signed EC certificate, fingerprints |
| `core/src/sync/joincode.ts` | new | `collab1-…` join codes |
| `core/src/sync/http.ts` | new | pinned HTTPS JSON client + SSE reader |
| `core/src/sync/http-allocator.ts` | new | `HttpAllocator`, config from `sync_state` |
| `core/src/sync/changes.ts` | new | wire codec, read own changes, apply, FTS re-index |
| `core/src/index.ts` | modify | exports |
| `post-office/package.json`, `tsconfig.json` | new | workspace package |
| `post-office/src/store.ts` | new | store file, counter, allocations, members, shared modules, status |
| `post-office/src/deliveries.ts` | new | accept (dedupe, apply, merge, self-ingest), fetch |
| `post-office/src/merge.ts` | new | three-way merge, divergence, `needs_merge` |
| `post-office/src/server.ts` | new | HTTPS + SSE API |
| `post-office/src/paths.ts`, `cli.ts`, `bin.ts`, `index.ts` | new | admin commands |
| `core/test/helpers/sync.ts` + `core/test/sync-*.test.ts` | new | core tests |
| `post-office/test/*.test.ts` | new | post office tests |

## Interfaces produced (consumed by Plan 3)

- core: `snapshotForRevision`, `finishRevision`, `revisionsOf`, `headsOf`, `splitMerged`, `rootRevId`, `resolveNeedsMerge`; `validateAddEntryArgs`; `resolveAllocator`, `allocateWithRetry`, `setAllocationRetry`; `generateSelfSignedCert`, `fingerprintOfPem`, `normalizeFingerprint`; `formatJoinCode`, `parseJoinCode`; `requestJson`, `openEventStream`, `connectPinned`, `PostOfficeTarget`; `HttpAllocator`, `postOfficeTargetFromDb`, `SYNC_KEYS`; `WireChange`, `RawChange`, `encodeChange`, `decodeChange`, `readOwnChanges`, `applyChanges`, `entryUlidOf`, `reindexFts`.
- post office HTTP API (all JSON, all HTTPS, `Authorization: Bearer <device>:<key>` except join):
  - `POST /v1/join {device, secret}` → `{device, key}` (403 if used/expired/unknown)
  - `POST /v1/allocate {ulid}` → `{id}`
  - `POST /v1/changes {changes: WireChange[]}` → `{accepted, duplicates, last_seq}`
  - `GET /v1/changes?after=N&limit=M` → `{changes, last_seq, more}` (never the caller's own changes)
  - `GET /v1/modules` → `{shared}`; `POST /v1/modules {slug, shared}` → `{shared}`
  - `GET /v1/status` → `{members, last_seq}`
  - `GET /v1/events` → SSE: `ready {last_seq}`, `changes {last_seq}`, `modules {shared}`, `revoked {}`
  - any request with a revoked/unknown key → 401
- post office library: `createStore`, `openStore`, `closeStore`, `allocate`, `addMember`, `redeemJoin`, `authenticate`, `revokeMember`, `teamStatus`, `setModuleShared`, `sharedModules`, `acceptChanges`, `fetchDeliveries`, `lastSeq`, `startPostOffice`, `runCli`, `defaultDataDir`.

## Review Focus

1. **A lost answer after allocation** (E-713). Expected: the retry sends the same ulid and gets the same number; the counter moved once. Pinned in Task 3 (stub) and Task 12 (real HTTPS, response dropped by the server).
2. **Bad input never consumes a number.** 1000 saves with 50 invalid ⇒ the 950 numbers are contiguous. Pinned in Task 3 and Task 12.
3. **A remote edit applied by cr-sqlite must not run local bookkeeping** (revision trigger, link-fill trigger): otherwise each machine grows rows nobody else has, and merge bases differ. Pinned in Tasks 1–2.
4. **Merge never silently loses text:** different paragraphs ⇒ merged revision that wins everywhere; same line or diverging status/type ⇒ `needs_merge`. Pinned in Task 9.
5. **Impostor and revoked:** wrong pin ⇒ no byte of the request is sent; revoked ⇒ 401 on the very next request and the doorbell stream is closed. Pinned in Tasks 4 and 10.
6. **The accept transaction:** dedupe + apply + merge + flags + self-ingest commit together or not at all; a resend is a no-op. Pinned in Task 8.

---
### Task 1: Edits write revisions (in code, not by trigger)

Why: the 0005/0006 trigger `trg_entries_revision` also fires when cr-sqlite applies a REMOTE edit. Its rows are written while cr-sqlite's sync bit is set, so they are never replicated: every machine grows revisions nobody else has, and the post office's merge base is wrong. (Verified in a spike: applying one remote title edit created 4 local-only revision rows on the receiver.) The spec says "`updateEntry` appends an `entry_revisions` row (parent = current revision)"; this task does exactly that.

**Files:**
- Modify: `mcp/migrations/staged/0007_sync_prep.sql`
- Create: `core/src/revisions.ts`, `core/test/helpers/sync.ts`, `core/test/sync-revisions.test.ts`
- Modify: `core/src/ops/update.ts`, `core/src/ops/doctor.ts`, `core/src/index.ts`, `server/src/tools/collab.ts`

**Interfaces produced:** `writesRevisionsInCode(db)`, `rootRevId(ulid)`, `revisionsOf(db, ulid)`, `headsOf(revs)`, `splitMerged(s)`, `snapshotForRevision(db, ulid)`, `finishRevision(db, snapshot)`, types `EntryText`, `RevisionRow`, `TextSnapshot`.

- [ ] **Step 1: Test helper.**

```ts
// file: core/test/helpers/sync.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../../src/db.js';
import { enableSync } from '../../src/sync/enable.js';
import { isCrsqliteLoaded } from '../../src/sync/extension.js';

export type TestDb = { db: Database.Database; path: string; cleanup: () => void };

/** A fresh on-disk DB at 0007 (staged); `shared` also runs enableSync. */
export function freshDb(opts: { shared?: boolean } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'collab-sync-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  migrateTo(db, '0007', { includeStaged: true });
  if (opts.shared) enableSync(db);
  return {
    db, path,
    cleanup: () => {
      try { if (isCrsqliteLoaded(db)) db.prepare('SELECT crsql_finalize()').get(); db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Test stand-in for the post office: copy every change `from` holds after db_version `since` into `to`. */
export function ship(from: Database.Database, to: Database.Database, since = 0): number {
  const rows = from.prepare(
    `SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`,
  ).all(since) as any[];
  const ins = to.prepare(
    `INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  to.transaction(() => { for (const r of rows) ins.run(r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq); })();
  return rows.length;
}

export const dbVersion = (db: Database.Database): number =>
  (db.prepare('SELECT crsql_db_version() v').get() as { v: number }).v;

/** Changes this DB made itself (not ones it received). */
export const ownChanges = (db: Database.Database): Array<{ t: string; cid: string }> =>
  db.prepare(`SELECT "table" t, cid FROM crsql_changes WHERE site_id = crsql_site_id()`).all() as any[];
```

- [ ] **Step 2: Write the failing tests.**

```ts
// file: core/test/sync-revisions.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, ship, dbVersion, ownChanges } from './helpers/sync.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';
import { doctor } from '../src/ops/doctor.js';
import { revisionsOf, headsOf, rootRevId } from '../src/revisions.js';
import { setAllocator } from '../src/sync/allocator.js';

const ulidOf = (db: any, id: number) => (db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;

test('0007: updateEntry writes the root and one revision per real edit, parent = current revision', () => {
  const { db, cleanup } = freshDb();
  try {
    const { id } = addEntry(db, { type: 'decision', title: 'v1', summary: 's', description: 'd1' });
    const ulid = ulidOf(db, id);
    assert.equal(revisionsOf(db, ulid).length, 0, 'no revision before the first edit');
    updateEntry(db, { id, title: 'v2' });
    updateEntry(db, { id, description: 'd3' });
    updateEntry(db, { id, title: 'v2' }); // no-op edit: same text
    const revs = revisionsOf(db, ulid);
    assert.equal(revs.length, 3);
    assert.deepEqual(revs.map((r) => [r.title, r.description]), [['v1', 'd1'], ['v2', 'd1'], ['v2', 'd3']]);
    assert.equal(revs[0].rev_id, rootRevId(ulid));
    assert.equal(revs[0].parent_rev_id, null);
    assert.equal(revs[1].parent_rev_id, revs[0].rev_id);
    assert.equal(revs[2].parent_rev_id, revs[1].rev_id);
    assert.deepEqual(headsOf(revs).map((r) => r.rev_id), [revs[2].rev_id]);
  } finally { cleanup(); }
});

test('0007: the revision trigger is gone and doctor does not ask for it', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'trg_entries_revision'`).get(), undefined);
    assert.ok(db.prepare(`SELECT 1 FROM pragma_table_info('entry_revisions') WHERE name = 'merged_from'`).get());
    assert.equal(doctor(db).checks.find((c) => c.name === 'schema.triggers')!.severity, 'ok');
  } finally { cleanup(); }
});

test('a remote edit applied by cr-sqlite mints no local revision rows', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 7 });
    const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't1', summary: 's', module: 'm' });
    ship(a.db, b.db);
    const v = dbVersion(a.db);
    updateEntry(a.db, { id, title: 't2' });
    ship(a.db, b.db, v);
    const u = ulidOf(a.db, id);
    assert.equal(revisionsOf(b.db, u).length, revisionsOf(a.db, u).length);
    assert.deepEqual(ownChanges(b.db), [], 'the receiver wrote nothing of its own');
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});

test('two machines making the first edit at once share one root (a common merge base)', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 8 });
    const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', description: 'p1\n\np2', module: 'm' });
    ship(a.db, b.db);
    const va = dbVersion(a.db), vb = dbVersion(b.db);
    updateEntry(a.db, { id, description: 'P1\n\np2' });
    updateEntry(b.db, { id, description: 'p1\n\nP2' });
    ship(a.db, b.db, va); ship(b.db, a.db, vb);
    const u = ulidOf(a.db, id);
    for (const db of [a.db, b.db]) {
      const revs = revisionsOf(db, u);
      assert.equal(revs.length, 3, 'one shared root + one edit from each side');
      assert.equal(revs.filter((r) => r.rev_id === rootRevId(u)).length, 1);
      assert.equal(headsOf(revs).length, 2, 'a fork the post office must merge');
    }
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});
```

- [ ] **Step 3: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-revisions.test.ts`. Expected: FAIL, `Cannot find module '../src/revisions.js'`.

- [ ] **Step 4: Amend the staged migration.** In `mcp/migrations/staged/0007_sync_prep.sql`, after the `sync_state` table and before the `INSERT INTO schema_migrations` line, add:

```sql
-- Edits record their revision in code (core/src/revisions.ts), not by trigger:
-- the trigger also fired when cr-sqlite applied a REMOTE edit, minting rows
-- that exist on one machine only. merged_from: comma-separated rev_ids a
-- merge (post office) or a person's resolution folded in (spec D8).
ALTER TABLE entry_revisions ADD COLUMN merged_from TEXT;
DROP TRIGGER IF EXISTS trg_entries_revision;
```

Also update the header comment's description line to mention both.

- [ ] **Step 5: Implement `core/src/revisions.ts`.**

```ts
// file: core/src/revisions.ts
import type { DB } from "./db.js";

// Spec "Edits write revisions" + D8. Until 0007 a trigger wrote entry_revisions.
// It also fired when cr-sqlite applied a REMOTE edit, minting rows that exist on
// one machine only, so 0007 drops it: every text edit records its revision
// here, inside the writer's transaction.

export interface EntryText { title: string; summary: string; description: string | null }
export interface RevisionRow extends EntryText {
  rev_id: string;
  entry_ulid: string;
  parent_rev_id: string | null;
  merged_from: string | null;
  created_at: string;
}
export interface TextSnapshot extends EntryText { ulid: string; created_at: string; needs_merge: number }

/** 0007+: the trigger is gone and entry_revisions.merged_from exists. */
export function writesRevisionsInCode(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entry_revisions') WHERE name = 'merged_from'`).get();
}

/**
 * The first revision of an entry holds its text before the first edit. Its key
 * derives from the entry, so two machines making the first edit at once write
 * the SAME root row and their edits share a merge base.
 */
export const rootRevId = (ulid: string): string => `${ulid}.0`;

export function splitMerged(s: string | null): string[] {
  return s ? s.split(",").filter(Boolean) : [];
}

export function revisionsOf(db: DB, ulid: string): RevisionRow[] {
  return db
    .prepare(
      `SELECT rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description, created_at
         FROM entry_revisions WHERE entry_ulid = ? ORDER BY created_at, rev_id`,
    )
    .all(ulid) as RevisionRow[];
}

/** Revisions nothing builds on. Two or more = edits not merged yet. */
export function headsOf(revs: RevisionRow[]): RevisionRow[] {
  const used = new Set<string>();
  for (const r of revs) {
    if (r.parent_rev_id) used.add(r.parent_rev_id);
    for (const m of splitMerged(r.merged_from)) used.add(m);
  }
  return revs.filter((r) => !used.has(r.rev_id));
}

const sameText = (a: EntryText, b: EntryText): boolean =>
  a.title === b.title && a.summary === b.summary && (a.description ?? null) === (b.description ?? null);

/** The entry's text BEFORE an edit. Null below 0007, where the trigger still records revisions. */
export function snapshotForRevision(db: DB, ulid: string): TextSnapshot | null {
  if (!writesRevisionsInCode(db)) return null;
  const r = db
    .prepare(`SELECT ulid, title, summary, description, created_at, needs_merge FROM entries WHERE ulid = ?`)
    .get(ulid) as TextSnapshot | undefined;
  return r ?? null;
}

/**
 * After an edit: append its revision. Parent = the newest revision holding the
 * text the edit started from (else the newest). If the entry was flagged
 * needs_merge, this edit is a person's resolution: it folds every other head in
 * and clears the flag. Returns the new rev_id, or null if nothing changed.
 */
export function finishRevision(db: DB, before: TextSnapshot | null): string | null {
  if (!before) return null;
  const after = db.prepare(`SELECT title, summary, description FROM entries WHERE ulid = ?`).get(before.ulid) as
    | EntryText
    | undefined;
  if (!after) return null;
  const resolving = before.needs_merge === 1;
  if (!resolving && sameText(after, before)) return null;

  let revs = revisionsOf(db, before.ulid);
  if (revs.length === 0) {
    db.prepare(
      `INSERT OR IGNORE INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, title, summary, description, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(rootRevId(before.ulid), before.ulid, before.title, before.summary, before.description, before.created_at);
    revs = revisionsOf(db, before.ulid);
  }
  const newestFirst = [...revs].reverse();
  const parent = newestFirst.find((r) => sameText(r, before)) ?? newestFirst[0];
  const folded = resolving
    ? headsOf(revs).filter((h) => h.rev_id !== parent.rev_id).map((h) => h.rev_id)
    : [];
  const row = db
    .prepare(
      `INSERT INTO entry_revisions (entry_ulid, parent_rev_id, merged_from, title, summary, description)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING rev_id`,
    )
    .get(before.ulid, parent.rev_id, folded.length ? folded.join(",") : null, after.title, after.summary, after.description) as {
    rev_id: string;
  };
  if (resolving) db.prepare(`UPDATE entries SET needs_merge = 0 WHERE ulid = ?`).run(before.ulid);
  return row.rev_id;
}
```

- [ ] **Step 6: Wire the writers.**
  - `core/src/ops/update.ts`: import `{ snapshotForRevision, finishRevision }` from `../revisions.js`. Replace the `const info = db.prepare(...UPDATE...).run(params); if (info.changes === 0) throw ...` block with:

```ts
  // Spec "Edits write revisions": the snapshot/finish pair records the revision
  // in the same transaction as the edit (0007+; below 0007 the trigger does it).
  const tx = db.transaction(() => {
    const before = params.ulid ? snapshotForRevision(db, params.ulid as string) : null;
    const info = db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE ${where}`).run(params);
    if (info.changes === 0) throw new Error(`no entry found with id ${args.id}`);
    finishRevision(db, before);
  });
  tx();
```

  - `server/src/tools/collab.ts` (REST edit): add `snapshotForRevision, finishRevision` to the core import; inside the edit transaction, first line `const before = byUlid ? snapshotForRevision(db, owner.ulid as string) : null;`, last line `finishRevision(db, before);`.
  - `core/src/ops/doctor.ts`: change `const expectedTriggers =` to `let expectedTriggers =`, and extend the 0007 line:

```ts
  // 0007 (staged) adds the local-only sync_state table and drops the revision
  // trigger (revisions are written by code from 0007, core/src/revisions.ts).
  if (applied("0007_sync_prep")) {
    expectedTables.add("sync_state");
    expectedTriggers = new Set([...expectedTriggers].filter((t) => t !== "trg_entries_revision"));
  }
```

  - `core/src/index.ts`: `export * from './revisions.js';`

- [ ] **Step 7: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-revisions.test.ts test/migrate-0005.test.ts test/sync-prep.test.ts`. Expected: PASS (the 0005 trigger tests are untouched: they run at 0005).

- [ ] **Step 8: Commit** `feat(core): edits write revisions in code; 0007 drops the revision trigger (sync v1 plan 2)`

---

### Task 2: Bookkeeping triggers skip what cr-sqlite is applying

Why: besides the revision trigger, five more triggers write rows on their own (`trg_entries_updated_at`, `trg_modules_updated_at`, `trg_entries_fill_superseded_ulid`, `trg_refs_fill_target_ulid`, the two cascade deletes). When cr-sqlite applies a remote change, their writes are untracked (cr-sqlite's sync bit is set), so the receiver silently diverges, e.g. a received `entry` link gets a `target_ulid` filled from the RECEIVER's numbering that nobody else has. Once sharing is on, `enableSync` re-creates them with `WHEN crsql_internal_sync_bit() = 0`. FTS triggers are NOT guarded: the search index is local and must follow received rows (D15).

**Files:**
- Modify: `core/src/sync/enable.ts`
- Create: `core/test/sync-triggers.test.ts`

**Interfaces produced:** `GUARDED_TRIGGERS_SQL` (internal), unchanged `enableSync` signature.

- [ ] **Step 1: Write the failing test.**

```ts
// file: core/test/sync-triggers.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, ship, ownChanges } from './helpers/sync.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { enableSync } from '../src/sync/enable.js';
import { setAllocator } from '../src/sync/allocator.js';

test('a received link is not re-resolved against the receiver\'s own numbers', async () => {
  const a = freshDb({ shared: true }), b = freshDb();
  try {
    for (let i = 0; i < 5; i++) addEntry(b.db, { type: 'decision', title: `b${i}`, summary: 's' }); // B owns E-1..E-5
    enableSync(b.db);
    setAllocator({ allocate: async () => 100 });
    await addEntryAsync(a.db, { type: 'decision', title: 'x', summary: 's', module: 'm', refs: [{ ref_type: 'entry', ref_value: 'E-5' }] });
    const target = (db: any) => (db.prepare(`SELECT target_ulid t FROM refs WHERE ref_value = 'E-5'`).get() as { t: string | null }).t;
    assert.equal(target(a.db), null, 'A has no E-5');
    ship(a.db, b.db);
    assert.equal(target(b.db), null, 'B must hold exactly what A sent');
    assert.deepEqual(ownChanges(b.db).filter((c) => c.t === 'refs'), []);
    const upd = (db: any) => (db.prepare(`SELECT updated_at u FROM entries WHERE id = 100`).get() as { u: string }).u;
    assert.equal(upd(b.db), upd(a.db));
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});

test('local writes still run the bookkeeping triggers once sharing is on', () => {
  const { db, cleanup } = freshDb();
  try {
    addEntry(db, { type: 'decision', title: 'one', summary: 's' });
    enableSync(db);
    db.prepare(`UPDATE entries SET updated_at = '2000-01-01 00:00:00'`).run();
    db.prepare(`UPDATE entries SET status = 'resolved'`).run();
    assert.notEqual((db.prepare(`SELECT updated_at u FROM entries`).get() as { u: string }).u, '2000-01-01 00:00:00');
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-triggers.test.ts`. Expected: the first test FAILS on `B must hold exactly what A sent` (B's trigger filled B's own E-5 ulid); the second passes already.

- [ ] **Step 3: Implement.** In `core/src/sync/enable.ts` add (after `SYNCED_TABLES`):

```ts
// Triggers that write rows on their own. While cr-sqlite applies a REMOTE
// change its sync bit is 1 and their writes would be untracked (never
// replicated), so the receiver would silently diverge. FTS triggers are NOT
// here: the search index is local and must follow received rows (D15).
const GUARDED_TRIGGERS_SQL: Array<[name: string, sql: string]> = [
  ["trg_entries_updated_at", `CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category,
                superseded_by, deleted_at
ON entries FOR EACH ROW WHEN crsql_internal_sync_bit() = 0
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE ulid = OLD.ulid;
END`],
  ["trg_modules_updated_at", `CREATE TRIGGER trg_modules_updated_at
AFTER UPDATE ON modules FOR EACH ROW WHEN crsql_internal_sync_bit() = 0
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END`],
  ["trg_entries_fill_superseded_ulid", `CREATE TRIGGER trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
WHEN crsql_internal_sync_bit() = 0
 AND NEW.superseded_by IS NOT OLD.superseded_by
 AND NEW.superseded_by_ulid IS OLD.superseded_by_ulid
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = NEW.superseded_by ORDER BY e.ulid LIMIT 1)
   WHERE ulid = NEW.ulid;
END`],
  ["trg_refs_fill_target_ulid", `CREATE TRIGGER trg_refs_fill_target_ulid
AFTER INSERT ON refs
WHEN crsql_internal_sync_bit() = 0 AND NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
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
END`],
  ["trg_refs_cascade_delete", `CREATE TRIGGER trg_refs_cascade_delete
AFTER DELETE ON entries WHEN crsql_internal_sync_bit() = 0
BEGIN
  DELETE FROM refs WHERE entry_ulid = old.ulid;
END`],
  ["trg_entry_modules_cascade_delete", `CREATE TRIGGER trg_entry_modules_cascade_delete
AFTER DELETE ON entries WHEN crsql_internal_sync_bit() = 0
BEGIN
  DELETE FROM entry_modules WHERE entry_ulid = old.ulid;
END`],
];
```

and inside the `enableSync` transaction, after the `crsql_as_crr` loop and before `setSyncValue`:

```ts
    for (const [name, sql] of GUARDED_TRIGGERS_SQL) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(sql);
    }
```

The bodies are copied verbatim from 0006 (only the `WHEN` changes); the trigger-name set is unchanged, so doctor's `schema.triggers` stays ok.

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-triggers.test.ts test/sync-prep.test.ts test/sync-revisions.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): bookkeeping triggers skip changes cr-sqlite applies (sync v1 plan 2)`

---

### Task 3: Check first, then ask; one ulid across retries (E-713)

**Files:**
- Create: `core/src/sync/errors.ts`, `core/test/sync-allocate.test.ts`
- Modify: `core/src/sync/allocator.ts`, `core/src/ops/add.ts`, `core/src/index.ts`

**Interfaces produced:** `validateAddEntryArgs(args): void` (throws the same messages `addEntry` always threw, plus new ones for type/category/agent/status/refs); `resolveAllocator(db)`; `allocateWithRetry(allocator, ulid)`; `setAllocationRetry(policy | null)`; `RetryPolicy`, `DEFAULT_RETRY`. `PostOfficeUnreachableError` and `SyncAllocationRequiredError` move to `errors.ts` and stay re-exported from `allocator.ts`.

An error with `retriable === false` (revoked key, pin mismatch, a 4xx) stops the retries at once.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: core/test/sync-allocate.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { addEntryAsync, type AddEntryArgs } from '../src/ops/add.js';
import { setAllocator, setAllocationRetry, PostOfficeUnreachableError, type Allocator } from '../src/sync/allocator.js';

/** An in-memory post office counter, idempotent by ulid (what Task 7 builds for real). */
function fakeOffice(seed = 0, behave?: (ulid: string, call: number) => 'answer' | 'drop-after-assign' | 'hang' | 'fail' | 'refuse') {
  const byUlid = new Map<string, number>();
  const calls: string[] = [];
  let counter = seed;
  const allocator: Allocator = {
    allocate(ulid) {
      calls.push(ulid);
      const mode = behave ? behave(ulid, calls.length) : 'answer';
      if (mode === 'hang') return new Promise<number>(() => {});
      if (mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      if (mode === 'refuse') return Promise.reject(Object.assign(new Error('access revoked'), { retriable: false }));
      let id = byUlid.get(ulid);
      if (id === undefined) { id = ++counter; byUlid.set(ulid, id); }
      return mode === 'drop-after-assign' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(id);
    },
  };
  return { allocator, calls, counter: () => counter };
}

const ok: AddEntryArgs = { type: 'decision', title: 't', summary: 's', module: 'm' };
const count = (db: any) => (db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
const BAD: Array<[AddEntryArgs, RegExp]> = [
  [{ ...ok, title: ' ' }, /title is required/],
  [{ ...ok, summary: '' }, /summary is required/],
  [{ ...ok, summary: 'x'.repeat(201) }, /summary exceeds 200/],
  [{ ...ok, type: 'bogus' as any }, /invalid type/],
  [{ ...ok, type: 'rollup' }, /system-generated/],
  [{ ...ok, category: 'Nope' as any }, /invalid category/],
  [{ ...ok, agent: 'Bob' as any }, /invalid agent/],
  [{ ...ok, status: 'resolved' as any }, /invalid status/],
  [{ ...ok, refs: [{ ref_type: 'nope' as any, ref_value: 'x' }] }, /invalid ref_type/],
  [{ ...ok, refs: [{ ref_type: 'file', ref_value: '' }] }, /ref_value/],
];

test('invalid input is refused before a number is asked for', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice();
  try {
    setAllocator(po.allocator);
    for (const [args, msg] of BAD) await assert.rejects(addEntryAsync(db, args), msg);
    assert.equal(po.calls.length, 0, 'no number was consumed');
    assert.equal(count(db), 0);
  } finally { setAllocator(null); cleanup(); }
});

test('sharing off: the same checks, the same messages', async () => {
  const { db, cleanup } = freshDb();
  try { for (const [args, msg] of BAD) await assert.rejects(addEntryAsync(db, args), msg); } finally { cleanup(); }
});

test('1000 saves with 50 invalid: the allocated numbers have no gaps', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(700);
  try {
    setAllocator(po.allocator);
    const ids: number[] = [];
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      if (i % 20 === 7) {
        const [args, msg] = BAD[(i / 20 | 0) % BAD.length];
        await assert.rejects(addEntryAsync(db, args), msg);
        refused++;
      } else {
        ids.push((await addEntryAsync(db, { ...ok, title: `n${i}` })).id);
      }
    }
    assert.equal(refused, 50);
    assert.equal(po.calls.length, 950);
    assert.deepEqual([...ids].sort((x, y) => x - y), Array.from({ length: 950 }, (_, k) => 701 + k));
    assert.equal(count(db), 950);
  } finally { setAllocator(null); cleanup(); }
});

test('an answer lost after the post office assigned: the retry reuses the ulid and gets the same number', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, (_u, call) => (call === 1 ? 'drop-after-assign' : 'answer'));
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ delaysMs: [0, 0] });
    const r = await addEntryAsync(db, ok);
    assert.equal(r.id, 1);
    assert.equal(po.calls.length, 2);
    assert.equal(po.calls[0], po.calls[1], 'one ulid for every try');
    assert.equal(po.counter(), 1, 'the counter moved once');
    assert.equal((db.prepare('SELECT ulid FROM entries WHERE id = 1').get() as { ulid: string }).ulid, po.calls[0]);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('an unanswered request times out and is retried with the same ulid', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, (_u, call) => (call === 1 ? 'hang' : 'answer'));
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ timeoutMs: 50, delaysMs: [0, 0] });
    assert.equal((await addEntryAsync(db, ok)).id, 1);
    assert.equal(po.calls[0], po.calls[1]);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('three failures: refused, nothing written, one ulid used for all three tries', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, () => 'fail');
  try {
    setAllocator(po.allocator);
    setAllocationRetry({ delaysMs: [0, 0] });
    await assert.rejects(addEntryAsync(db, ok), PostOfficeUnreachableError);
    assert.equal(po.calls.length, 3);
    assert.equal(new Set(po.calls).size, 1);
    assert.equal(count(db), 0);
  } finally { setAllocator(null); setAllocationRetry(null); cleanup(); }
});

test('a non-retriable refusal (revoked key) is not retried', async () => {
  const { db, cleanup } = freshDb({ shared: true });
  const po = fakeOffice(0, () => 'refuse');
  try {
    setAllocator(po.allocator);
    await assert.rejects(addEntryAsync(db, ok), /access revoked/);
    assert.equal(po.calls.length, 1);
  } finally { setAllocator(null); cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-allocate.test.ts`. Expected: FAIL (`setAllocationRetry` is not exported; then, once it exists, the "invalid input" test fails because `addEntryAsync` asks for a number before `addEntry`'s checks run).

- [ ] **Step 3: Implement.**

```ts
// file: core/src/sync/errors.ts
// Errors shared by the allocator, the HTTPS client and the courier (sync v1).
// `retriable = false` stops addEntryAsync's retries at once (E-713).

export class PostOfficeUnreachableError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(
      `[collab-mcp] Not saved: this notes database is shared, and a note number could not be obtained from the post office (${detail}). Nothing was written. Start the post office (or reconnect), then retry.`,
      { cause },
    );
    this.name = "PostOfficeUnreachableError";
  }
}

export class SyncAllocationRequiredError extends Error {
  constructor() {
    super(`[collab-mcp] This notes database is shared, so new note numbers must come from the post office. Use addEntryAsync. (rollup/archive are not available while sharing is on in v1.)`);
    this.name = "SyncAllocationRequiredError";
  }
}

/** D13: the certificate is not the one the join code pinned. Possibly an impostor. */
export class PinMismatchError extends Error {
  readonly retriable = false;
  constructor(url: string, expected: string, got: string) {
    super(
      `[collab-mcp] Refusing to talk to ${url}: its certificate (${got.slice(0, 16)}…) is not the one pinned by the join code (${expected.slice(0, 16)}…). Something else may be pretending to be the post office.`,
    );
    this.name = "PinMismatchError";
  }
}

/** D12: 401. The key was revoked (or never issued). */
export class AccessRevokedError extends Error {
  readonly retriable = false;
  constructor(url: string) {
    super(`[collab-mcp] The post office at ${url} refused this machine's key: access revoked or unknown. Ask its owner for a new join code.`);
    this.name = "AccessRevokedError";
  }
}
```

Replace `core/src/sync/allocator.ts` with:

```ts
// file: core/src/sync/allocator.ts
// Sharing on => E-numbers come only from the post office (spec D7, collab
// E-648/E-708). E-713: idempotent by ulid, retried with the SAME ulid.
import type { DB } from "../db.js";
import { PostOfficeUnreachableError } from "./errors.js";
import { httpAllocatorFromDb } from "./http-allocator.js";

export { PostOfficeUnreachableError, SyncAllocationRequiredError } from "./errors.js";

export interface Allocator {
  allocate(ulid: string): Promise<number>;
}
let current: Allocator | null = null;
export function setAllocator(a: Allocator | null): void { current = a; }
export function getAllocator(): Allocator | null { return current; }

/** An explicitly registered allocator, else the HTTPS one this DB's sync_state configures. */
export function resolveAllocator(db: DB): Allocator | null {
  return current ?? httpAllocatorFromDb(db);
}

export interface RetryPolicy { attempts: number; timeoutMs: number; delaysMs: number[] }
/** 3 tries, 1.5 s each, pauses of 250 ms and 750 ms: about 5 s at worst (E-713). */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, timeoutMs: 1500, delaysMs: [250, 750] };
let policy: RetryPolicy = DEFAULT_RETRY;
export function setAllocationRetry(p: Partial<RetryPolicy> | null): void {
  policy = p ? { ...DEFAULT_RETRY, ...p } : DEFAULT_RETRY;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * Ask for the number for `ulid`, retrying with the SAME ulid: the post office is
 * idempotent by ulid, so if it assigned a number and the answer was lost, the
 * retry gets that same number (E-713). Throws PostOfficeUnreachableError.
 */
export async function allocateWithRetry(a: Allocator, ulid: string): Promise<number> {
  let last: unknown = new Error("no attempt was made");
  const attempts = Math.max(1, policy.attempts);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(policy.delaysMs[Math.min(i - 1, policy.delaysMs.length - 1)] ?? 0);
    try {
      const id = await withTimeout(Promise.resolve().then(() => a.allocate(ulid)), policy.timeoutMs);
      if (!Number.isInteger(id) || id < 1) {
        throw Object.assign(new Error(`the post office returned an invalid number (${String(id)})`), { retriable: false });
      }
      return id;
    } catch (e) {
      last = e;
      if ((e as { retriable?: boolean } | null)?.retriable === false) break;
    }
  }
  throw new PostOfficeUnreachableError(last instanceof Error ? last.message : String(last), last);
}
```

Task 5 creates `http-allocator.ts`; until then create it as a stub so this task compiles:

```ts
// file: core/src/sync/http-allocator.ts
// Replaced in Task 5 (the HTTPS allocator).
import type { DB } from "../db.js";
import type { Allocator } from "./allocator.js";
export function httpAllocatorFromDb(_db: DB): Allocator | null { return null; }
```

In `core/src/ops/add.ts`:
1. Replace the four checks at the top of `addEntry` (title, summary, summary length, rollup) with one call: `validateAddEntryArgs(args);`
2. Add above `addEntry`:

```ts
const ENTRY_TYPES = Object.keys(KIND_BY_TYPE);
const CATEGORIES = ["Index", "Reference", "Activity"];
const AGENTS = ["Claude", "Codex", "Gemini", "User"];
const REF_TYPES = ["file", "task", "entry", "url"];

/**
 * Every check a new entry must pass, run BEFORE a number is requested (E-713):
 * a save refused for bad input must never consume a post office number. The
 * first four messages are addEntry's historical ones; the rest mirror the
 * schema's CHECK constraints so the database never has to be the one to refuse.
 */
export function validateAddEntryArgs(args: AddEntryArgs): void {
  if (!args.title || args.title.trim().length === 0) throw new Error("title is required");
  if (!args.summary || args.summary.trim().length === 0) throw new Error("summary is required");
  if (args.summary.length > 200) throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
  if (args.type === "rollup") throw new Error("rollup entries are system-generated; use collab.rollup (not collab.add)");
  if (!ENTRY_TYPES.includes(args.type)) throw new Error(`invalid type: ${String(args.type)}`);
  if (args.category !== undefined && !CATEGORIES.includes(args.category)) throw new Error(`invalid category: ${String(args.category)}`);
  if (args.agent !== undefined && !AGENTS.includes(args.agent)) throw new Error(`invalid agent: ${String(args.agent)}`);
  if (args.status !== undefined && args.status !== "draft" && args.status !== "active") {
    throw new Error(`invalid status: ${String(args.status)} (a new note is draft or active)`);
  }
  if (args.description !== undefined && args.description !== null && typeof args.description !== "string") {
    throw new Error("description must be text");
  }
  for (const m of [args.module, ...(args.modules ?? [])]) {
    if (m !== undefined && typeof m !== "string") throw new Error(`invalid module: ${String(m)}`);
  }
  if (args.task_id !== undefined && typeof args.task_id !== "string") throw new Error("task_id must be text");
  for (const r of args.refs ?? []) {
    if (!r || !REF_TYPES.includes(r.ref_type)) throw new Error(`invalid ref_type: ${String(r?.ref_type)}`);
    if (typeof r.ref_value !== "string" || r.ref_value.length === 0) throw new Error("every ref needs a non-empty ref_value");
  }
}
```

3. Replace `addEntryAsync` with:

```ts
/**
 * The entry point for every async caller. Checks the input FIRST (E-713), then:
 * sharing off => identical to addEntry; sharing on => ask the post office for
 * the number with ONE ulid across bounded retries; if that fails, nothing is
 * written (E-708: refuse to save).
 */
export async function addEntryAsync(db: DB, args: AddEntryArgs): Promise<AddEntryResult> {
  validateAddEntryArgs(args);
  if (!isSyncEnabled(db)) return addEntry(db, args);
  const allocator = resolveAllocator(db);
  if (!allocator) throw new PostOfficeUnreachableError("no post office connection is configured on this machine");
  const ulid = newUlid();
  const id = await allocateWithRetry(allocator, ulid);
  return addEntry(db, { ...args, assigned: { ulid, id } });
}
```

and change its import line to `import { resolveAllocator, allocateWithRetry, PostOfficeUnreachableError } from "../sync/allocator.js";`.

Add to `core/src/index.ts`: `export * from './sync/errors.js';` and `export * from './sync/http-allocator.js';`. Because `allocator.ts` re-exports the two old error classes, keep the index line for `allocator.js` but make sure there is no duplicate-export error: `export *` of the same binding from two modules is allowed when both resolve to the same original declaration (they do).

- [ ] **Step 4: Run and confirm it passes, plus regressions.** Run: `cd core && npx tsx --test test/sync-allocate.test.ts test/sync-prep.test.ts test/write-paths-0006.test.ts test/entry-write.test.ts`. Expected: PASS. Then the whole suite: `npm -w @collab-mcp/core test` (an existing test that relied on the DB's CHECK message for a bad type/category would now see the new message: if one fails, adapt the assertion to the new, clearer message and report it).

- [ ] **Step 5: Commit** `feat(core): check input before asking for a number; one ulid across retries (E-713, sync v1 plan 2)`

---
### Task 4: Certificate, join code, pinned HTTPS client

**Files:**
- Create: `core/src/sync/cert.ts`, `core/src/sync/joincode.ts`, `core/src/sync/http.ts`, `core/test/sync-http.test.ts`
- Modify: `core/src/index.ts`

**Interfaces produced:**
- `generateSelfSignedCert(opts?) → { certPem, keyPem, fingerprint }` (fingerprint = lowercase hex SHA-256 of the DER), `fingerprintOfPem(pem)`, `normalizeFingerprint(s)`.
- `formatJoinCode({url, fingerprint, device, secret}) → "collab1-…"`, `parseJoinCode(code)`.
- `PostOfficeTarget { url; fingerprint; auth?: { device; key } }`, `connectPinned(target, timeoutMs)`, `requestJson(target, method, path, body?, {timeoutMs}) → {status, body}` (401 throws `AccessRevokedError`), `openEventStream(target, path, {event, close}) → {close}`.

The pin is checked on `secureConnect`, BEFORE the HTTP request is created, so an impostor never receives a byte (not even the key in the header). The certificate's hostname is deliberately NOT checked: trust is the pinned fingerprint, so the post office keeps working when its LAN address changes (D3: "moving it is a URL + certificate change").

- [ ] **Step 1: Write the failing tests.**

```ts
// file: core/test/sync-http.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateSelfSignedCert, fingerprintOfPem, normalizeFingerprint } from '../src/sync/cert.js';
import { formatJoinCode, parseJoinCode } from '../src/sync/joincode.js';
import { requestJson, openEventStream } from '../src/sync/http.js';
import { PinMismatchError, AccessRevokedError } from '../src/sync/errors.js';

export async function stubServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const c = generateSelfSignedCert();
  const seen: string[] = [];
  const srv = https.createServer({ cert: c.certPem, key: c.keyPem }, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { seen.push(`${req.method} ${req.url}`); handler(req, res, body); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `https://127.0.0.1:${port}`, fingerprint: c.fingerprint, seen,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

test('a self-signed certificate: parseable, fingerprint = sha256 of the DER', () => {
  const c = generateSelfSignedCert();
  assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintOfPem(c.certPem), c.fingerprint);
  assert.match(c.keyPem, /BEGIN PRIVATE KEY/);
  assert.equal(normalizeFingerprint('AB:cd:01'), 'abcd01');
});

test('join codes round-trip and reject garbage', () => {
  const code = formatJoinCode({ url: 'https://10.0.0.2:7443', fingerprint: 'AA:'.repeat(31) + 'AA', device: 'd-1', secret: 's3cret' });
  assert.match(code, /^collab1-[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseJoinCode(`  ${code}\n`), { url: 'https://10.0.0.2:7443', fingerprint: 'aa'.repeat(32), device: 'd-1', secret: 's3cret' });
  assert.throws(() => parseJoinCode('hello'), /not a collab join code/);
  assert.throws(() => parseJoinCode('collab1-!!!!'), /damaged|incomplete/);
  assert.throws(() => parseJoinCode('collab1-' + Buffer.from('{"u":"http://x"}').toString('base64url')), /incomplete/);
});

test('requestJson talks JSON and sends the device key', async () => {
  const s = await stubServer((req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization, got: JSON.parse(body) }));
  });
  try {
    const r = await requestJson({ url: s.url, fingerprint: s.fingerprint, auth: { device: 'd-1', key: 'k' } }, 'POST', '/v1/echo', { a: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { auth: 'Bearer d-1:k', got: { a: 1 } });
  } finally { await s.close(); }
});

test('a wrong pin: refused before a single request byte is sent', async () => {
  const s = await stubServer((_q, res) => res.end('{}'));
  try {
    await assert.rejects(requestJson({ url: s.url, fingerprint: 'ab'.repeat(32), auth: { device: 'd', key: 'secret' } }, 'GET', '/v1/status'), PinMismatchError);
    assert.deepEqual(s.seen, []);
  } finally { await s.close(); }
});

test('401 means revoked', async () => {
  const s = await stubServer((_q, res) => { res.writeHead(401); res.end('{"error":"no"}'); });
  try {
    await assert.rejects(requestJson({ url: s.url, fingerprint: s.fingerprint }, 'GET', '/v1/status'), AccessRevokedError);
  } finally { await s.close(); }
});

test('only https:// post office URLs are accepted', async () => {
  await assert.rejects(requestJson({ url: 'http://127.0.0.1:1', fingerprint: 'ab'.repeat(32) }, 'GET', '/'), /https/);
});

test('the SSE reader delivers named events and skips comments', async () => {
  const s = await stubServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\nevent: changes\ndata: {"last_seq":3}\n\n: ping\n\n');
    setTimeout(() => res.end('event: modules\ndata: {}\n\n'), 20);
  });
  try {
    const got: Array<[string, string]> = [];
    const closed = await new Promise<Error | undefined>((resolve) => {
      openEventStream({ url: s.url, fingerprint: s.fingerprint }, '/v1/events', {
        event: (name, data) => got.push([name, data]),
        close: (err) => resolve(err),
      });
    });
    assert.deepEqual(got, [['changes', '{"last_seq":3}'], ['modules', '{}']]);
    assert.match(String(closed?.message), /ended/);
  } finally { await s.close(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-http.test.ts`. Expected: FAIL, `Cannot find module '../src/sync/cert.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: core/src/sync/cert.ts
import { generateKeyPairSync, sign, randomBytes, createHash, X509Certificate } from "node:crypto";

// A self-signed certificate from node:crypto alone (no dependency): EC P-256
// key, ECDSA-SHA256 signature, a minimal X.509 v3 body without extensions.
// Trust comes from the fingerprint pinned in the join code (D13), not from a
// CA or a hostname, so it keeps working when the post office's address changes.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
function oid(dotted: string): Buffer {
  const p = dotted.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function uint(b: Buffer): Buffer {
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function time(d: Date): Buffer {
  const s = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const body = s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + "Z";
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(body.slice(2))) : tlv(0x18, Buffer.from(body));
}

export interface SelfSignedCert { certPem: string; keyPem: string; fingerprint: string }

export function normalizeFingerprint(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

export function fingerprintOfPem(certPem: string): string {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
}

export function generateSelfSignedCert(opts: { commonName?: string; days?: number } = {}): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(opts.commonName ?? "collab post office", "utf8")))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, uint(Buffer.from([2]))), // v3
    uint(serial),
    ecdsaSha256,
    name,
    seq(time(new Date(now - 24 * 3600 * 1000)), time(new Date(now + (opts.days ?? 3650) * 24 * 3600 * 1000))),
    name,
    spki,
  );
  const signature = sign("sha256", tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { certPem, keyPem, fingerprint: createHash("sha256").update(der).digest("hex") };
}
```

```ts
// file: core/src/sync/joincode.ts
import { normalizeFingerprint } from "./cert.js";

// A one-time join code (D12, D13): where the post office is, the fingerprint
// of its certificate (the pin), and a one-time secret for one pre-registered
// device. Treat it like a password until it is used.
export interface JoinCode { url: string; fingerprint: string; device: string; secret: string }

const PREFIX = "collab1-";

export function formatJoinCode(c: JoinCode): string {
  const body = JSON.stringify({ u: c.url, f: normalizeFingerprint(c.fingerprint), d: c.device, s: c.secret });
  return PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

export function parseJoinCode(code: string): JoinCode {
  const t = code.trim();
  if (!t.startsWith(PREFIX)) throw new Error("not a collab join code (it starts with collab1-)");
  let o: { u?: unknown; f?: unknown; d?: unknown; s?: unknown };
  try {
    o = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("the join code is damaged (it could not be decoded); copy it again");
  }
  if (
    typeof o?.u !== "string" || !o.u.startsWith("https://") ||
    typeof o.f !== "string" || normalizeFingerprint(o.f).length !== 64 ||
    typeof o.d !== "string" || !o.d || typeof o.s !== "string" || !o.s
  ) {
    throw new Error("the join code is incomplete; copy it again");
  }
  return { url: o.u, fingerprint: normalizeFingerprint(o.f), device: o.d, secret: o.s };
}
```

```ts
// file: core/src/sync/http.ts
import tls from "node:tls";
import http from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PinMismatchError, AccessRevokedError } from "./errors.js";
import { normalizeFingerprint } from "./cert.js";

// HTTPS to the post office with certificate PINNING (D13): the server's
// certificate must hash to the fingerprint from the join code. The check runs
// on secureConnect, before the HTTP request exists, so an impostor never sees
// a byte of it (not even the key in the Authorization header). Hostnames are
// not checked: the pin is the trust, so a changed LAN address still works.

export interface PostOfficeTarget { url: string; fingerprint: string; auth?: { device: string; key: string } }
export interface JsonResponse { status: number; body: any }

function hostPort(url: string): { host: string; port: number } {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a post office URL: ${url}`); }
  if (u.protocol !== "https:") throw new Error(`the post office URL must start with https:// (got ${url})`);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : 443 };
}

export function connectPinned(target: PostOfficeTarget, timeoutMs = 5000): Promise<tls.TLSSocket> {
  let where: { host: string; port: number };
  try { where = hostPort(target.url); } catch (e) { return Promise.reject(e); }
  const want = normalizeFingerprint(target.fingerprint);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: where.host, port: where.port,
      servername: isIP(where.host) ? undefined : where.host,
      rejectUnauthorized: false, // replaced by the pin check below
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`could not reach the post office at ${target.url} within ${timeoutMs} ms`));
    }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = sock.getPeerX509Certificate();
      const got = cert ? createHash("sha256").update(cert.raw).digest("hex") : "";
      if (got !== want) {
        sock.destroy();
        reject(new PinMismatchError(target.url, want, got || "none"));
        return;
      }
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not reach the post office at ${target.url}: ${e.message}`));
    });
  });
}

function headers(target: PostOfficeTarget, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (target.auth) h.authorization = `Bearer ${target.auth.device}:${target.auth.key}`;
  return h;
}

export async function requestJson(
  target: PostOfficeTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const { host, port } = hostPort(target.url);
  const sock = await connectPinned(target, timeoutMs);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method, path, host, port,
        headers: headers(target, {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        }),
        createConnection: () => sock,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          sock.destroy();
          if (res.statusCode === 401) return reject(new AccessRevokedError(target.url));
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text.slice(0, 200) }; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from the post office at ${target.url} within ${timeoutMs} ms`)));
    req.on("error", (e) => { sock.destroy(); reject(e); });
    req.end(payload);
  });
}

export interface EventStream { close(): void }

/**
 * Server-sent events (the doorbell). `close(err)` fires exactly once: with an
 * error when the stream drops or is refused (AccessRevokedError on 401), with
 * no argument when the caller closed it.
 */
export function openEventStream(
  target: PostOfficeTarget,
  path: string,
  on: { event(name: string, data: string): void; close(err?: Error): void },
): EventStream {
  let req: http.ClientRequest | null = null;
  let done = false;
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    try { req?.destroy(); } catch { /* already gone */ }
    on.close(err);
  };
  connectPinned(target).then(
    (sock) => {
      if (done) { sock.destroy(); return; }
      const { host, port } = hostPort(target.url);
      req = http.request(
        { method: "GET", path, host, port, headers: headers(target, { accept: "text/event-stream" }), createConnection: () => sock },
        (res) => {
          if (res.statusCode === 401) { res.resume(); return finish(new AccessRevokedError(target.url)); }
          if (res.statusCode !== 200) { res.resume(); return finish(new Error(`the post office refused the event stream (${res.statusCode})`)); }
          res.setEncoding("utf8");
          let buf = "";
          res.on("data", (chunk: string) => {
            buf += chunk.replace(/\r\n/g, "\n");
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let name = "message";
              const data: string[] = [];
              for (const line of block.split("\n")) {
                if (line.startsWith(":")) continue;
                if (line.startsWith("event:")) name = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
              }
              if (data.length > 0 || name !== "message") on.event(name, data.join("\n"));
            }
          });
          res.on("end", () => finish(new Error("the event stream ended")));
          res.on("error", (e) => finish(e));
        },
      );
      req.on("error", (e) => finish(e));
      req.end();
    },
    (e) => finish(e),
  );
  return { close: () => finish() };
}
```

Add to `core/src/index.ts`: `export * from './sync/cert.js'; export * from './sync/joincode.js'; export * from './sync/http.js';`

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-http.test.ts`. Expected: PASS (7 tests).

- [ ] **Step 5: Commit** `feat(core): self-signed cert, join codes, pinned HTTPS + SSE client (sync v1 plan 2)`

---

### Task 5: The HTTPS allocator

**Files:**
- Replace: `core/src/sync/http-allocator.ts`
- Create: `core/test/sync-http-allocator.test.ts`

**Interfaces produced:** `SYNC_KEYS` (`po_url`, `po_fingerprint`, `device_id`, `device_key` in `sync_state`), `postOfficeTargetFromDb(db)`, `class HttpAllocator`, `httpAllocatorFromDb(db)` (cached per DB handle; rebuilt when the config changes).

Every writer process (MCP server, REST server, scripts, Codex runs) gets the HTTPS allocator without code changes: `addEntryAsync` → `resolveAllocator(db)` → the config `collab sync setup` (Plan 3) writes into the DB's own local-only `sync_state`.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: core/test/sync-http-allocator.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { stubServer } from './sync-http.test.js';
import { addEntryAsync } from '../src/ops/add.js';
import { setAllocator, setAllocationRetry, PostOfficeUnreachableError } from '../src/sync/allocator.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS, httpAllocatorFromDb } from '../src/sync/http-allocator.js';

function configure(db: any, url: string, fingerprint: string) {
  setSyncValue(db, SYNC_KEYS.url, url);
  setSyncValue(db, SYNC_KEYS.fingerprint, fingerprint);
  setSyncValue(db, SYNC_KEYS.device, 'd-test');
  setSyncValue(db, SYNC_KEYS.key, 'k-test');
}

test('a shared DB configured with a post office gets its numbers over HTTPS', async () => {
  const auths: string[] = [];
  const s = await stubServer((req, res, body) => {
    auths.push(String(req.headers.authorization));
    assert.match(JSON.parse(body).ulid, /^[0-9A-Z]{26}$/);
    res.end(JSON.stringify({ id: 42 }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    assert.equal((await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' })).id, 42);
    assert.deepEqual(auths, ['Bearer d-test:k-test']);
  } finally { await s.close(); cleanup(); }
});

test('the connection drops after the post office assigned: the retry gets the same number', async () => {
  const byUlid = new Map<string, number>();
  const ulids: string[] = [];
  let n = 0;
  const s = await stubServer((req, res, body) => {
    const { ulid } = JSON.parse(body);
    ulids.push(ulid);
    if (!byUlid.has(ulid)) byUlid.set(ulid, ++n);
    if (ulids.length === 1) { req.socket.destroy(); return; } // assigned, answer lost
    res.end(JSON.stringify({ id: byUlid.get(ulid) }));
  });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(db, s.url, s.fingerprint);
    assert.equal((await addEntryAsync(db, { type: 'decision', title: 't', summary: 's' })).id, 1);
    assert.equal(ulids.length, 2);
    assert.equal(ulids[0], ulids[1]);
    assert.equal(n, 1);
  } finally { setAllocationRetry(null); await s.close(); cleanup(); }
});

test('401: refused at once, not retried, nothing written', async () => {
  const s = await stubServer((_q, res) => { res.writeHead(401); res.end('{}'); });
  const { db, cleanup } = freshDb({ shared: true });
  try {
    setAllocator(null);
    configure(db, s.url, s.fingerprint);
    await assert.rejects(addEntryAsync(db, { type: 'decision', title: 't', summary: 's' }), (e: any) => e instanceof PostOfficeUnreachableError && /revoked/.test(e.message));
    assert.equal(s.seen.length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c, 0);
  } finally { await s.close(); cleanup(); }
});

test('httpAllocatorFromDb: null until configured, cached per DB, rebuilt on change', () => {
  const { db, cleanup } = freshDb({ shared: true });
  try {
    assert.equal(httpAllocatorFromDb(db), null);
    configure(db, 'https://127.0.0.1:1', 'ab'.repeat(32));
    const a = httpAllocatorFromDb(db);
    assert.ok(a);
    assert.equal(httpAllocatorFromDb(db), a);
    setSyncValue(db, SYNC_KEYS.url, 'https://127.0.0.1:2');
    assert.notEqual(httpAllocatorFromDb(db), a);
  } finally { cleanup(); }
});
```

Note: importing `stubServer` from `sync-http.test.js` re-registers that file's tests in this process; they are cheap and still pass. (If that double run is unwanted, move `stubServer` to `test/helpers/https-stub.ts`; record which was done.)

- [ ] **Step 2: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-http-allocator.test.ts`. Expected: FAIL, `SYNC_KEYS` is not exported (the Task 3 stub).

- [ ] **Step 3: Implement.**

```ts
// file: core/src/sync/http-allocator.ts
import type { DB } from "../db.js";
import type { Allocator } from "./allocator.js"; // type-only: no runtime cycle
import { getSyncValue } from "./state.js";
import { requestJson, type PostOfficeTarget } from "./http.js";

// The real allocator (spec D7): POST /v1/allocate {ulid} -> {id}. Its config
// lives in the DB's LOCAL-ONLY sync_state, written by `collab sync setup`, so
// every writer process (MCP, REST, scripts, Codex runs) finds it without code.
export const SYNC_KEYS = {
  url: "po_url",
  fingerprint: "po_fingerprint",
  device: "device_id",
  key: "device_key",
} as const;

export function postOfficeTargetFromDb(db: DB): PostOfficeTarget | null {
  const url = getSyncValue(db, SYNC_KEYS.url);
  const fingerprint = getSyncValue(db, SYNC_KEYS.fingerprint);
  const device = getSyncValue(db, SYNC_KEYS.device);
  const key = getSyncValue(db, SYNC_KEYS.key);
  if (!url || !fingerprint || !device || !key) return null;
  return { url, fingerprint, auth: { device, key } };
}

export class HttpAllocator implements Allocator {
  constructor(readonly target: PostOfficeTarget, private readonly timeoutMs = 1500) {}
  async allocate(ulid: string): Promise<number> {
    const r = await requestJson(this.target, "POST", "/v1/allocate", { ulid }, { timeoutMs: this.timeoutMs });
    if (r.status === 200 && Number.isInteger(r.body?.id)) return r.body.id as number;
    const e = new Error(`the post office answered ${r.status}${r.body?.error ? `: ${r.body.error}` : ""}`);
    // A 4xx means the request itself is wrong; asking again cannot help.
    if (r.status >= 400 && r.status < 500) Object.assign(e, { retriable: false });
    throw e;
  }
}

const cache = new WeakMap<DB, { sig: string; allocator: HttpAllocator }>();

export function httpAllocatorFromDb(db: DB): HttpAllocator | null {
  const target = postOfficeTargetFromDb(db);
  if (!target) return null;
  const sig = JSON.stringify(target);
  const hit = cache.get(db);
  if (hit && hit.sig === sig) return hit.allocator;
  const allocator = new HttpAllocator(target);
  cache.set(db, { sig, allocator });
  return allocator;
}
```

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-http-allocator.test.ts test/sync-allocate.test.ts test/sync-prep.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): HTTPS allocator configured from sync_state (sync v1 plan 2)`

---

### Task 6: The change codec (shared by the post office and the courier)

**Files:**
- Create: `core/src/sync/changes.ts`, `core/test/sync-changes.test.ts`
- Modify: `core/src/index.ts`

**Interfaces produced:**
- `RawChange { table; pk: Buffer; cid; val: unknown; col_version; db_version; site_id: Buffer; cl; seq }` (a `crsql_changes` row) and `WireChange` (JSON-safe: `pk`/`site_id` base64, blob values as `{ b64 }`).
- `encodeChange(raw)`, `decodeChange(wire)` (validates shape; throws on junk).
- `readOwnChanges(db, sinceDbVersion)`: this machine's OWN changes (`site_id = crsql_site_id()`), never ones it received, ordered by `(db_version, seq)`.
- `applyChanges(db, raws, opts?: { before?(raw) })`: inserts into `crsql_changes` (caller owns the transaction); refuses tables outside `SYNCED_TABLES`; returns `{ entryUlids, revisedUlids }`.
- `entryUlidOf(db, table, pk)`, `reindexFts(db, ulids)` (D15).

- [ ] **Step 1: Write the failing tests.**

```ts
// file: core/test/sync-changes.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { addEntryAsync } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';
import { setAllocator } from '../src/sync/allocator.js';
import { encodeChange, decodeChange, readOwnChanges, applyChanges, reindexFts, type RawChange } from '../src/sync/changes.js';
import { assertFtsIntact } from './helpers/levels.js';

test('the wire codec round-trips every value type', () => {
  const raw: RawChange = { table: 'entries', pk: Buffer.from([1, 11, 3, 97, 98, 99]), cid: 'title', val: 'x', col_version: 2, db_version: 9, site_id: Buffer.alloc(16, 7), cl: 1, seq: 3 };
  for (const val of ['text', 42, -1.5, null, Buffer.from([0, 255])]) {
    const back = decodeChange(JSON.parse(JSON.stringify(encodeChange({ ...raw, val }))));
    assert.deepEqual(back, { ...raw, val });
  }
  assert.throws(() => decodeChange({ table: 'entries' } as any), /malformed change/);
});

test('readOwnChanges never returns rows this machine received', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 5 });
    await addEntryAsync(a.db, { type: 'decision', title: 'from a', summary: 's', module: 'm' });
    const sent = readOwnChanges(a.db, 0);
    assert.ok(sent.length > 0);
    b.db.transaction(() => applyChanges(b.db, sent.map(decodeChange)))();
    assert.deepEqual(readOwnChanges(b.db, 0), []);
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});

test('applyChanges reports affected entries (incl. revisions) and refuses unshared tables', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 6 });
    const { id } = await addEntryAsync(a.db, { type: 'decision', title: 'one', summary: 's', module: 'm', refs: [{ ref_type: 'file', ref_value: 'f.ts' }] });
    updateEntry(a.db, { id, title: 'two' });
    const u = (a.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    const r = b.db.transaction(() => applyChanges(b.db, readOwnChanges(a.db, 0).map(decodeChange)))();
    assert.deepEqual([...r.entryUlids], [u]);
    assert.deepEqual([...r.revisedUlids], [u]);
    const bad = decodeChange({ ...readOwnChanges(a.db, 0)[0], table: 'tasks' });
    assert.throws(() => applyChanges(b.db, [bad]), /not shared/);
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});

test('reindexFts rebuilds the search rows of received entries', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 9 });
    await addEntryAsync(a.db, { type: 'decision', title: 'zebra crossing', summary: 's', module: 'm' });
    b.db.transaction(() => applyChanges(b.db, readOwnChanges(a.db, 0).map(decodeChange)))();
    const u = (b.db.prepare('SELECT ulid FROM entries').get() as { ulid: string }).ulid;
    b.db.prepare('DELETE FROM entries_fts').run(); // simulate a missed index update
    reindexFts(b.db, [u]);
    reindexFts(b.db, [u]); // idempotent
    assert.equal((b.db.prepare(`SELECT COUNT(*) c FROM entries_fts WHERE entries_fts MATCH 'zebra'`).get() as { c: number }).c, 1);
    assertFtsIntact(b.db);
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/sync/changes.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: core/src/sync/changes.ts
import type { DB } from "../db.js";
import { SYNCED_TABLES } from "./enable.js";

// The unit of sharing is one crsql_changes row (spec D2). RawChange is the row
// as SQLite returns it; WireChange is its JSON form for HTTPS (blobs base64).

export interface RawChange {
  table: string; pk: Buffer; cid: string; val: unknown;
  col_version: number; db_version: number; site_id: Buffer; cl: number; seq: number;
}
export type WireVal = null | number | string | { b64: string };
export interface WireChange {
  table: string; pk: string; cid: string; val: WireVal;
  col_version: number; db_version: number; site_id: string; cl: number; seq: number;
}

const COLS = `"table", pk, cid, val, col_version, db_version, site_id, cl, seq`;

function encodeVal(v: unknown): WireVal {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) return { b64: v.toString("base64") };
  throw new Error(`cannot share a value of type ${typeof v}`);
}
function decodeVal(v: WireVal): unknown {
  if (v !== null && typeof v === "object") {
    if (typeof v.b64 !== "string") throw new Error("malformed change: bad blob value");
    return Buffer.from(v.b64, "base64");
  }
  return v;
}

export function encodeChange(r: RawChange): WireChange {
  return {
    table: r.table, pk: r.pk.toString("base64"), cid: r.cid, val: encodeVal(r.val),
    col_version: r.col_version, db_version: r.db_version, site_id: r.site_id.toString("base64"), cl: r.cl, seq: r.seq,
  };
}

const isInt = (x: unknown): x is number => Number.isInteger(x);
export function decodeChange(w: WireChange): RawChange {
  if (
    !w || typeof w.table !== "string" || typeof w.pk !== "string" || typeof w.cid !== "string" ||
    typeof w.site_id !== "string" || !isInt(w.col_version) || !isInt(w.db_version) || !isInt(w.cl) || !isInt(w.seq) ||
    !(w.val === null || ["number", "string", "object"].includes(typeof w.val))
  ) {
    throw new Error("malformed change");
  }
  return {
    table: w.table, pk: Buffer.from(w.pk, "base64"), cid: w.cid, val: decodeVal(w.val),
    col_version: w.col_version, db_version: w.db_version, site_id: Buffer.from(w.site_id, "base64"), cl: w.cl, seq: w.seq,
  };
}

/** This machine's OWN changes after `since` (never ones it received), in commit order. */
export function readOwnChanges(db: DB, since: number): WireChange[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM crsql_changes WHERE site_id = crsql_site_id() AND db_version > ? ORDER BY db_version, seq`)
    .all(since) as RawChange[];
  return rows.map(encodeChange);
}

/** The entry a change belongs to (null for modules rows or an unknown revision). */
export function entryUlidOf(db: DB, table: string, pk: Buffer): string | null {
  const first = db.prepare(`SELECT cell FROM crsql_unpack_columns(?) LIMIT 1`).get(pk) as { cell: unknown } | undefined;
  if (!first) return null;
  switch (table) {
    case "entries":
    case "refs":
    case "entry_modules":
      return String(first.cell);
    case "entry_revisions": {
      const r = db.prepare(`SELECT entry_ulid FROM entry_revisions WHERE rev_id = ?`).get(first.cell) as { entry_ulid: string } | undefined;
      return r?.entry_ulid || null;
    }
    default:
      return null;
  }
}

const SHARED = new Set<string>(SYNCED_TABLES);

/**
 * Apply received changes through cr-sqlite (the caller owns the transaction).
 * Re-applying a change is a no-op. Returns the entries touched, and those that
 * received revision rows (candidates for a merge on the post office).
 */
export function applyChanges(
  db: DB,
  raws: RawChange[],
  opts: { before?: (raw: RawChange) => void } = {},
): { entryUlids: Set<string>; revisedUlids: Set<string> } {
  for (const r of raws) {
    if (!SHARED.has(r.table)) throw new Error(`refusing a change to ${r.table}: it is not shared (notes only, D5)`);
  }
  const ins = db.prepare(`INSERT INTO crsql_changes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of raws) {
    opts.before?.(r);
    ins.run(r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq);
  }
  // Resolve ulids after ALL rows landed: a revision's entry_ulid may arrive after its key.
  const entryUlids = new Set<string>();
  const revisedUlids = new Set<string>();
  for (const r of raws) {
    const u = entryUlidOf(db, r.table, r.pk);
    if (!u) continue;
    entryUlids.add(u);
    if (r.table === "entry_revisions") revisedUlids.add(u);
  }
  return { entryUlids, revisedUlids };
}

/** D15: rebuild the FTS rows of these entries from entries (search must find what arrived). */
export function reindexFts(db: DB, ulids: Iterable<string>): void {
  const del = db.prepare(
    `DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?) AND ulid = ?`,
  );
  const ins = db.prepare(
    `INSERT INTO entries_fts (ulid, title, summary, description) SELECT ulid, title, summary, description FROM entries WHERE ulid = ?`,
  );
  for (const u of ulids) {
    del.run(`ulid:"${u.replace(/"/g, '""')}"`, u);
    ins.run(u);
  }
}
```

Add `export * from './sync/changes.js';` to `core/src/index.ts`.

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-changes.test.ts`. Expected: PASS. Then `npm -w @collab-mcp/core test`: all pass; report the total.

- [ ] **Step 5: Commit** `feat(core): change codec, own-change reader, apply + FTS re-index (sync v1 plan 2)`

---
### Task 7: The post office package and its store

**Files:**
- Create: `post-office/package.json`, `post-office/tsconfig.json`, `post-office/src/store.ts`, `post-office/src/index.ts`, `post-office/test/helpers.ts`, `post-office/test/store.test.ts`
- Modify: root `package.json` (`workspaces` += `"post-office"`), `.gitignore` (`*.pem`, `post-office-data/`)

**Interfaces produced:** `Store`, `StoreError(message, status)`, `createStore(path, {seedMaxId})`, `openStore(path)`, `closeStore(db)`, `getMeta/setMeta`, `allocate(db, ulid, deviceId)`, `nextNumber(db)`, `addMember(db, name, {ttlHours})`, `redeemJoin(db, device, secret)`, `authenticate(db, authorizationHeader)`, `isRevoked(db, device)`, `revokeMember(db, deviceOrName)`, `listMembers(db)`, `teamStatus(db)`, `sharedModules(db)`, `setModuleShared(db, slug, shared)`.

Store layout: ONE file. The notes schema (0007, `enableSync`) holds every shared row as a cr-sqlite replica; the `po_*` tables are local to the post office (never CRRs). One file means "accept a batch" is one transaction.

- [ ] **Step 1: Package scaffold.**

```json
// file: post-office/package.json
{
  "name": "@collab-mcp/post-office",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Sync v1 post office: E-numbers, the shared change log, merges, membership and the doorbell (HTTPS + SSE).",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "bin": { "collab-post-office": "./dist/bin.js" },
  "scripts": {
    "build": "tsc",
    "pretest": "npm --prefix ../core run build",
    "test": "tsx --test test/**/*.test.ts",
    "start": "tsx src/bin.ts serve"
  },
  "dependencies": {
    "@collab-mcp/core": "*",
    "better-sqlite3": "^11.3.0",
    "node-diff3": "^3.2.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "~5.3.3"
  },
  "engines": { "node": ">=20.9.0" }
}
```

(JSON has no comments: drop the `// file:` line when creating it.)

```json
// file: post-office/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "declaration": true, "rootDir": "src", "types": ["node"] },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Root `package.json`: add `"post-office"` to `workspaces` (after `"core"`). Run `npm install` (or `npm install --force` on EBADPLATFORM) so the workspace links and node-diff3 lands in `package-lock.json`. `.gitignore`, under "Secrets": add `*.pem` and `post-office-data/`.

The tests import `@collab-mcp/core`, which resolves to `core/dist`: `pretest` builds it. Never import core by relative path from this package: two copies of core in one process would mean two allocator registries.

- [ ] **Step 2: Write the failing tests.**

```ts
// file: post-office/test/helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, enableSync, isCrsqliteLoaded } from '@collab-mcp/core';
import { createStore, closeStore, type Store } from '../src/store.js';

export function tempDir(prefix = 'collab-po-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempStore(seedMaxId = 0): { store: Store; path: string; cleanup: () => void } {
  const t = tempDir();
  const path = join(t.dir, 'store.db');
  const store = createStore(path, { seedMaxId });
  return { store, path, cleanup: () => { try { closeStore(store); } catch { /* closed */ } t.cleanup(); } };
}

/** A simulated laptop's notes DB: 0007 + sharing on. */
export function laptop(): { db: Database.Database; path: string; cleanup: () => void } {
  const t = tempDir('collab-laptop-');
  const path = join(t.dir, 'collab.db');
  const db = new Database(path);
  migrateTo(db, '0007', { includeStaged: true });
  enableSync(db);
  return {
    db, path,
    cleanup: () => {
      try { if (isCrsqliteLoaded(db)) db.prepare('SELECT crsql_finalize()').get(); db.close(); } catch { /* closed */ }
      t.cleanup();
    },
  };
}
```

```ts
// file: post-office/test/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import {
  openStore, closeStore, allocate, nextNumber, addMember, redeemJoin, authenticate, revokeMember,
  teamStatus, setModuleShared, sharedModules, StoreError,
} from '../src/store.js';

test('the counter starts at the seed; a repeated ulid gets the same number', () => {
  const { store, cleanup } = tempStore(811);
  try {
    const u1 = newUlid(), u2 = newUlid();
    assert.equal(nextNumber(store), 812);
    assert.equal(allocate(store, u1, 'd-a'), 812);
    assert.equal(allocate(store, u2, 'd-b'), 813);
    assert.equal(allocate(store, u1, 'd-a'), 812, 'idempotent by ulid (E-713)');
    assert.equal(nextNumber(store), 814);
    assert.throws(() => allocate(store, 'not-a-ulid', 'd-a'), StoreError);
  } finally { cleanup(); }
});

test('the increment and the record commit together (a failed record leaves the counter alone)', () => {
  const { store, cleanup } = tempStore(10);
  try {
    store.prepare(`INSERT INTO po_allocations (ulid, id, device_id) VALUES (?, 11, 'x')`).run(newUlid()); // id 11 taken behind its back
    assert.throws(() => allocate(store, newUlid(), 'd'), /UNIQUE/);
    assert.equal(nextNumber(store), 11, 'counter unchanged');
  } finally { cleanup(); }
});

test('allocations are unique on ulid and on id', () => {
  const { store, cleanup } = tempStore();
  try {
    const idx = store.prepare(`SELECT sql FROM sqlite_master WHERE name = 'po_allocations'`).get() as { sql: string };
    assert.match(idx.sql, /ulid\s+TEXT\s+NOT NULL\s+PRIMARY KEY/i);
    assert.match(idx.sql, /id\s+INTEGER\s+NOT NULL\s+UNIQUE/i);
  } finally { cleanup(); }
});

test('reopening keeps the counter and loads cr-sqlite', () => {
  const { store, path, cleanup } = tempStore(5);
  try {
    allocate(store, newUlid(), 'd');
    closeStore(store);
    const again = openStore(path);
    try {
      assert.equal(nextNumber(again), 7);
      assert.ok(again.prepare('SELECT crsql_db_version() v').get());
    } finally { closeStore(again); }
  } finally { cleanup(); }
});

test('join codes are one-time; keys authenticate until revoked', () => {
  const { store, cleanup } = tempStore();
  try {
    const { deviceId, secret } = addMember(store, 'second laptop');
    assert.throws(() => redeemJoin(store, deviceId, 'wrong'), (e: any) => e instanceof StoreError && e.status === 403);
    const { key } = redeemJoin(store, deviceId, secret);
    assert.throws(() => redeemJoin(store, deviceId, secret), /not valid/);
    assert.equal(authenticate(store, `Bearer ${deviceId}:${key}`)?.name, 'second laptop');
    assert.equal(authenticate(store, `Bearer ${deviceId}:nope`), null);
    assert.equal(authenticate(store, undefined), null);
    revokeMember(store, 'second laptop');
    assert.equal(authenticate(store, `Bearer ${deviceId}:${key}`), null, 'revoked = locked out at once');
  } finally { cleanup(); }
});

test('an expired join code is refused', () => {
  const { store, cleanup } = tempStore();
  try {
    const { deviceId, secret } = addMember(store, 'late', { ttlHours: -1 });
    assert.throws(() => redeemJoin(store, deviceId, secret), /expired/);
  } finally { cleanup(); }
});

test('team status: waiting / up to date / behind / revoked', () => {
  const { store, cleanup } = tempStore();
  try {
    const a = addMember(store, 'main');
    addMember(store, 'pending');
    redeemJoin(store, a.deviceId, a.secret);
    store.prepare(`INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq) VALUES ('other', 'entries', x'01', 'title', 't', 1, 1, x'02', 1, 0)`).run();
    let rows = teamStatus(store);
    assert.deepEqual(rows.map((r) => [r.name, r.state, r.behind]), [['main', 'behind', 1], ['pending', 'waiting to join', 0]]);
    store.prepare(`UPDATE po_members SET receive_bookmark = 1 WHERE device_id = ?`).run(a.deviceId);
    revokeMember(store, 'pending');
    rows = teamStatus(store);
    assert.deepEqual(rows.map((r) => [r.name, r.state]), [['main', 'up to date'], ['pending', 'revoked']]);
  } finally { cleanup(); }
});

test('shared modules: opt-in per module, slugs validated', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.deepEqual(sharedModules(store), []);
    assert.deepEqual(setModuleShared(store, 'sync', true), ['sync']);
    assert.deepEqual(setModuleShared(store, 'api', true), ['api', 'sync']);
    assert.deepEqual(setModuleShared(store, 'sync', false), ['api']);
    assert.throws(() => setModuleShared(store, 'Bad Slug', true), StoreError);
  } finally { cleanup(); }
});
```

- [ ] **Step 3: Run and confirm it fails.** Run: `npm -w @collab-mcp/post-office test`. Expected: FAIL, `Cannot find module '../src/store.js'`.

- [ ] **Step 4: Implement.**

```ts
// file: post-office/src/store.ts
import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { migrateTo, enableSync, loadCrsqlite, isCrsqliteLoaded, SLUG_REGEX } from "@collab-mcp/core";

// The post office's ONE SQLite file (D14). The notes schema (0007 + CRRs) is a
// replica of every shared row; the po_* tables are the office's own and never
// replicate. Every connection loads cr-sqlite (the notes tables are CRRs).
export type Store = Database.Database;

export class StoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "StoreError";
  }
}

const PO_SCHEMA = `
CREATE TABLE IF NOT EXISTS po_meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS po_members (
  device_id        TEXT NOT NULL PRIMARY KEY,
  name             TEXT NOT NULL,
  join_hash        TEXT,
  join_expires_at  TEXT,
  key_hash         TEXT,
  joined_at        TEXT,
  revoked_at       TEXT,
  last_seen_at     TEXT,
  receive_bookmark INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS po_allocations (
  ulid       TEXT    NOT NULL PRIMARY KEY,
  id         INTEGER NOT NULL UNIQUE,
  device_id  TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- One row per accepted change, in global order (spec: deliveries #1, #2, ...).
-- val has NO declared type on purpose: any affinity would coerce values.
CREATE TABLE IF NOT EXISTS po_deliveries (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  origin      TEXT    NOT NULL,
  tbl         TEXT    NOT NULL,
  pk          BLOB    NOT NULL,
  cid         TEXT    NOT NULL,
  val,
  col_version INTEGER NOT NULL,
  db_version  INTEGER NOT NULL,
  site_id     BLOB    NOT NULL,
  cl          INTEGER NOT NULL,
  ch_seq      INTEGER NOT NULL,
  received_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, db_version, ch_seq, tbl, pk, cid)
);
CREATE TABLE IF NOT EXISTS po_shared_modules (
  slug      TEXT NOT NULL PRIMARY KEY,
  shared_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function tune(db: Store): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

export function getMeta(db: Store, key: string): string | null {
  const r = db.prepare(`SELECT value FROM po_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setMeta(db: Store, key: string, value: string): void {
  db.prepare(`INSERT INTO po_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** New store. The counter starts at `seedMaxId`: the main laptop's current max(id) (spec Components 3). */
export function createStore(path: string, opts: { seedMaxId: number }): Store {
  if (existsSync(path)) throw new StoreError(`a post office store already exists at ${path}`);
  if (!Number.isInteger(opts.seedMaxId) || opts.seedMaxId < 0) throw new StoreError("the seed must be a whole number >= 0");
  const db = new Database(path);
  tune(db);
  migrateTo(db, "0007", { includeStaged: true });
  enableSync(db);
  db.exec(PO_SCHEMA);
  const v = (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
  setMeta(db, "counter", String(opts.seedMaxId));
  // The office's own writes (merges, flags) are delivered from here on; rows
  // the migrations created are not news to anyone.
  setMeta(db, "self_db_version", String(v));
  setMeta(db, "created_at", new Date().toISOString());
  return db;
}

export function openStore(path: string): Store {
  if (!existsSync(path)) throw new StoreError(`no post office store at ${path}; run \`collab-post-office init\` first`, 500);
  const db = new Database(path);
  tune(db);
  loadCrsqlite(db);
  db.exec(PO_SCHEMA);
  return db;
}

export function closeStore(db: Store): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) {
    try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  }
  db.close();
}

// ---------------------------------------------------------------- numbers
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The number the next NEW ulid will get. */
export function nextNumber(db: Store): number {
  return Number(getMeta(db, "counter") ?? 0) + 1;
}

/**
 * E-number for `ulid` (D7). Idempotent by ulid: a retried request gets the same
 * number (E-713). The increment and the record commit in ONE transaction, so a
 * number is never handed out twice and never silently skipped by a failure.
 */
export function allocate(db: Store, ulid: unknown, deviceId: string | null): number {
  if (typeof ulid !== "string" || !ULID_RE.test(ulid)) throw new StoreError(`not a ULID: ${String(ulid).slice(0, 40)}`);
  return db.transaction(() => {
    const hit = db.prepare(`SELECT id FROM po_allocations WHERE ulid = ?`).get(ulid) as { id: number } | undefined;
    if (hit) return hit.id;
    const id = nextNumber(db);
    setMeta(db, "counter", String(id));
    db.prepare(`INSERT INTO po_allocations (ulid, id, device_id) VALUES (?, ?, ?)`).run(ulid, id, deviceId);
    return id;
  }).immediate();
}

// ---------------------------------------------------------------- members
export interface Member {
  device_id: string;
  name: string;
  joined_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  receive_bookmark: number;
}
export const JOIN_TTL_HOURS = 168; // a join code is valid for 7 days

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function sameHash(storedHex: string, candidate: string): boolean {
  const a = Buffer.from(storedHex, "hex");
  const b = Buffer.from(sha256(candidate), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const MEMBER_COLS = `device_id, name, joined_at, revoked_at, last_seen_at, receive_bookmark`;

/** Pre-register a device and mint its one-time join secret (only its hash is stored). */
export function addMember(db: Store, name: string, opts: { ttlHours?: number } = {}): { deviceId: string; secret: string } {
  const n = String(name ?? "").trim();
  if (!n) throw new StoreError("a member needs a name");
  const deviceId = "d-" + randomBytes(5).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const ttl = opts.ttlHours ?? JOIN_TTL_HOURS;
  db.prepare(
    `INSERT INTO po_members (device_id, name, join_hash, join_expires_at) VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(deviceId, n, sha256(secret), `${ttl >= 0 ? "+" : ""}${ttl} hours`);
  return { deviceId, secret };
}

/** Trade a one-time join secret for the device's key (D12). Only the key's hash is kept. */
export function redeemJoin(db: Store, deviceId: string, secret: string): { key: string } {
  return db.transaction(() => {
    const m = db
      .prepare(`SELECT join_hash, join_expires_at < datetime('now') AS expired, revoked_at FROM po_members WHERE device_id = ?`)
      .get(deviceId) as { join_hash: string | null; expired: number; revoked_at: string | null } | undefined;
    if (!m || !m.join_hash || m.revoked_at || !sameHash(m.join_hash, String(secret))) {
      throw new StoreError("this join code is not valid (already used, revoked, or never issued)", 403);
    }
    if (m.expired) throw new StoreError("this join code has expired; ask for a new one", 403);
    const key = randomBytes(32).toString("base64url");
    db.prepare(
      `UPDATE po_members SET key_hash = ?, join_hash = NULL, join_expires_at = NULL,
              joined_at = datetime('now'), last_seen_at = datetime('now') WHERE device_id = ?`,
    ).run(sha256(key), deviceId);
    return { key };
  }).immediate();
}

/** `Authorization: Bearer <device>:<key>` -> the member, or null (unknown, wrong key, or revoked). */
export function authenticate(db: Store, header: string | undefined): Member | null {
  const m = /^Bearer ([^:\s]+):(\S+)$/.exec(header ?? "");
  if (!m) return null;
  const row = db.prepare(`SELECT ${MEMBER_COLS}, key_hash FROM po_members WHERE device_id = ?`).get(m[1]) as
    | (Member & { key_hash: string | null })
    | undefined;
  if (!row || row.revoked_at || !row.key_hash || !sameHash(row.key_hash, m[2])) return null;
  db.prepare(`UPDATE po_members SET last_seen_at = datetime('now') WHERE device_id = ?`).run(row.device_id);
  const { key_hash: _kh, ...member } = row;
  return member;
}

export function isRevoked(db: Store, deviceId: string): boolean {
  const r = db.prepare(`SELECT revoked_at FROM po_members WHERE device_id = ?`).get(deviceId) as { revoked_at: string | null } | undefined;
  return !r || r.revoked_at !== null;
}

export function listMembers(db: Store): Member[] {
  return db.prepare(`SELECT ${MEMBER_COLS} FROM po_members ORDER BY created_at, device_id`).all() as Member[];
}

/** Revoke by device id or by name (a name must be unambiguous). Effective on the next request (D12). */
export function revokeMember(db: Store, who: string): Member {
  const rows = db.prepare(`SELECT ${MEMBER_COLS} FROM po_members WHERE device_id = ? OR name = ?`).all(who, who) as Member[];
  if (rows.length === 0) throw new StoreError(`no member called ${who}`, 404);
  if (rows.length > 1) throw new StoreError(`${rows.length} members are called ${who}; revoke by device id: ${rows.map((r) => r.device_id).join(", ")}`);
  db.prepare(`UPDATE po_members SET revoked_at = COALESCE(revoked_at, datetime('now')), join_hash = NULL WHERE device_id = ?`).run(rows[0].device_id);
  return { ...rows[0], revoked_at: rows[0].revoked_at ?? "now" };
}

export interface StatusRow {
  device_id: string;
  name: string;
  state: "waiting to join" | "revoked" | "up to date" | "behind";
  behind: number;
  last_seen_at: string | null;
}

/** "Team status" (D12): who is up to date, behind, or not seen lately. */
export function teamStatus(db: Store): StatusRow[] {
  const behindQ = db.prepare(`SELECT COUNT(*) c FROM po_deliveries WHERE seq > ? AND origin <> ?`);
  return listMembers(db).map((m) => {
    if (m.revoked_at) return { device_id: m.device_id, name: m.name, state: "revoked", behind: 0, last_seen_at: m.last_seen_at };
    if (!m.joined_at) return { device_id: m.device_id, name: m.name, state: "waiting to join", behind: 0, last_seen_at: null };
    const behind = (behindQ.get(m.receive_bookmark, m.device_id) as { c: number }).c;
    return { device_id: m.device_id, name: m.name, state: behind === 0 ? "up to date" : "behind", behind, last_seen_at: m.last_seen_at };
  });
}

// ---------------------------------------------------------------- shared modules (D10)
export function sharedModules(db: Store): string[] {
  return (db.prepare(`SELECT slug FROM po_shared_modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
}

/** Opt a module in or out for the whole team. Un-sharing stops future sends only. */
export function setModuleShared(db: Store, slug: string, shared: boolean): string[] {
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) throw new StoreError(`not a module slug: ${String(slug)}`);
  if (shared) db.prepare(`INSERT OR IGNORE INTO po_shared_modules (slug) VALUES (?)`).run(slug);
  else db.prepare(`DELETE FROM po_shared_modules WHERE slug = ?`).run(slug);
  return sharedModules(db);
}
```

```ts
// file: post-office/src/index.ts
export * from "./store.js";
```

(Later tasks append their modules to `index.ts`.)

- [ ] **Step 5: Run and confirm it passes.** Run: `npm -w @collab-mcp/post-office test`. Expected: PASS (8 tests).

- [ ] **Step 6: Commit** `feat(post-office): package + store: counter, allocations, members, keys, shared modules (sync v1 plan 2)`

---

### Task 8: Deliveries: accept and fetch

**Files:**
- Create: `post-office/src/deliveries.ts`, `post-office/test/deliveries.test.ts`
- Modify: `post-office/src/index.ts`

**Interfaces produced:** `acceptChanges(db, origin, wire) → { accepted, duplicates, lastSeq, officeWrote }`, `fetchDeliveries(db, deviceId, after, limit) → { changes, lastSeq, more }`, `lastSeq(db)`, `OFFICE_ORIGIN = "post-office"`.

`acceptChanges` is ONE immediate transaction: record each change in `po_deliveries` (`INSERT OR IGNORE` on its cr-sqlite identity ⇒ a resend is a no-op), apply the NEW ones through `crsql_changes`, run the merge for entries that received revisions (Task 9 fills `merge.ts`; this task uses a no-op stub), then record the office's own new changes (merges, flags) as deliveries from `post-office`.

`fetchDeliveries` returns deliveries after `after`, minus the caller's own, and records `after` as the member's confirmed receive-bookmark (the courier asks for "after N" only once it has applied N).

- [ ] **Step 1: Write the failing tests.**

```ts
// file: post-office/test/deliveries.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, setAllocator, readOwnChanges, applyChanges, decodeChange } from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries, lastSeq } from '../src/deliveries.js';

test('accepted changes land in the store in order; a resend is a no-op', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop();
  try {
    setAllocator({ allocate: async () => 1 });
    await addEntryAsync(a.db, { type: 'decision', title: 'hello', summary: 's', module: 'm' });
    const sent = readOwnChanges(a.db, 0);
    const r1 = acceptChanges(store, 'd-a', sent);
    assert.equal(r1.accepted, sent.length);
    assert.equal(r1.duplicates, 0);
    assert.equal(r1.lastSeq, sent.length);
    assert.equal((store.prepare(`SELECT title FROM entries WHERE id = 1`).get() as { title: string }).title, 'hello');
    const r2 = acceptChanges(store, 'd-a', sent);
    assert.deepEqual([r2.accepted, r2.duplicates, r2.lastSeq], [0, sent.length, sent.length]);
  } finally { setAllocator(null); a.cleanup(); cleanup(); }
});

test('fetch: everything after the bookmark except the caller\'s own; the bookmark is recorded', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop(), b = laptop();
  try {
    store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES ('d-b', 'b', datetime('now'))`).run();
    setAllocator({ allocate: async () => 2 });
    await addEntryAsync(a.db, { type: 'decision', title: 'for b', summary: 's', module: 'm' });
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    assert.deepEqual(fetchDeliveries(store, 'd-a', 0, 100).changes, [], 'never your own changes back');
    const page = fetchDeliveries(store, 'd-b', 0, 5);
    assert.equal(page.changes.length, 5);
    assert.equal(page.more, true);
    const rest = fetchDeliveries(store, 'd-b', page.lastSeq, 1000);
    assert.equal(rest.more, false);
    b.db.transaction(() => applyChanges(b.db, [...page.changes, ...rest.changes].map(decodeChange)))();
    assert.equal((b.db.prepare(`SELECT title FROM entries WHERE id = 2`).get() as { title: string }).title, 'for b');
    fetchDeliveries(store, 'd-b', rest.lastSeq, 1000);
    assert.equal((store.prepare(`SELECT receive_bookmark r FROM po_members WHERE device_id = 'd-b'`).get() as { r: number }).r, lastSeq(store));
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); cleanup(); }
});

test('a batch with an unshared table is refused whole', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop();
  try {
    setAllocator({ allocate: async () => 3 });
    await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', module: 'm' });
    const sent = readOwnChanges(a.db, 0);
    assert.throws(() => acceptChanges(store, 'd-a', [...sent, { ...sent[0], table: 'tasks' }]), /not shared/);
    assert.equal(lastSeq(store), 0);
    assert.throws(() => acceptChanges(store, 'd-a', [{ junk: 1 } as any]), /malformed/);
  } finally { setAllocator(null); a.cleanup(); cleanup(); }
});

test('rows the store\'s own migrations created are never delivered', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(lastSeq(store), 0);
    assert.deepEqual(fetchDeliveries(store, 'd-x', 0, 100).changes, []);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/deliveries.js'`.

- [ ] **Step 3: Implement.** First a stub `merge.ts` (Task 9 replaces it):

```ts
// file: post-office/src/merge.ts
// Replaced in Task 9 (three-way merge, divergence, needs_merge).
import type { RawChange } from "@collab-mcp/core";
import type { Store } from "./store.js";
export function divergentStatusOrType(_db: Store, _raw: RawChange): string | null { return null; }
export function flagNeedsMerge(_db: Store, _ulid: string): void {}
export function mergeEntries(_db: Store, _ulids: Iterable<string>): void {}
```

```ts
// file: post-office/src/deliveries.ts
import { decodeChange, encodeChange, applyChanges, type RawChange, type WireChange } from "@collab-mcp/core";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { divergentStatusOrType, flagNeedsMerge, mergeEntries } from "./merge.js";

export const OFFICE_ORIGIN = "post-office";

const RECORD = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function lastSeq(db: Store): number {
  return (db.prepare(`SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries`).get() as { s: number }).s;
}

/** The office's own new writes (merges, needs_merge flags) become deliveries too. */
function recordOwnChanges(db: Store): number {
  const since = Number(getMeta(db, "self_db_version") ?? 0);
  const own = db
    .prepare(
      `SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes
        WHERE site_id = crsql_site_id() AND db_version > ? ORDER BY db_version, seq`,
    )
    .all(since) as RawChange[];
  const rec = db.prepare(RECORD);
  let n = 0;
  let top = since;
  for (const r of own) {
    n += rec.run(OFFICE_ORIGIN, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq).changes;
    top = Math.max(top, r.db_version);
  }
  setMeta(db, "self_db_version", String(top));
  return n;
}

export interface AcceptResult { accepted: number; duplicates: number; lastSeq: number; officeWrote: boolean }

/**
 * One batch from one member, in ONE transaction: record (de-duplicated by the
 * change's cr-sqlite identity), apply, merge forked edits, flag diverging
 * status/type, record the office's own writes. A resend changes nothing.
 */
export function acceptChanges(db: Store, origin: string, wire: WireChange[]): AcceptResult {
  if (!Array.isArray(wire)) throw new StoreError("changes must be a list");
  let raws: RawChange[];
  try {
    raws = wire.map(decodeChange);
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  return db.transaction(() => {
    const rec = db.prepare(RECORD);
    const fresh: RawChange[] = [];
    for (const r of raws) {
      if (rec.run(origin, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq).changes === 1) fresh.push(r);
    }
    const diverged = new Set<string>();
    let applied: ReturnType<typeof applyChanges>;
    try {
      applied = applyChanges(db, fresh, {
        before: (r) => {
          const u = divergentStatusOrType(db, r);
          if (u) diverged.add(u);
        },
      });
    } catch (e) {
      throw new StoreError((e as Error).message);
    }
    mergeEntries(db, applied.revisedUlids);
    for (const u of diverged) flagNeedsMerge(db, u);
    const officeWrote = recordOwnChanges(db) > 0;
    return { accepted: fresh.length, duplicates: raws.length - fresh.length, lastSeq: lastSeq(db), officeWrote };
  }).immediate();
}

export interface FetchResult { changes: WireChange[]; lastSeq: number; more: boolean }

/** Deliveries after `after` except the caller's own. `after` = what the caller has applied (its bookmark). */
export function fetchDeliveries(db: Store, deviceId: string, after: number, limit = 2000): FetchResult {
  if (!Number.isInteger(after) || after < 0) throw new StoreError("after must be a whole number >= 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError("limit must be 1..5000");
  const rows = db
    .prepare(
      `SELECT seq, origin, tbl AS "table", pk, cid, val, col_version, db_version, site_id, cl, ch_seq AS ch
         FROM po_deliveries WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(after, limit) as Array<RawChange & { seq: number; origin: string; ch: number }>;
  db.prepare(`UPDATE po_members SET receive_bookmark = MAX(receive_bookmark, ?) WHERE device_id = ?`).run(after, deviceId);
  const changes = rows
    .filter((r) => r.origin !== deviceId)
    .map((r) => encodeChange({ ...r, seq: r.ch }));
  return { changes, lastSeq: rows.length ? rows[rows.length - 1].seq : after, more: rows.length === limit };
}
```

`index.ts`: add `export * from "./deliveries.js"; export * from "./merge.js";`.

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/post-office test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(post-office): deliveries: accept (dedupe, apply, self-record) and fetch (sync v1 plan 2)`

---
### Task 9: Merge on the post office (D8)

**Files:**
- Replace: `post-office/src/merge.ts`
- Create: `post-office/test/merge.test.ts`
- Modify: `core/src/ops/update.ts` (`resolveNeedsMerge`)

**Interfaces produced:** `mergeText(base, a, b, multiline)`, `commonAncestor(revs, x, y)`, `mergeEntry(db, ulid) → "single" | "merged" | "needs_merge"`, `mergeEntries(db, ulids)`, `divergentStatusOrType(db, raw)`, `flagNeedsMerge(db, ulid)`; core `resolveNeedsMerge(db, id)`.

Rules (spec D8; last-writer-wins for text is withdrawn):
- Two or more heads (revisions nothing builds on) = a fork. For each pair: base = their newest common ancestor (parents AND `merged_from` count). `title`/`summary` are one line: equal, or only one side changed ⇒ that side; both changed differently ⇒ conflict. `description` goes through node-diff3 line merge. Clean ⇒ insert a merged revision (parent = left head, `merged_from` = right head) and, if the store's entry text differs from the result, write it: that write has the highest column version, so cr-sqlite carries it everywhere. Edits to DIFFERENT columns already converge by cr-sqlite's per-column replication; the office then has nothing to write.
- Conflict ⇒ `needs_merge = 1` (replicated). While flagged, the office does not merge that entry again; a person's next edit (or `resolveNeedsMerge`) folds every head in and clears the flag (Task 1's `finishRevision`).
- `status`/`type` are fixed-choice columns without revisions. An incoming change whose column version is ≤ the store's for that column AND whose value differs = two machines changed it independently ⇒ `needs_merge`. Known limit: if one side changed it MORE times than the other, its higher version looks causally later and wins without a flag (cr-sqlite keeps no vector clock per column). Recorded as a residual risk.
- The divergence check reads cr-sqlite 0.16.3's own clock tables (`entries__crsql_pks`, `entries__crsql_clock`), because filtering the `crsql_changes` virtual table by pk scans it: too slow for a first upload of ~14k rows. The cr-sqlite version is pinned; Task 9's tests break loudly if those tables change.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: post-office/test/merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, updateEntry, resolveNeedsMerge, readOwnChanges, applyChanges, decodeChange,
  reindexFts, revisionsOf, headsOf,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import { mergeText } from '../src/merge.js';
import type { Store } from '../src/store.js';

/** A simulated machine: push = send all own changes (resends are no-ops); pull = fetch + apply after its bookmark. */
function machine(dev: string) {
  const h = laptop();
  let recv = 0;
  return {
    ...h, dev,
    push: (store: Store) => acceptChanges(store, dev, readOwnChanges(h.db, 0)),
    pull: (store: Store) => {
      for (;;) {
        const r = fetchDeliveries(store, dev, recv, 1000);
        if (r.changes.length) h.db.transaction(() => reindexFts(h.db, applyChanges(h.db, r.changes.map(decodeChange)).entryUlids))();
        recv = r.lastSeq;
        if (!r.more) break;
      }
    },
  };
}
const row = (db: any, id: number) => db.prepare('SELECT ulid, title, description, status, needs_merge FROM entries WHERE id = ?').get(id) as any;

async function forkedPair(description: string) {
  const s = tempStore();
  const a = machine('d-a'), b = machine('d-b');
  setAllocator({ allocate: async () => 10 });
  const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', description, module: 'm' });
  a.push(s.store); b.pull(s.store);
  return { s, a, b, id, done: () => { setAllocator(null); a.cleanup(); b.cleanup(); s.cleanup(); } };
}

test('mergeText: one side, both same, clean lines, conflicts', () => {
  assert.deepEqual(mergeText('x', 'x', 'y', false), { ok: true, value: 'y' });
  assert.deepEqual(mergeText('x', 'z', 'z', false), { ok: true, value: 'z' });
  assert.deepEqual(mergeText('x', 'y', 'z', false), { ok: false });
  assert.deepEqual(mergeText('p1\n\np2', 'P1\n\np2', 'p1\n\nP2', true), { ok: true, value: 'P1\n\nP2' });
  assert.deepEqual(mergeText('p1\n\np2', 'X\n\np2', 'Y\n\np2', true), { ok: false });
});

test('edits to different paragraphs on two machines: merged, and the merge reaches both', async () => {
  const { s, a, b, id, done } = await forkedPair('p1\n\np2');
  try {
    updateEntry(a.db, { id, description: 'P1 from a\n\np2' });
    updateEntry(b.db, { id, description: 'p1\n\nP2 from b' });
    a.push(s.store);
    const r = b.push(s.store);
    assert.equal(r.officeWrote, true, 'the office wrote a merged revision');
    assert.equal(row(s.store, id).description, 'P1 from a\n\nP2 from b');
    a.pull(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) {
      assert.equal(row(db, id).description, 'P1 from a\n\nP2 from b');
      assert.equal(row(db, id).needs_merge, 0);
      assert.equal(headsOf(revisionsOf(db, row(db, id).ulid)).length, 1);
    }
  } finally { done(); }
});

test('edits to the same line: needs_merge everywhere, both texts kept as revisions; a person resolves it', async () => {
  const { s, a, b, id, done } = await forkedPair('line one\n\nline two');
  try {
    updateEntry(a.db, { id, description: 'line ONE (a)\n\nline two' });
    updateEntry(b.db, { id, description: 'line ONE (b)\n\nline two' });
    a.push(s.store); b.push(s.store);
    a.pull(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) assert.equal(row(db, id).needs_merge, 1);
    const texts = revisionsOf(s.store, row(s.store, id).ulid).map((r) => r.description);
    assert.ok(texts.includes('line ONE (a)\n\nline two') && texts.includes('line ONE (b)\n\nline two'), 'nothing is lost');
    updateEntry(a.db, { id, description: 'line ONE (both)\n\nline two' });
    a.push(s.store); b.pull(s.store);
    for (const db of [a.db, b.db, s.store]) {
      assert.equal(row(db, id).needs_merge, 0);
      assert.equal(row(db, id).description, 'line ONE (both)\n\nline two');
      assert.equal(headsOf(revisionsOf(db, row(db, id).ulid)).length, 1);
    }
  } finally { done(); }
});

test('resolveNeedsMerge keeps the current text and clears the flag', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    updateEntry(a.db, { id, title: 'A' });
    updateEntry(b.db, { id, title: 'B' });
    a.push(s.store); b.push(s.store); a.pull(s.store);
    assert.equal(row(a.db, id).needs_merge, 1);
    resolveNeedsMerge(a.db, id);
    a.push(s.store);
    assert.equal(row(s.store, id).needs_merge, 0);
    assert.throws(() => resolveNeedsMerge(a.db, id), /not waiting/);
  } finally { done(); }
});

test('status changed differently on two machines: needs_merge', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    a.db.prepare(`UPDATE entries SET status = 'resolved' WHERE id = ?`).run(id);
    b.db.prepare(`UPDATE entries SET status = 'deprecated' WHERE id = ?`).run(id);
    a.push(s.store); b.push(s.store);
    assert.equal(row(s.store, id).needs_merge, 1);
  } finally { done(); }
});

test('edits one after the other are not a conflict', async () => {
  const { s, a, b, id, done } = await forkedPair('x');
  try {
    updateEntry(a.db, { id, description: 'y' });
    a.db.prepare(`UPDATE entries SET status = 'resolved' WHERE id = ?`).run(id);
    a.push(s.store); b.pull(s.store);
    updateEntry(b.db, { id, description: 'z' });
    b.db.prepare(`UPDATE entries SET status = 'active' WHERE id = ?`).run(id);
    const r = b.push(s.store);
    assert.equal(r.officeWrote, false);
    assert.deepEqual([row(s.store, id).description, row(s.store, id).status, row(s.store, id).needs_merge], ['z', 'active', 0]);
  } finally { done(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL (`mergeText` is not exported by the stub; `resolveNeedsMerge` is not exported by core).

- [ ] **Step 3: Implement.** Core: in `core/src/ops/update.ts` add

```ts
/**
 * Spec D8: a person settles a needs_merge note while keeping its current text
 * (to change the text, just edit it: any edit settles it). Folds every pending
 * head into one revision and clears the flag; replicates like any edit.
 */
export function resolveNeedsMerge(db: DB, id: number): { id: number } {
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  db.transaction(() => {
    const before = snapshotForRevision(db, owner.ulid as string);
    if (!before || before.needs_merge !== 1) throw new Error(`E-${id} is not waiting for a merge`);
    finishRevision(db, before);
  })();
  return { id };
}
```

Post office:

```ts
// file: post-office/src/merge.ts
import { randomBytes } from "node:crypto";
import { merge as diff3 } from "node-diff3";
import { revisionsOf, headsOf, splitMerged, estimateTokens, type RawChange, type RevisionRow } from "@collab-mcp/core";
import type { Store } from "./store.js";

// Spec D8: the post office alone merges. Text is never last-writer-wins.

export type FieldMerge = { ok: true; value: string | null } | { ok: false };

export function mergeText(base: string | null, a: string | null, b: string | null, multiline: boolean): FieldMerge {
  if (a === b) return { ok: true, value: a };
  if (a === base) return { ok: true, value: b };
  if (b === base) return { ok: true, value: a };
  if (!multiline) return { ok: false };
  const r = diff3((a ?? "").split("\n"), (base ?? "").split("\n"), (b ?? "").split("\n"));
  return r.conflict ? { ok: false } : { ok: true, value: r.result.join("\n") };
}

/** Newest revision that both x and y descend from (parents and merged_from both count). */
export function commonAncestor(revs: RevisionRow[], x: string, y: string): RevisionRow | null {
  const byId = new Map(revs.map((r) => [r.rev_id, r]));
  const ancestors = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = byId.get(id);
      if (!r) continue;
      if (r.parent_rev_id) stack.push(r.parent_rev_id);
      stack.push(...splitMerged(r.merged_from));
    }
    return seen;
  };
  const ax = ancestors(x);
  const ay = ancestors(y);
  let best: RevisionRow | null = null;
  for (const id of ax) {
    if (!ay.has(id)) continue;
    const r = byId.get(id);
    if (r && (!best || r.created_at > best.created_at || (r.created_at === best.created_at && r.rev_id > best.rev_id))) best = r;
  }
  return best;
}

export function flagNeedsMerge(db: Store, ulid: string): void {
  db.prepare(`UPDATE entries SET needs_merge = 1 WHERE ulid = ? AND needs_merge = 0`).run(ulid);
}

export type MergeOutcome = "single" | "merged" | "needs_merge";

export function mergeEntry(db: Store, ulid: string): MergeOutcome {
  const entry = db.prepare(`SELECT title, summary, description, needs_merge FROM entries WHERE ulid = ?`).get(ulid) as
    | { title: string; summary: string; description: string | null; needs_merge: number }
    | undefined;
  if (!entry) return "single";
  const revs = revisionsOf(db, ulid);
  const heads = headsOf(revs);
  if (heads.length < 2) return "single";
  if (entry.needs_merge === 1) return "needs_merge"; // waiting for a person
  const insert = db.prepare(
    `INSERT INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description, created_at`,
  );
  let cur = heads[0];
  for (const h of heads.slice(1)) {
    const base = commonAncestor(revs, cur.rev_id, h.rev_id);
    const title = mergeText(base?.title ?? "", cur.title, h.title, false);
    const summary = mergeText(base?.summary ?? "", cur.summary, h.summary, false);
    const description = mergeText(base?.description ?? null, cur.description, h.description, true);
    if (!base || !title.ok || !summary.ok || !description.ok) {
      flagNeedsMerge(db, ulid);
      return "needs_merge";
    }
    const merged = insert.get(
      randomBytes(16).toString("hex"), ulid, cur.rev_id, h.rev_id, title.value, summary.value, description.value,
    ) as RevisionRow;
    revs.push(merged);
    cur = merged;
  }
  if (entry.title !== cur.title || entry.summary !== cur.summary || (entry.description ?? null) !== (cur.description ?? null)) {
    db.prepare(`UPDATE entries SET title = ?, summary = ?, description = ?, tokens_estimate = ? WHERE ulid = ?`).run(
      cur.title, cur.summary, cur.description, estimateTokens(cur.description ?? undefined), ulid,
    );
  }
  return "merged";
}

export function mergeEntries(db: Store, ulids: Iterable<string>): void {
  for (const u of ulids) mergeEntry(db, u);
}

/**
 * status/type have no revisions (fixed choices). An incoming change at a column
 * version <= the store's, with a different value, was made without seeing the
 * store's value: two machines chose differently => needs_merge (D8).
 */
export function divergentStatusOrType(db: Store, raw: RawChange): string | null {
  if (raw.table !== "entries" || (raw.cid !== "status" && raw.cid !== "type")) return null;
  const first = db.prepare(`SELECT cell FROM crsql_unpack_columns(?) LIMIT 1`).get(raw.pk) as { cell: string } | undefined;
  if (!first) return null;
  const cur = db
    .prepare(
      `SELECT c.col_version AS v, e.${raw.cid} AS held
         FROM entries__crsql_pks p
         JOIN entries__crsql_clock c ON c.key = p.__crsql_key AND c.col_name = ?
         JOIN entries e ON e.ulid = p.ulid
        WHERE p.ulid = ?`,
    )
    .get(raw.cid, first.cell) as { v: number; held: string } | undefined;
  if (!cur) return null;
  return raw.col_version <= cur.v && cur.held !== raw.val ? String(first.cell) : null;
}
```

(`estimateTokens` is exported by core's `db.ts`; check its parameter type and adapt the call if it differs.)

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/post-office test` (the `pretest` rebuilds core with `resolveNeedsMerge`). Expected: PASS.

- [ ] **Step 5: Commit** `feat(post-office): three-way merge, status/type divergence, needs_merge; core resolveNeedsMerge (sync v1 plan 2)`

---

### Task 10: The HTTPS + SSE server

**Files:**
- Create: `post-office/src/server.ts`, `post-office/test/server.test.ts`
- Modify: `post-office/src/index.ts`

**Interfaces produced:** `startPostOffice(opts) → PostOffice { url, port, ring(event, data, except?), listeners(), close() }`; options `{ store, certPem, keyPem, host?, port?, heartbeatMs? (25 s), revokeCheckMs? (2 s), maxBodyBytes? (64 MB), log?, testHooks?: { dropAllocateAnswer?(ulid) } }`.

Behaviour: every route but `/v1/join` authenticates FIRST, from the store, on every request (no cache), so a revoke from the admin command (another process) is effective on the next request. The doorbell (`changes`) goes to every connected member except the sender, unless the office itself wrote (a merge), in which case the sender is rung too. An open stream of a revoked member gets `event: revoked` and is closed within `revokeCheckMs`. Idle cost: one comment line per stream every 25 s.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: post-office/test/server.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  generateSelfSignedCert, requestJson, openEventStream, newUlid, AccessRevokedError,
  addEntryAsync, setAllocator, readOwnChanges, type PostOfficeTarget,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { addMember, revokeMember } from '../src/store.js';
import { startPostOffice } from '../src/server.js';

export async function office(seed = 0, extra: Record<string, unknown> = {}) {
  const t = tempStore(seed);
  const cert = generateSelfSignedCert();
  const po = await startPostOffice({ store: t.store, certPem: cert.certPem, keyPem: cert.keyPem, host: '127.0.0.1', port: 0, heartbeatMs: 50, revokeCheckMs: 50, ...extra });
  const target = (auth?: { device: string; key: string }): PostOfficeTarget => ({ url: po.url, fingerprint: cert.fingerprint, auth });
  const join = async (name: string) => {
    const { deviceId, secret } = addMember(t.store, name);
    const r = await requestJson(target(), 'POST', '/v1/join', { device: deviceId, secret });
    assert.equal(r.status, 200);
    return { device: deviceId, key: r.body.key as string, secret };
  };
  return { ...t, po, cert, target, join, stop: async () => { await po.close(); t.cleanup(); } };
}

function listen(target: PostOfficeTarget) {
  const events: Array<[string, any]> = [];
  let closedWith: Error | undefined | null = null;
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const stream = openEventStream(target, '/v1/events', {
    event: (name, data) => { events.push([name, JSON.parse(data)]); if (name === 'ready') ready(); },
    close: (err) => { closedWith = err; },
  });
  return { events, isReady, stream, closed: () => closedWith };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('join once, then allocate (idempotent by ulid)', async () => {
  const o = await office(100);
  try {
    const m = await o.join('laptop b');
    const again = await requestJson(o.target(), 'POST', '/v1/join', { device: m.device, secret: m.secret });
    assert.equal(again.status, 403);
    const u = newUlid();
    const r1 = await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: u });
    const r2 = await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: u });
    assert.deepEqual([r1.body.id, r2.body.id], [101, 101]);
    assert.equal((await requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: 'junk' })).status, 400);
  } finally { await o.stop(); }
});

test('no key or a wrong key: 401', async () => {
  const o = await office();
  try {
    await assert.rejects(requestJson(o.target(), 'GET', '/v1/status'), AccessRevokedError);
    await assert.rejects(requestJson(o.target({ device: 'd-nope', key: 'x' }), 'GET', '/v1/status'), AccessRevokedError);
  } finally { await o.stop(); }
});

test('push rings everyone but the sender; the others pull it', async () => {
  const o = await office();
  const lap = laptop();
  try {
    const a = await o.join('a'), b = await o.join('b');
    const la = listen(o.target(a)), lb = listen(o.target(b));
    await la.isReady; await lb.isReady;
    setAllocator({ allocate: async () => 1 });
    await addEntryAsync(lap.db, { type: 'decision', title: 'ring', summary: 's', module: 'm' });
    const sent = readOwnChanges(lap.db, 0);
    const r = await requestJson(o.target(a), 'POST', '/v1/changes', { changes: sent });
    assert.equal(r.body.accepted, sent.length);
    await until(() => lb.events.some(([n]) => n === 'changes'));
    assert.equal(la.events.some(([n]) => n === 'changes'), false, 'the sender is not rung');
    const page = await requestJson(o.target(b), 'GET', '/v1/changes?after=0&limit=1000');
    assert.equal(page.body.changes.length, sent.length);
    assert.equal(page.body.more, false);
    const mine = await requestJson(o.target(a), 'GET', '/v1/changes?after=0');
    assert.equal(mine.body.changes.length, 0);
    la.stream.close(); lb.stream.close();
  } finally { setAllocator(null); lap.cleanup(); await o.stop(); }
});

test('revoke: the next request is refused and the open doorbell is closed', async () => {
  const o = await office();
  try {
    const m = await o.join('lost laptop');
    const l = listen(o.target(m));
    await l.isReady;
    revokeMember(o.store, 'lost laptop');
    await assert.rejects(requestJson(o.target(m), 'POST', '/v1/allocate', { ulid: newUlid() }), AccessRevokedError);
    await until(() => l.events.some(([n]) => n === 'revoked'));
    await until(() => l.closed() !== null);
    const again = listen(o.target(m));
    await until(() => again.closed() !== null);
    assert.ok(again.closed() instanceof AccessRevokedError);
  } finally { await o.stop(); }
});

test('shared modules: set over the API, rung to everyone', async () => {
  const o = await office();
  try {
    const a = await o.join('a');
    const l = listen(o.target(a));
    await l.isReady;
    const r = await requestJson(o.target(a), 'POST', '/v1/modules', { slug: 'sync', shared: true });
    assert.deepEqual(r.body.shared, ['sync']);
    assert.deepEqual((await requestJson(o.target(a), 'GET', '/v1/modules')).body.shared, ['sync']);
    await until(() => l.events.some(([n, d]) => n === 'modules' && d.shared[0] === 'sync'));
    l.stream.close();
  } finally { await o.stop(); }
});

test('status, 404, 413', async () => {
  const o = await office(0, { maxBodyBytes: 1000 });
  try {
    const a = await o.join('a');
    const st = await requestJson(o.target(a), 'GET', '/v1/status');
    assert.deepEqual(st.body.members.map((m: any) => [m.name, m.state]), [['a', 'up to date']]);
    assert.equal((await requestJson(o.target(a), 'GET', '/v1/nope')).status, 404);
    assert.equal((await requestJson(o.target(a), 'POST', '/v1/changes', { changes: [], pad: 'x'.repeat(5000) })).status, 413);
  } finally { await o.stop(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: post-office/src/server.ts
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  StoreError, allocate, authenticate, redeemJoin, isRevoked, sharedModules, setModuleShared, teamStatus,
  type Member, type Store,
} from "./store.js";
import { acceptChanges, fetchDeliveries, lastSeq } from "./deliveries.js";

// The post office's HTTPS + SSE API (spec Components 3, D12, D13). Plain Node
// https: no framework. Every route but /v1/join authenticates against the
// store on every request, so a revoke is effective immediately.

export interface PostOfficeOptions {
  store: Store;
  certPem: string;
  keyPem: string;
  host?: string;
  port?: number;
  heartbeatMs?: number;
  revokeCheckMs?: number;
  maxBodyBytes?: number;
  log?: (line: string) => void;
  /** Tests only. */
  testHooks?: { dropAllocateAnswer?: (ulid: string) => boolean };
}

export interface PostOffice {
  url: string;
  port: number;
  ring(event: string, data: unknown, except?: string): void;
  listeners(): string[];
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => {
      if (size > limit) return reject(new StoreError(`request too large (over ${limit} bytes)`, 413));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new StoreError("the request body is not JSON")); }
    });
    req.on("error", reject);
  });
}

function intParam(url: URL, name: string, dflt: number): number {
  const v = url.searchParams.get(name);
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new StoreError(`${name} must be a whole number`);
  return n;
}

export async function startPostOffice(o: PostOfficeOptions): Promise<PostOffice> {
  const log = o.log ?? (() => {});
  const maxBody = o.maxBodyBytes ?? 64 * 1024 * 1024;
  const streams = new Set<{ device: string; res: ServerResponse }>();

  function ring(event: string, data: unknown, except?: string): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) if (s.device !== except) s.res.write(msg);
  }

  function fail(res: ServerResponse, e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (res.headersSent) { res.destroy(); return; }
    const status = err instanceof StoreError ? err.status : 500;
    if (status >= 500) log(`error: ${err.message}`);
    send(res, status, { error: err.message });
  }

  function openStream(res: ServerResponse, me: Member): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`: collab post office\n\nevent: ready\ndata: ${JSON.stringify({ last_seq: lastSeq(o.store) })}\n\n`);
    const s = { device: me.device_id, res };
    streams.add(s);
    const ping = setInterval(() => res.write(": ping\n\n"), o.heartbeatMs ?? 25_000);
    const watch = setInterval(() => {
      if (isRevoked(o.store, me.device_id)) {
        res.write("event: revoked\ndata: {}\n\n");
        res.end();
      }
    }, o.revokeCheckMs ?? 2_000);
    res.on("close", () => {
      clearInterval(ping);
      clearInterval(watch);
      streams.delete(s);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://post-office.invalid");
    const route = `${req.method} ${url.pathname}`;
    if (route === "POST /v1/join") {
      const b = await readJson(req, maxBody);
      const device = String(b?.device ?? "");
      const { key } = redeemJoin(o.store, device, String(b?.secret ?? ""));
      log(`member joined: ${device}`);
      return send(res, 200, { device, key });
    }
    const me = authenticate(o.store, req.headers.authorization);
    if (!me) {
      req.resume();
      return send(res, 401, { error: "access revoked or unknown device" });
    }
    switch (route) {
      case "POST /v1/allocate": {
        const b = await readJson(req, maxBody);
        const id = allocate(o.store, b?.ulid, me.device_id);
        if (o.testHooks?.dropAllocateAnswer?.(String(b?.ulid))) { req.socket.destroy(); return; }
        return send(res, 200, { id });
      }
      case "POST /v1/changes": {
        const b = await readJson(req, maxBody);
        const r = acceptChanges(o.store, me.device_id, b?.changes);
        if (r.accepted > 0) {
          // A merge written by the office must reach the sender too.
          ring("changes", { last_seq: r.lastSeq }, r.officeWrote ? undefined : me.device_id);
          log(`${me.name}: ${r.accepted} change(s) accepted, ${r.duplicates} duplicate(s)${r.officeWrote ? ", office wrote a merge/flag" : ""}`);
        }
        return send(res, 200, { accepted: r.accepted, duplicates: r.duplicates, last_seq: r.lastSeq });
      }
      case "GET /v1/changes": {
        const r = fetchDeliveries(o.store, me.device_id, intParam(url, "after", 0), intParam(url, "limit", 2000));
        return send(res, 200, { changes: r.changes, last_seq: r.lastSeq, more: r.more });
      }
      case "GET /v1/modules":
        return send(res, 200, { shared: sharedModules(o.store) });
      case "POST /v1/modules": {
        const b = await readJson(req, maxBody);
        const shared = setModuleShared(o.store, b?.slug, b?.shared !== false);
        ring("modules", { shared });
        return send(res, 200, { shared });
      }
      case "GET /v1/status":
        return send(res, 200, { members: teamStatus(o.store), last_seq: lastSeq(o.store) });
      case "GET /v1/events":
        return openStream(res, me);
      default:
        req.resume();
        return send(res, 404, { error: `no such endpoint: ${route}` });
    }
  }

  const server = https.createServer({ cert: o.certPem, key: o.keyPem }, (req, res) => {
    handle(req, res).catch((e) => fail(res, e));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 7443, o.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = !o.host || o.host === "0.0.0.0" || o.host === "::" ? "127.0.0.1" : o.host;
  return {
    url: `https://${shown.includes(":") ? `[${shown}]` : shown}:${port}`,
    port,
    ring,
    listeners: () => [...streams].map((s) => s.device),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of streams) s.res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

`index.ts`: add `export * from "./server.js";`.

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/post-office test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(post-office): HTTPS + SSE API: join, allocate, push/pull, modules, status, doorbell (sync v1 plan 2)`

---

### Task 11: Admin commands

**Files:**
- Create: `post-office/src/paths.ts`, `post-office/src/cli.ts`, `post-office/src/bin.ts`, `post-office/test/cli.test.ts`
- Modify: `post-office/src/index.ts`

**Interfaces produced:** `defaultDataDir(env, platform, home)`, `officeFiles(dir)`, `runCli(argv, io) → Promise<{ code, office? }>`, `seedFromNotesDb(path)`, `lanAddress()`, `DEFAULT_PORT = 7443`.

Commands (all accept `--data <dir>`; default: Windows `%LOCALAPPDATA%\collab\post-office`, macOS `~/Library/Application Support/collab/post-office`, Linux `$XDG_DATA_HOME/collab/post-office` or `~/.local/share/collab/post-office`; never inside the repo):
- `init --seed-from <notes.db> | --seed-max-id <n> [--url https://host:port] [--port 7443]`: makes the certificate (`cert.pem`, `key.pem`), `config.json` (`url`, `port`, `fingerprint`) and the store. A seed is REQUIRED: new numbers must continue after the main laptop's highest (max of `max(entries.id)` and `local_counters.entry_number`). It prints what it created, where, and how to remove it (delete the folder).
- `serve [--host 0.0.0.0]`
- `add-member <name>`: prints a one-time join code (7 days).
- `revoke <device-id|name>`, `status`, `share <module>`, `unshare <module>`, `modules`.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: post-office/test/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, addEntry, parseJoinCode, requestJson, AccessRevokedError } from '@collab-mcp/core';
import { tempDir } from './helpers.js';
import { runCli } from '../src/cli.js';
import { defaultDataDir } from '../src/paths.js';

function io() {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test('default data dirs per OS (never in the repo)', () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' }, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\post-office');
  assert.equal(defaultDataDir({}, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\post-office');
  assert.equal(defaultDataDir({}, 'darwin', '/Users/n'), '/Users/n/Library/Application Support/collab/post-office');
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/n'), '/x/collab/post-office');
  assert.equal(defaultDataDir({}, 'linux', '/home/n'), '/home/n/.local/share/collab/post-office');
});

test('init needs a seed, seeds from the main notes DB, refuses to run twice', async () => {
  const t = tempDir();
  try {
    const notes = join(t.dir, 'collab.db');
    const db = new Database(notes);
    migrateTo(db, '0006', { includeStaged: true });
    for (let i = 0; i < 37; i++) addEntry(db, { type: 'decision', title: `n${i}`, summary: 's' });
    db.close();
    const data = join(t.dir, 'office');
    const c0 = io();
    assert.equal((await runCli(['init', '--data', data], c0.io)).code, 1);
    assert.match(c0.err.join('\n'), /--seed-from/);
    const c1 = io();
    assert.equal((await runCli(['init', '--data', data, '--seed-from', notes, '--url', 'https://10.1.2.3:7443'], c1.io)).code, 0);
    for (const f of ['store.db', 'cert.pem', 'key.pem', 'config.json']) assert.ok(existsSync(join(data, f)), f);
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.url, 'https://10.1.2.3:7443');
    assert.match(c1.out.join('\n'), new RegExp(cfg.fingerprint));
    assert.match(c1.out.join('\n'), /E-00038/);
    assert.match(c1.out.join('\n'), /remove/i);
    const c2 = io();
    assert.equal((await runCli(['init', '--data', data, '--seed-max-id', '5'], c2.io)).code, 1);
  } finally { t.cleanup(); }
});

test('add-member prints a join code; status, revoke, share', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--url', 'https://10.0.0.9:7443'], io().io);
    const c = io();
    assert.equal((await runCli(['add-member', 'second laptop', '--data', data], c.io)).code, 0);
    const code = c.out.find((l) => l.startsWith('collab1-'))!;
    const jc = parseJoinCode(code);
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    assert.deepEqual([jc.url, jc.fingerprint], ['https://10.0.0.9:7443', cfg.fingerprint]);
    let s = io();
    await runCli(['status', '--data', data], s.io);
    assert.match(s.out.join('\n'), /second laptop\s+waiting to join/);
    assert.equal((await runCli(['share', 'sync', '--data', data], io().io)).code, 0);
    s = io();
    await runCli(['modules', '--data', data], s.io);
    assert.match(s.out.join('\n'), /sync/);
    assert.equal((await runCli(['revoke', 'second laptop', '--data', data], io().io)).code, 0);
    s = io();
    await runCli(['status', '--data', data], s.io);
    assert.match(s.out.join('\n'), /second laptop\s+revoked/);
    assert.equal((await runCli(['revoke', 'nobody', '--data', data], io().io)).code, 1);
  } finally { t.cleanup(); }
});

test('serve answers over HTTPS with the pinned certificate', async () => {
  const t = tempDir();
  try {
    const data = join(t.dir, 'office');
    await runCli(['init', '--data', data, '--seed-max-id', '0', '--port', '0'], io().io);
    const c = io();
    const r = await runCli(['serve', '--data', data, '--host', '127.0.0.1'], c.io);
    try {
      assert.equal(r.code, 0);
      const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
      await assert.rejects(requestJson({ url: r.office!.url, fingerprint: cfg.fingerprint }, 'GET', '/v1/status'), AccessRevokedError);
    } finally { await r.office!.close(); }
  } finally { t.cleanup(); }
});

test('unknown command: usage, exit code 2', async () => {
  const c = io();
  assert.equal((await runCli(['frobnicate'], c.io)).code, 2);
  assert.match(c.err.join('\n'), /add-member/);
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: post-office/src/paths.ts
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** Where the post office keeps its store, certificate and key. Never inside the repo. */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab", "post-office");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab", "post-office");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "collab", "post-office");
}

export interface OfficeFiles { dir: string; store: string; cert: string; key: string; config: string }
export function officeFiles(dir: string): OfficeFiles {
  return { dir, store: join(dir, "store.db"), cert: join(dir, "cert.pem"), key: join(dir, "key.pem"), config: join(dir, "config.json") };
}
```

```ts
// file: post-office/src/cli.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import Database from "better-sqlite3";
import { generateSelfSignedCert, formatJoinCode } from "@collab-mcp/core";
import {
  createStore, openStore, closeStore, addMember, revokeMember, teamStatus, setModuleShared, sharedModules,
  nextNumber, JOIN_TTL_HOURS, StoreError, type Store,
} from "./store.js";
import { lastSeq } from "./deliveries.js";
import { startPostOffice, type PostOffice } from "./server.js";
import { defaultDataDir, officeFiles } from "./paths.js";

export interface Io { out(line: string): void; err(line: string): void }
export interface OfficeConfig { url: string; port: number; fingerprint: string }
export const DEFAULT_PORT = 7443;

export const USAGE = `collab-post-office: the sync v1 post office

  init --seed-from <main laptop's notes .db> | --seed-max-id <n>
       [--url https://<address>:<port>] [--port ${DEFAULT_PORT}]
  serve [--host 0.0.0.0]
  add-member <name>            prints a ONE-TIME join code (valid ${JOIN_TTL_HOURS / 24} days)
  revoke <device-id | name>
  status
  share <module> | unshare <module> | modules

Every command takes --data <dir> (default: ${defaultDataDir()}).`;

const pad = (n: number) => `E-${String(n).padStart(5, "0")}`;

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opt[a.slice(2)] = next; i++; } else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "127.0.0.1";
}

/** The highest E-number the main laptop has used (max id, or its local counter if higher). Read-only. */
export function seedFromNotesDb(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const max = (db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM entries`).get() as { m: number }).m;
    const hasCounter = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_counters'`).get();
    const counter = hasCounter
      ? ((db.prepare(`SELECT value FROM local_counters WHERE name = 'entry_number'`).get() as { value: number } | undefined)?.value ?? 0)
      : 0;
    return Math.max(max, counter);
  } finally {
    db.close();
  }
}

function readConfig(dir: string): OfficeConfig {
  const f = officeFiles(dir);
  if (!existsSync(f.config)) throw new StoreError(`no post office in ${dir}; run \`collab-post-office init\` first`);
  return JSON.parse(readFileSync(f.config, "utf8")) as OfficeConfig;
}

function withStore<T>(dir: string, fn: (s: Store) => T): T {
  const s = openStore(officeFiles(dir).store);
  try { return fn(s); } finally { closeStore(s); }
}

export async function runCli(argv: string[], io: Io): Promise<{ code: number; office?: PostOffice }> {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos[0];
  const dir = typeof opt.data === "string" ? opt.data : defaultDataDir();
  const f = officeFiles(dir);
  try {
    switch (cmd) {
      case "init": {
        if (existsSync(f.store)) throw new StoreError(`a post office already exists in ${dir}`);
        let seed: number;
        if (typeof opt["seed-from"] === "string") seed = seedFromNotesDb(opt["seed-from"]);
        else if (typeof opt["seed-max-id"] === "string" && /^\d+$/.test(opt["seed-max-id"])) seed = Number(opt["seed-max-id"]);
        else throw new StoreError("init needs --seed-from <the main laptop's notes DB> or --seed-max-id <n>: new note numbers must continue after the highest one already used");
        const port = typeof opt.port === "string" ? Number(opt.port) : DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StoreError(`not a port: ${String(opt.port)}`);
        const url = typeof opt.url === "string" ? opt.url : `https://${lanAddress()}:${port}`;
        if (!url.startsWith("https://")) throw new StoreError("the post office URL must start with https://");
        mkdirSync(dir, { recursive: true });
        const cert = generateSelfSignedCert();
        writeFileSync(f.cert, cert.certPem);
        writeFileSync(f.key, cert.keyPem, { mode: 0o600 });
        const config: OfficeConfig = { url, port, fingerprint: cert.fingerprint };
        writeFileSync(f.config, JSON.stringify(config, null, 2) + "\n");
        closeStore(createStore(f.store, { seedMaxId: seed }));
        io.out(`post office created in ${dir}`);
        io.out(`  store.db     every shared note + members + the number counter`);
        io.out(`  cert.pem     its HTTPS certificate (self-signed)`);
        io.out(`  key.pem      the certificate's private key: keep it private`);
        io.out(`  config.json  address ${url}`);
        io.out(`certificate fingerprint: ${cert.fingerprint}`);
        io.out(`the next new note will be ${pad(seed + 1)}`);
        io.out(`next: collab-post-office serve, then collab-post-office add-member "<machine name>" for each machine`);
        io.out(`to remove it: stop serve and delete ${dir}`);
        return { code: 0 };
      }
      case "serve": {
        const cfg = readConfig(dir);
        const store = openStore(f.store);
        const office = await startPostOffice({
          store,
          certPem: readFileSync(f.cert, "utf8"),
          keyPem: readFileSync(f.key, "utf8"),
          host: typeof opt.host === "string" ? opt.host : "0.0.0.0",
          port: cfg.port,
          log: (line) => io.out(`${new Date().toISOString()} ${line}`),
        });
        io.out(`post office listening on port ${office.port}; members reach it at ${cfg.url}`);
        io.out(`certificate fingerprint ${cfg.fingerprint}`);
        return {
          code: 0,
          office: { ...office, close: async () => { await office.close(); closeStore(store); } },
        };
      }
      case "add-member": {
        const name = pos.slice(1).join(" ").trim();
        if (!name) throw new StoreError("add-member needs a name, e.g. add-member \"second laptop\"");
        const cfg = readConfig(dir);
        const { deviceId, secret } = withStore(dir, (s) => addMember(s, name));
        const code = formatJoinCode({ url: cfg.url, fingerprint: cfg.fingerprint, device: deviceId, secret });
        io.out(`member "${name}" added as ${deviceId}. One-time join code (valid ${JOIN_TTL_HOURS / 24} days; treat it like a password):`);
        io.out("");
        io.out(code);
        io.out("");
        io.out(`on that machine: collab sync setup <the code above>`);
        return { code: 0 };
      }
      case "revoke": {
        const who = pos.slice(1).join(" ").trim();
        if (!who) throw new StoreError("revoke needs a device id or a member name");
        const m = withStore(dir, (s) => revokeMember(s, who));
        io.out(`revoked ${m.name} (${m.device_id}): every request from it is now refused`);
        return { code: 0 };
      }
      case "status": {
        const cfg = readConfig(dir);
        withStore(dir, (s) => {
          io.out(`post office ${cfg.url}   deliveries ${lastSeq(s)}   next new note ${pad(nextNumber(s))}`);
          const shared = sharedModules(s);
          io.out(`shared modules: ${shared.length ? shared.join(", ") : "(none yet: collab-post-office share <module>)"}`);
          const rows = teamStatus(s);
          if (rows.length === 0) { io.out("no members yet: collab-post-office add-member <name>"); return; }
          io.out(`${"DEVICE".padEnd(14)}${"NAME".padEnd(22)}${"STATE".padEnd(20)}LAST SEEN`);
          for (const r of rows) {
            const state = r.state === "behind" ? `behind ${r.behind}` : r.state;
            io.out(`${r.device_id.padEnd(14)}${r.name.padEnd(22)}${state.padEnd(20)}${r.last_seen_at ?? "-"}`);
          }
        });
        return { code: 0 };
      }
      case "share":
      case "unshare": {
        const slug = pos[1];
        if (!slug) throw new StoreError(`${cmd} needs a module slug`);
        const shared = withStore(dir, (s) => setModuleShared(s, slug, cmd === "share"));
        io.out(`shared modules: ${shared.join(", ") || "(none)"}`);
        return { code: 0 };
      }
      case "modules": {
        io.out(`shared modules: ${withStore(dir, sharedModules).join(", ") || "(none)"}`);
        return { code: 0 };
      }
      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`collab-post-office: ${(e as Error).message}`);
    return { code: 1 };
  }
}
```

`post-office/src/bin.ts` (no marker line: the shebang must be first):

```ts
#!/usr/bin/env node
import { runCli } from "./cli.js";

const r = await runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
if (r.office) {
  const stop = () => { void r.office!.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  process.exitCode = r.code;
}
```

`index.ts`: add `export * from "./cli.js"; export * from "./paths.js";`.

Note: `writeFileSync(..., { mode: 0o600 })` is ignored on Windows; there the key sits under `%LOCALAPPDATA%`, which only the user (and administrators) can read by default. Flag for the Windows check.

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/post-office test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(post-office): admin commands: init, serve, add-member, revoke, status, share (sync v1 plan 2)`

---

### Task 12: End to end: core's allocator against the real post office

**Files:**
- Create: `post-office/test/allocator-e2e.test.ts`

No new code; this pins Review Focus 1, 2 and 5 against the real server and store, then typechecks everything.

- [ ] **Step 1: Write the tests.**

```ts
// file: post-office/test/allocator-e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, setAllocationRetry, setSyncValue, SYNC_KEYS, PostOfficeUnreachableError,
  type AddEntryArgs,
} from '@collab-mcp/core';
import { laptop } from './helpers.js';
import { office } from './server.test.js';
import { allocate, nextNumber, revokeMember } from '../src/store.js';

const ok: AddEntryArgs = { type: 'decision', title: 't', summary: 's', module: 'm' };
const bad: AddEntryArgs[] = [
  { ...ok, title: '' }, { ...ok, type: 'nope' as any }, { ...ok, summary: 'x'.repeat(201) }, { ...ok, agent: 'Zed' as any },
  { ...ok, refs: [{ ref_type: 'bogus' as any, ref_value: 'v' }] },
];
function configure(db: any, url: string, fingerprint: string, m: { device: string; key: string }) {
  setSyncValue(db, SYNC_KEYS.url, url);
  setSyncValue(db, SYNC_KEYS.fingerprint, fingerprint);
  setSyncValue(db, SYNC_KEYS.device, m.device);
  setSyncValue(db, SYNC_KEYS.key, m.key);
}

test('E-713 over HTTPS: the answer is dropped after allocation, the retry gets the same number', async () => {
  let drops = 1;
  const o = await office(500, { testHooks: { dropAllocateAnswer: () => drops-- > 0 } });
  const lap = laptop();
  try {
    setAllocator(null);
    setAllocationRetry({ delaysMs: [0, 0] });
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    assert.equal((await addEntryAsync(lap.db, ok)).id, 501);
    assert.equal(nextNumber(o.store), 502, 'the counter moved once');
    assert.equal((await addEntryAsync(lap.db, ok)).id, 502);
  } finally { setAllocationRetry(null); lap.cleanup(); await o.stop(); }
});

test('1000 saves with 50 invalid against the real store: no gaps', async () => {
  const o = await office(1200);
  const lap = laptop();
  try {
    setAllocator({ allocate: async (u) => allocate(o.store, u, 'd-local') });
    const ids: number[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i % 20 === 3) await assert.rejects(addEntryAsync(lap.db, bad[i % bad.length]));
      else ids.push((await addEntryAsync(lap.db, { ...ok, title: `n${i}` })).id);
    }
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: 950 }, (_, k) => 1201 + k));
  } finally { setAllocator(null); lap.cleanup(); await o.stop(); }
});

test('100 saves with 5 invalid over HTTPS: no gaps', async () => {
  const o = await office(0);
  const lap = laptop();
  try {
    setAllocator(null);
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    const ids: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 9) await assert.rejects(addEntryAsync(lap.db, bad[(i / 20) | 0]));
      else ids.push((await addEntryAsync(lap.db, { ...ok, title: `n${i}` })).id);
    }
    assert.deepEqual(ids, Array.from({ length: 95 }, (_, k) => 1 + k));
  } finally { lap.cleanup(); await o.stop(); }
});

test('revoked: refused at once, nothing written; post office down: refused, names the post office', async () => {
  const o = await office(0);
  const lap = laptop();
  const count = () => (lap.db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
  try {
    setAllocator(null);
    configure(lap.db, o.po.url, o.cert.fingerprint, await o.join('b'));
    revokeMember(o.store, 'b');
    const t0 = Date.now();
    await assert.rejects(addEntryAsync(lap.db, ok), (e: any) => e instanceof PostOfficeUnreachableError && /revoked/.test(e.message));
    assert.ok(Date.now() - t0 < 1000, 'no retries on 401');
    await o.po.close();
    setAllocationRetry({ delaysMs: [0, 0] });
    await assert.rejects(addEntryAsync(lap.db, ok), /post office/);
    assert.equal(count(), 0);
  } finally { setAllocationRetry(null); lap.cleanup(); await o.stop().catch(() => {}); }
});
```

- [ ] **Step 2: Run.** Run: `npm -w @collab-mcp/post-office test`. Expected: PASS (these exercise code from Tasks 3–11; if one fails, the bug is in that task's code: fix it there and say so).

- [ ] **Step 3: Typecheck everything.** Run: `npm -w @collab-mcp/core run build && npx tsc --noEmit -p mcp && npx tsc --noEmit -p server && npx tsc --noEmit -p post-office && npm -w @collab-mcp/core test`. Expected: no type errors; all core tests pass.

- [ ] **Step 4: Commit** `test(post-office): end-to-end allocation over HTTPS (E-713, revoke, down) (sync v1 plan 2)`

---

## Spec check (done before building)

| Spec item | Where |
|---|---|
| D2 cr-sqlite replication, no hand-rolled CRDT | store = cr-sqlite replica; Task 6 codec only moves `crsql_changes` rows |
| D7 + E-708 numbers only from the office; down ⇒ refused | Tasks 3, 5, 12 |
| E-713 idempotent by ulid, one ulid across retries, validation first | Tasks 3, 7, 12 |
| D8 revisions, office-only three-way merge, `needs_merge` for overlap and status/type | Tasks 1, 9 |
| "Edits write revisions" (Components 1) | Task 1 |
| D9 tombstones never resurrect | `deleted_at` is a plain column; no code path writes it back to NULL; Plan 3 test 5 |
| D10 opt-in per module | Task 7 `po_shared_modules` + API (Task 10); the filter itself is the courier's (Plan 3) |
| D12 members, join code, keys, revoke ⇒ 401 now, team status | Tasks 7, 10, 11 |
| D13 HTTPS on LAN, pin from the join code | Tasks 4, 10 |
| D14 office storage = SQLite | Task 7 |
| D15 re-index on arrival | Task 6 `reindexFts` (used by the courier in Plan 3) |
| Components 3: deliveries seq; members (device, owner name, key hash, revoked, last seen, receive bookmark); allocations unique on both; counter from main max(id); increment + record in one tx; repeat ⇒ same | Tasks 7, 8 |
| Doorbell to everyone except the sender | Task 10 (plus the sender when the office merged) |
| Admin: add-member, revoke, status | Task 11 |
| Failure table: office down / key revoked / impostor | Tasks 3, 4, 10, 12 |

Gaps found on review and fixed in this plan: (1) the 0006 revision trigger fires on remote apply and its rows never replicate: dropped in 0007, revisions now in code (Task 1). (2) Bookkeeping triggers make untracked writes on remote apply: guarded (Task 2). (3) Rows the office's own migrations created must never be delivered: `self_db_version` starts after them (Task 7). (4) The office's merged write must reach the SENDER too: ring everyone when the office wrote (Task 10). (5) A `needs_merge` entry must not be merged again until a person settles it, and settling must fold every head (Tasks 1, 9). (6) Filtering `crsql_changes` by pk scans the whole table: the divergence check reads the clock tables (Task 9).

## Decisions where the spec is silent (recorded)

1. Shared-module list lives on the post office (team-wide), not per laptop: otherwise a note shared by A and edited on B (where the module was not opted in) would stop travelling. `po_shared_modules`, set by `collab-post-office share` or `POST /v1/modules`.
2. A join code is valid 7 days and names one pre-registered device; only hashes of secrets and keys are stored.
3. Default port 7443; data dir per OS outside the repo.
4. The device key lives in the notes DB's local-only `sync_state` (so every writer process finds the allocator config). A copy of the DB file therefore carries the key: `collab sync uninstall` (Plan 3) deletes it.
5. A merged revision's parent is the left head and `merged_from` names the right head (one extra column, not a link table).
6. A new note's first revision is written lazily (at its first edit) with a key derived from the entry, so concurrent first edits share a base.
7. The office does not filter by module (the courier is the gate); it does refuse any table outside the five shared ones.

## Out of scope for Plan 2

- The courier, `collab sync setup/start/stop/status/autostart/uninstall`, the filter by shared module, the 9 acceptance tests: Plan 3.
- Releasing 0007 to the live DB, enabling sync on any real DB, running the office on the real laptop: the go-live after Plan 3.
- A web page for team status (command + `/v1/status` only).
