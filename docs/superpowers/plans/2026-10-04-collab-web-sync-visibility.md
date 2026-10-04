# Collab Web UI Part 2: Sync Visibility and Conflicts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Code-block convention:** a block whose first line is `// file: <path>` (or `-- file:`) is the COMPLETE content of a new file. Edits to existing files are described in prose with the exact snippet to add or replace. Where the plan quotes existing code, match it; if the real code differs slightly, apply the same change to the real code and record the deviation.

**Goal:** The web UI shows sync health on every page, labels what is shared, lists notes whose edits collided, and settles them on a `/merge/:id` page (pick a version or combine), with a version check so a newer edit is never overwritten. Each version records its author (migration 0008). Laptops on different migrations pause instead of corrupting.

**Architecture:** Core gains migration 0008 (`entry_revisions.author`, applied through `crsql_begin_alter`/`crsql_commit_alter` on a shared notebook), a schema guard (`X-Collab-Schema` header, `SchemaMismatchError`), `readSyncOverview`, and the merge operations (`getMergeView`, `resolveNeedsMerge(…, expectedHeads)`, `resolveWithText`, plus V9: ordinary edits of a flagged note are refused). The web server exposes them under `/api/sync/*` (new file). The UI adds a status bar, a Needs-merge list and the Merge page; logic lives in small pure functions so it is tested without a DOM.

**Tech Stack:** TypeScript 5.3, Node ≥ 20.9, better-sqlite3 11, cr-sqlite 0.16.3, node:test via tsx 4, React 19 + react-router, vitest (environment `node`; component tests are skipped in this repo, so test pure functions).

**Spec:** `docs/superpowers/specs/2026-10-04-collab-web-sync-visibility-design.md` (V1–V9). Builds on part 1 (`docs/superpowers/specs/2026-10-04-collab-web-lock-design.md`, merged at 93187d1: every `/api` call needs `X-Collab-Key`; the test helper `test/helpers/server.mjs` adds it). Context in collab: E-741 (series), E-743 (part 1 done), E-738 (a real flagged note), E-708 (refuse to save when the post office is unreachable).

**Branch:** `collab-web-sync`, created from `collabv1` at the commit that contains this plan. Run `npm install` at the repo root once (on Linux use `npm install --force`: `ui/package.json` lists a Windows-only optional package). Build order when a step says "build": `npm -w @collab-mcp/core run build`, then the package you changed (`post-office`, `courier`, `mcp`, `server`). Packages import core from its built `dist/`.

## Global Constraints

- **Spec correction (apply to the spec file in Task 9):** "behind" is NOT "last contact older than 60 s". The courier is silent while nothing changes (idle = no network work). Health is: courier not running → `not-syncing`; courier state `needs-update` → `needs-update`; `status.json` missing/unreadable → `unknown`; courier state `revoked` → `revoked`; courier state `offline`/`starting` OR unsent > 0 → `behind`; else `ok`. The age of the last contact is shown as information only.
- Migration file name: `mcp/migrations/0008_revision_author.sql` (RELEASED, not staged: the schema guard makes a missed laptop pause, not corrupt). It contains no BEGIN/COMMIT; core wraps it.
- Writers must keep working on a 0007 notebook (new code, old schema): write `entry_revisions.author` only when the column exists.
- Header name: `X-Collab-Schema`; value = latest applied migration version (`SELECT MAX(version) FROM schema_migrations`).
- Post office answers a schema mismatch with **409** `{"error":"schema","office":"<v>","device":"<v or 'unknown'>"}` on every authenticated route (not on `/v1/join`).
- `readSyncOverview` returns only the fields in Task 3's type. It must never return `device_key` or any `sync_state` value not listed there.
- V9 refusal message, exactly: `E-<id 5 digits> needs a merge first: open /merge/<id> in the collab web UI`.
- Version check refusal: `VersionsChangedError`, HTTP **409** `{"error":"versions-changed"}`.
- UI words (exact): status bar texts in Task 6; merge page texts in Task 7; labels "⇄ Shared with team" / "🔒 Only on this laptop"; save note "⇄ <module> is shared: when you save, this note goes to everyone on the team."
- AI explain never recommends a version (prompt in Task 5) and failure returns 503 `{"error":"ai-unavailable"}`.
- Sharing off ⇒ the UI shows no bar, no labels, no menu item, no save note.
- Windows is the real platform. No POSIX-only calls. Process liveness via `process.kill(pid, 0)` in try/catch.
- Never commit `vendor/`, `dist/`, `.superpowers/`, key files. Commits go on `collab-web-sync` only.
- The 4 golden REST tests that already fail on `collabv1` (search all/by module/by category, doctor; collab E-742) are out of scope: they must fail the SAME way, no new failures.

## Review Focus

1. **A notebook that was never shared** (no `sync_state` rows, no CRR tables): 0008 must apply without cr-sqlite, `readSyncOverview` returns `{enabled:false}`, the UI shows nothing new. Tests: Task 1 "0008 on an unshared notebook", Task 3 "sharing off".
2. **New code on an old (0007) notebook** before `migrate` ran: edits must not fail on the missing `author` column. Test: Task 1 "an edit on a 0007 notebook still works".
3. **A third version arriving while the merge page is open** (3 heads, or the set changed): resolve is refused, nothing written. Test: Task 4 "a changed set of versions is refused".
4. **`status.json` holding a pid of a process that died** (crash, reboot): bar must say not syncing, not green. Test: Task 3 "a dead pid means not syncing".
5. **An older courier with no `X-Collab-Schema` header** talking to an updated office: refused with 409 (device "unknown"), never merged. Test: Task 2 "a request without the schema header is refused".

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `mcp/migrations/0008_revision_author.sql` | new | add `entry_revisions.author` |
| `core/src/db.ts` | modify | migration hooks for 0008 (begin/commit alter, atomic); `latestMigration` |
| `core/src/revisions.ts` | modify | `author` on new revisions (when the column exists) |
| `core/src/sync/errors.ts` | modify | `SchemaMismatchError` |
| `core/src/sync/http.ts` | modify | send `X-Collab-Schema`; 409 schema → `SchemaMismatchError` |
| `core/src/sync/http-allocator.ts` | modify | target carries the schema |
| `core/src/sync/courier-paths.ts` | new | `courierDir`, `courierFiles` (moved from courier) |
| `core/src/sync/overview.ts` | new | `readSyncOverview`, `unsentSharedCount` |
| `core/src/ops/merge.ts` | new | `getMergeView`, `resolveWithText`, `VersionsChangedError`, `NeedsMergeError`, `currentHeads` |
| `core/src/ops/update.ts` | modify | `resolveNeedsMerge(db, id, expectedHeads)`; V9 in `updateEntry` |
| `core/src/ops/edit.ts` | modify | V9 in `editEntry` |
| `core/src/index.ts` | modify | exports |
| `courier/src/paths.ts` | modify | re-export from core |
| `courier/src/engine.ts` | modify | `needs-update` state |
| `courier/src/cli.ts` | modify | `sync status` uses `unsentSharedCount` |
| `post-office/src/server.ts` | modify | schema guard |
| `post-office/src/store.ts` | modify | `openStore` applies released migrations |
| `server/src/tools/sync.ts` | new | `/api/sync/*` routes |
| `server/src/tools/collab.ts` | modify | modules gain `shared` |
| `server/src/server.ts` | modify | mount sync routes |
| `ui/src/api/client.ts` | modify | sync API calls + types |
| `ui/src/sync/view.ts` | new | pure: bar view, field diff, save note, label |
| `ui/src/sync/view.test.ts` | new | tests for view.ts |
| `ui/src/components/SyncBar.tsx` | new | top bar |
| `ui/src/pages/NeedsMerge.tsx` | new | list |
| `ui/src/pages/Merge.tsx` | new | resolve page |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/AppShell.tsx` | modify | routes, menu item, bar |
| `ui/src/pages/Modules.tsx`, `ui/src/components/EntryDrawer.tsx`, `ui/src/components/DraftCard.tsx` | modify | labels, banner, save note |
| tests | new/modify | listed per task |

---

### Task 1: Migration 0008 — each version records its author (spike first)

**Files:**
- Create: `mcp/migrations/0008_revision_author.sql`
- Modify: `core/src/db.ts`, `core/src/revisions.ts`, `core/src/index.ts`
- Test: `core/test/migrate-0008.test.ts` (new)

**Interfaces:**
- Produces: `latestMigration(db: DB): string | null` (core/src/db.ts, exported); `hasRevisionAuthor(db: DB): boolean` (core/src/revisions.ts, exported); `RevisionRow.author: string | null`.

- [ ] **Step 1: Write the failing tests (this is also the spike: the first test answers "does begin/commit alter + replication of the new column work on our schema?")**

```ts
// file: core/test/migrate-0008.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb, ship, dbVersion } from './helpers/sync.js';
import { migrate, latestMigration } from '../src/db.js';
import { enableSync } from '../src/sync/enable.js';
import { addEntry } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';
import { revisionsOf, hasRevisionAuthor } from '../src/revisions.js';
import { ensureCrsqlite } from '../src/sync/extension.js';

const ok = { type: 'decision' as const, title: 't', summary: 's', module: 'm' };
const author = (db: Database.Database, ulid: string) =>
  (db.prepare('SELECT author FROM entry_revisions WHERE entry_ulid = ? ORDER BY created_at, rev_id').all(ulid) as Array<{ author: string | null }>).map((r) => r.author);

test('0008 on a SHARED notebook: column added through cr-sqlite, edits replicate with their author', () => {
  const a = freshDb({ shared: true });
  const b = freshDb({ shared: true });
  try {
    for (const t of [a, b]) migrate(t.db);
    assert.equal(latestMigration(a.db), '0008_revision_author');
    assert.ok(hasRevisionAuthor(a.db));
    process.env.COLLAB_AUTHOR = 'naveen';
    const { id } = addEntry(a.db, ok);
    updateEntry(a.db, { id, summary: 'edited on a' });
    const ulid = (a.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    ship(a.db, b.db);
    assert.deepEqual(author(b.db, ulid), ['naveen', 'naveen'], 'root takes the note author; the edit records its author; both arrive on b');
    const before = dbVersion(b.db);
    process.env.COLLAB_AUTHOR = 'rinku';
    updateEntry(b.db, { id, summary: 'edited on b' });
    ship(b.db, a.db, before);
    assert.deepEqual(author(a.db, ulid), ['naveen', 'naveen', 'rinku']);
  } finally { delete process.env.COLLAB_AUTHOR; a.cleanup(); b.cleanup(); }
});

test('0008 on an unshared notebook works without cr-sqlite', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.ok(hasRevisionAuthor(t.db));
    const { id } = addEntry(t.db, ok);
    updateEntry(t.db, { id, summary: 'x' });
    const ulid = (t.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    assert.equal(revisionsOf(t.db, ulid).length, 2);
  } finally { t.cleanup(); }
});

test('an edit on a 0007 notebook (new code, migration not run yet) still works', () => {
  const t = freshDb(); // freshDb stops at 0007
  try {
    assert.equal(hasRevisionAuthor(t.db), false);
    const { id } = addEntry(t.db, ok);
    updateEntry(t.db, { id, summary: 'x' });
  } finally { t.cleanup(); }
});

test('0008 is atomic: a failure leaves no half-applied state', () => {
  const t = freshDb({ shared: true });
  try {
    ensureCrsqlite(t.db);
    t.db.exec('ALTER TABLE entry_revisions RENAME TO entry_revisions_gone'); // force the ALTER to fail
    assert.throws(() => migrate(t.db));
    assert.equal(latestMigration(t.db), '0007_sync_prep');
  } finally { t.cleanup(); }
});
```

(If `freshDb` migrates through `migrateTo(db, '0007', { includeStaged: true })`, it stops at 0007, which is what these tests need. `migrate(db)` then applies released 0008.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd core && npx tsx --test test/migrate-0008.test.ts`
Expected: FAIL, `latestMigration` / `hasRevisionAuthor` not exported.

- [ ] **Step 3: The migration file**

```sql
-- file: mcp/migrations/0008_revision_author.sql
-- ============================================================
-- Collab — who wrote each version (web UI part 2, decision V6)
-- Migration: 0008_revision_author
--
-- entry_revisions is a cr-sqlite CRR on a shared notebook. core/src/db.ts runs
-- this file inside one transaction between crsql_begin_alter and
-- crsql_commit_alter when the table is a CRR (and plainly when it is not), so
-- this file has no BEGIN/COMMIT of its own.
-- ============================================================
ALTER TABLE entry_revisions ADD COLUMN author TEXT;

INSERT INTO schema_migrations (version) VALUES ('0008_revision_author');
```

- [ ] **Step 4: Hooks in `core/src/db.ts`**

Next to `const BEFORE_MIGRATION ...`, add:

```ts
/** True when `table` is a cr-sqlite CRR in this file. */
function isCrr(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(`${table}__crsql_clock`);
}

/**
 * Migrations that ALTER a CRR table. cr-sqlite needs the change wrapped in
 * crsql_begin_alter / crsql_commit_alter, and the whole thing must be atomic.
 * Their SQL files carry no BEGIN/COMMIT.
 */
const CRR_ALTERS: Record<string, string> = {
  "0008_revision_author": "entry_revisions",
};
```

Add `import { ensureCrsqlite } from "./sync/extension.js";` at the top of `core/src/db.ts` (check for an import cycle: `sync/extension.ts` imports only the `DB` TYPE from `db.ts`, so it is safe).

In `applyMigrations`, replace the loop body

```ts
    BEFORE_MIGRATION[m.version]?.(db);
    db.exec(readFileSync(m.file, "utf-8"));
```

with

```ts
    BEFORE_MIGRATION[m.version]?.(db);
    const sql = readFileSync(m.file, "utf-8");
    const crrTable = CRR_ALTERS[m.version];
    if (crrTable) {
      const crr = isCrr(db, crrTable);
      if (crr) ensureCrsqlite(db);
      db.transaction(() => {
        if (crr) db.prepare(`SELECT crsql_begin_alter(?)`).get(crrTable);
        db.exec(sql);
        if (crr) db.prepare(`SELECT crsql_commit_alter(?)`).get(crrTable);
      })();
    } else {
      db.exec(sql);
    }
```

Add and export:

```ts
/** The newest applied migration, e.g. "0008_revision_author" (null on an empty file). */
export function latestMigration(db: DB): string | null {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!has) return null;
  return (db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get() as { v: string | null }).v;
}
```

**Spike rule:** if Step 6 shows `crsql_begin_alter`/`crsql_commit_alter` cannot run inside the transaction (an error naming the transaction or savepoint), move them OUTSIDE (`begin_alter`; transaction(exec); `commit_alter`), keep the atomicity test passing as far as SQLite allows, and record the deviation with the exact error text. If the new column does not replicate at all, STOP the plan and report: the rest depends on it.

- [ ] **Step 5: Author on revisions (`core/src/revisions.ts`)**

Add `import { resolveAuthor } from "./author.js";`. Add `author: string | null;` to `RevisionRow`. Add:

```ts
/** 0008+: entry_revisions.author exists. New code must still run on a 0007 file. */
export function hasRevisionAuthor(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entry_revisions') WHERE name = 'author'`).get();
}
```

In `revisionsOf`, select `author` when the column exists:

```ts
export function revisionsOf(db: DB, ulid: string): RevisionRow[] {
  const author = hasRevisionAuthor(db) ? "author" : "NULL AS author";
  return db
    .prepare(
      `SELECT rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description, created_at, ${author}
         FROM entry_revisions WHERE entry_ulid = ? ORDER BY created_at, rev_id`,
    )
    .all(ulid) as RevisionRow[];
}
```

In `finishRevision`: compute `const withAuthor = hasRevisionAuthor(db);` once. The root insert becomes (root takes the NOTE's author):

```ts
    if (withAuthor) {
      db.prepare(
        `INSERT OR IGNORE INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, title, summary, description, created_at, author)
         VALUES (?, ?, NULL, ?, ?, ?, ?, (SELECT author FROM entries WHERE ulid = ?))`,
      ).run(rootRevId(before.ulid), before.ulid, before.title, before.summary, before.description, before.created_at, before.ulid);
    } else {
      // (the existing insert, unchanged)
    }
```

and the new-revision insert adds `author` = `resolveAuthor()` when `withAuthor` (keep the old statement for the else branch).

Export `latestMigration` from `core/src/index.ts` if `db.ts` exports are not already re-exported wholesale (check `export * from './db.js'`).

- [ ] **Step 6: Run to verify they pass, plus the existing revision/sync tests**

Run: `cd core && npx tsx --test test/migrate-0008.test.ts test/sync-revisions.test.ts test/sync-triggers.test.ts test/sync-changes.test.ts test/sync-allocate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/migrations/0008_revision_author.sql core/src/db.ts core/src/revisions.ts core/src/index.ts core/test/migrate-0008.test.ts
git commit -m "feat(sync): migration 0008 records each version's author (CRR alter, atomic)"
```

---

### Task 2: Schema guard between couriers and the post office

**Files:**
- Modify: `core/src/sync/errors.ts`, `core/src/sync/http.ts`, `core/src/sync/http-allocator.ts`
- Modify: `post-office/src/server.ts`, `post-office/src/store.ts`
- Modify: `courier/src/engine.ts`
- Test: `post-office/test/schema-guard.test.ts` (new), `courier/test/engine.test.ts` (append)

**Interfaces:**
- Consumes: `latestMigration` (Task 1).
- Produces: `class SchemaMismatchError extends Error { office: string; device: string; retriable: false }`; `PostOfficeTarget.schema?: string`; courier state `"needs-update"`.

- [ ] **Step 1: Write the failing tests**

`post-office/test/office.ts` exports `office(seed?)` → `{ store, po, cert, target(auth?), join(name), stop() }`; `join` posts `/v1/join` WITHOUT a schema header and asserts 200, so it doubles as the "join is not checked" test.

```ts
// file: post-office/test/schema-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { requestJson, SchemaMismatchError, latestMigration } from '@collab-mcp/core';
import { office } from './office.js';

test('/v1/join is not schema-checked; a request with the office schema is served', async () => {
  const o = await office();
  try {
    const m = await o.join('a'); // join() asserts 200 with no schema header
    const r = await requestJson({ ...o.target(m), schema: latestMigration(o.store)! }, 'GET', '/v1/modules');
    assert.equal(r.status, 200);
  } finally { await o.stop(); }
});

test('a different schema is refused with 409 and becomes SchemaMismatchError', async () => {
  const o = await office();
  try {
    const m = await o.join('a');
    await assert.rejects(requestJson({ ...o.target(m), schema: '0007_sync_prep' }, 'GET', '/v1/modules'), (e: any) =>
      e instanceof SchemaMismatchError && e.office === latestMigration(o.store) && e.device === '0007_sync_prep' && e.retriable === false);
  } finally { await o.stop(); }
});

test('a request without the schema header is refused (an older courier)', async () => {
  const o = await office();
  try {
    const m = await o.join('a');
    const bare = { url: o.po.url, fingerprint: o.cert.fingerprint, auth: m }; // no schema: an older courier
    await assert.rejects(requestJson(bare, 'POST', '/v1/allocate', { ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
      (e: any) => e instanceof SchemaMismatchError && e.device === 'unknown');
  } finally { await o.stop(); }
});
```

(`o.target(m)` passes `{device, key, secret}` as auth; `headers()` only reads `device` and `key`.) Existing post-office tests that call authenticated routes through `o.target(...)` without a schema will now get 409: give `office.ts`'s `target` a default `schema: latestMigration(t.store) ?? undefined` so they keep passing; the third test above builds its target inline without one.

Append to `courier/test/engine.test.ts` (it already imports `joinedDb`, `openWriter`, `closeWriter`, `startOffice`, `tempDir` from `./world.js`):

```ts
test('a schema mismatch puts the courier in needs-update and it does not hammer the office', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const j = await joinedDb(office, t.dir, 'a');
  const w = openWriter(j.path);
  // This laptop claims a newer migration than the office has.
  w.prepare(`INSERT INTO schema_migrations (version) VALUES ('9999_from_the_future')`).run();
  const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
  try {
    await c.syncNow().catch(() => {});
    assert.equal(c.status.state, 'needs-update');
    assert.match(c.status.lastError ?? '', /update this laptop: the post office is on \S+, this notes DB is on 9999_from_the_future/);
    const before = c.status.lastError;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.status.state, 'needs-update', 'still paused, no retry storm inside the 60 s interval');
    assert.equal(c.status.lastError, before);
  } finally { await c.stop(); closeWriter(w); await office.close(); t.cleanup(); }
});
```

If `Courier` builds its target once in the constructor from the DB, inserting the row before `new Courier` (as above) is what makes it carry `9999_from_the_future`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm -w @collab-mcp/core run build && cd post-office && npx tsx --test test/schema-guard.test.ts`
Expected: FAIL, `SchemaMismatchError` not exported.

- [ ] **Step 3: Implement core**

`core/src/sync/errors.ts`, add:

```ts
/** 409 from the post office: this laptop and the office are on different migrations. */
export class SchemaMismatchError extends Error {
  readonly retriable = false;
  constructor(readonly office: string, readonly device: string) {
    super(`update this laptop: the post office is on ${office}, this notes DB is on ${device}`);
    this.name = "SchemaMismatchError";
  }
}
```

`core/src/sync/http.ts`: add `schema?: string` to `PostOfficeTarget`; in `headers()`, add `if (target.schema) h["x-collab-schema"] = target.schema;`; in `requestJson`'s `end` handler, after the 401 line and after parsing, add:

```ts
          if (res.statusCode === 409 && parsed?.error === "schema") {
            return reject(new SchemaMismatchError(String(parsed.office), String(parsed.device)));
          }
```

(import `SchemaMismatchError` from `./errors.js`). In `openEventStream`, treat a 409 response the same way (`finish(new SchemaMismatchError(...))`; read the body first if the stream code allows, else use `office: "unknown"`).

`core/src/sync/http-allocator.ts`, `postOfficeTargetFromDb`: return `{ url, fingerprint, auth: { device, key }, schema: latestMigration(db) ?? undefined }` (import `latestMigration` from `../db.js`).

- [ ] **Step 4: Implement the office**

`post-office/src/store.ts` `openStore`: after `loadCrsqlite(db);` add `migrate(db);` (import `migrate` from `@collab-mcp/core`) so `serve` brings the store to the newest released migration (backup is taken by core). Export `officeSchema(db: Store): string` = `latestMigration(db) ?? "unknown"`.

`post-office/src/server.ts` `handle()`: compute `const officeSchemaValue = officeSchema(o.store);` once when the server starts (outside `handle`). After `const me = authenticate(...)` and its 401 branch, add:

```ts
    const deviceSchema = String(req.headers["x-collab-schema"] ?? "unknown");
    if (deviceSchema !== officeSchemaValue) {
      req.resume();
      log(`${me.name}: refused, schema ${deviceSchema} (office ${officeSchemaValue})`);
      return send(res, 409, { error: "schema", office: officeSchemaValue, device: deviceSchema });
    }
```

- [ ] **Step 5: Implement the courier**

`courier/src/engine.ts`: add `"needs-update"` to `CourierState`. In `failed(e)`, before the generic offline branch:

```ts
    if (e instanceof SchemaMismatchError) {
      this.log(`paused: ${e.message}`);
      this.set({ state: "needs-update", lastError: e.message });
      if (!this.retryTimer && !this.stopped) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.syncNow(); }, this.opt.retryMs);
      }
      return;
    }
```

Do the same in the event-stream error handler next to its `AccessRevokedError` check. Make sure the courier's own target is built with `postOfficeTargetFromDb` (so it carries `schema`); if the engine builds its target elsewhere, add `schema: latestMigration(db) ?? undefined` there.

- [ ] **Step 6: Run to verify they pass, plus the existing suites**

Run: `npm -w @collab-mcp/core run build && npm -w @collab-mcp/post-office run build && npm -w @collab-mcp/courier run build`
Run: `cd post-office && npx tsx --test test/*.test.ts` and `cd courier && npx tsx --test test/*.test.ts`
Expected: PASS. If an existing test talks to the office through a target without `schema`, fix that TEST's setup to use `postOfficeTargetFromDb` (or add `schema`), never loosen the guard.

- [ ] **Step 7: Commit**

```bash
git add core/src/sync/errors.ts core/src/sync/http.ts core/src/sync/http-allocator.ts post-office/src courier/src post-office/test courier/test
git commit -m "feat(sync): schema guard: office and couriers on different migrations pause instead of merging"
```

---

### Task 3: `readSyncOverview` (what the status bar shows)

**Files:**
- Create: `core/src/sync/courier-paths.ts`, `core/src/sync/overview.ts`
- Modify: `courier/src/paths.ts`, `courier/src/cli.ts`, `core/src/index.ts`
- Test: `core/test/sync-overview.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export type SyncHealth = "ok" | "behind" | "not-syncing" | "needs-update" | "revoked" | "unknown";
export type SyncOverview =
  | { enabled: false }
  | {
      enabled: true;
      postOffice: string;            // URL only
      deviceId: string;
      sharedModules: string[];
      unsent: number;                // own changes in shared modules not yet sent
      courier: { running: boolean; state: string; lastError: string | null; lastPushAt: string | null; lastPullAt: string | null };
      lastContactAt: string | null;  // max(lastPushAt, lastPullAt)
      health: SyncHealth;
    };
export function readSyncOverview(db: DB, opts?: { courierDir?: string; isAlive?: (pid: number) => boolean }): SyncOverview;
export function unsentSharedCount(db: DB): number;
export function courierDir(env?, platform?, home?): string;   // moved from courier
export function courierFiles(dir: string): CourierFiles;     // moved from courier
```

- [ ] **Step 1: Write the failing tests**

```ts
// file: core/test/sync-overview.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './helpers/sync.js';
import { readSyncOverview, unsentSharedCount } from '../src/sync/overview.js';
import { setSyncValue } from '../src/sync/state.js';
import { addEntry } from '../src/ops/add.js';

function shared(t: ReturnType<typeof freshDb>, modules: string[]) {
  setSyncValue(t.db, 'po_url', 'https://192.168.0.104:7443');
  setSyncValue(t.db, 'device_id', 'd-1');
  setSyncValue(t.db, 'device_key', 'SECRET-KEY-VALUE');
  setSyncValue(t.db, 'po_fingerprint', 'abc');
  setSyncValue(t.db, 'shared_modules', JSON.stringify(modules));
}
function courier(status: object | null, pid = 4242) {
  const dir = mkdtempSync(join(tmpdir(), 'courier-'));
  if (status) writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...status, pid }));
  writeFileSync(join(dir, 'courier.pid'), String(pid));
  return dir;
}
const st = (state: string, extra: object = {}) => ({ state, lastError: null, lastPushAt: '2026-10-04T10:00:00Z', lastPullAt: '2026-10-04T10:05:00Z', sentTotal: 0, receivedTotal: 0, ...extra });

test('sharing off -> { enabled: false }', () => {
  const t = freshDb();
  try { assert.deepEqual(readSyncOverview(t.db), { enabled: false }); } finally { t.cleanup(); }
});

test('never contains the device key or any unlisted sync_state value', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    const o = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    const s = JSON.stringify(o);
    assert.ok(!s.includes('SECRET-KEY-VALUE'));
    assert.ok(!s.includes('abc'), 'fingerprint is not part of the overview');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('ok: connected, nothing waiting; lastContactAt = the later of push/pull', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', String(1e9)); // everything counted as sent
    const o: any = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    assert.equal(o.health, 'ok');
    assert.equal(o.lastContactAt, '2026-10-04T10:05:00Z');
    assert.deepEqual(o.sharedModules, ['portfolio']);
    assert.equal(o.postOffice, 'https://192.168.0.104:7443');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('behind: changes in a SHARED module are waiting; private-module changes do not count', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', '0');
    addEntry(t.db, { type: 'decision', title: 'private', summary: 's', module: 'secret' });
    assert.equal(unsentSharedCount(t.db), 0);
    addEntry(t.db, { type: 'decision', title: 'shared', summary: 's', module: 'portfolio' });
    assert.ok(unsentSharedCount(t.db) > 0);
    assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => true }) as any).health, 'behind');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('behind: courier offline, even with nothing waiting', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('offline', { lastError: 'ECONNREFUSED' }));
  try {
    shared(t, ['portfolio']);
    setSyncValue(t.db, 'sent_db_version', String(1e9));
    const o: any = readSyncOverview(t.db, { courierDir: dir, isAlive: () => true });
    assert.equal(o.health, 'behind');
    assert.equal(o.courier.lastError, 'ECONNREFUSED');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('a dead pid means not syncing, whatever status.json says', () => {
  const t = freshDb({ shared: true });
  const dir = courier(st('connected'));
  try {
    shared(t, ['portfolio']);
    assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => false }) as any).health, 'not-syncing');
  } finally { t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('needs-update and revoked pass through; missing status.json is unknown', () => {
  const t = freshDb({ shared: true });
  try {
    shared(t, ['portfolio']);
    for (const [state, health] of [['needs-update', 'needs-update'], ['revoked', 'revoked']] as const) {
      const dir = courier(st(state));
      assert.equal((readSyncOverview(t.db, { courierDir: dir, isAlive: () => true }) as any).health, health);
      rmSync(dir, { recursive: true, force: true });
    }
    const empty = courier(null);
    assert.equal((readSyncOverview(t.db, { courierDir: empty, isAlive: () => true }) as any).health, 'unknown');
    rmSync(empty, { recursive: true, force: true });
  } finally { t.cleanup(); }
});
```

Key names (`po_url`, `device_id`, `device_key`, `po_fingerprint`, `shared_modules`, `sent_db_version`) are the real `sync_state` keys on the user's notebook. Use the constants (`SYNC_KEYS`, `COURIER_KEYS`) in the implementation; check `freshDb({shared:true})` sets `enabled = '1'`, and if it does not, set it in `shared()`.

- [ ] **Step 2: Run to verify they fail** — `cd core && npx tsx --test test/sync-overview.test.ts` → FAIL (module not found).

- [ ] **Step 3: Move the courier paths into core**

Create `core/src/sync/courier-paths.ts` with the exact content of `courier/src/paths.ts` (header comment changed to `// file: core/src/sync/courier-paths.ts`). Replace `courier/src/paths.ts` with:

```ts
// file: courier/src/paths.ts
// Moved to core so the web server can read the courier's status without importing the courier.
export { courierDir, courierFiles, type CourierFiles } from "@collab-mcp/core";
```

Export it from `core/src/index.ts` (`export * from './sync/courier-paths.js';`).

- [ ] **Step 4: Implement `core/src/sync/overview.ts`**

```ts
// file: core/src/sync/overview.ts
import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../db.js";
import { getSyncValue, isSyncEnabled } from "./state.js";
import { readOwnChanges, entryUlidOf } from "./changes.js";
import { ensureCrsqlite } from "./extension.js";
import { courierDir as defaultCourierDir, courierFiles } from "./courier-paths.js";

// What the web UI's status bar shows (spec part 2, V1): read from THIS laptop
// only. Never returns the device key or any sync_state value not listed below.

export type SyncHealth = "ok" | "behind" | "not-syncing" | "needs-update" | "revoked" | "unknown";
export type SyncOverview =
  | { enabled: false }
  | {
      enabled: true;
      postOffice: string;
      deviceId: string;
      sharedModules: string[];
      unsent: number;
      courier: { running: boolean; state: string; lastError: string | null; lastPushAt: string | null; lastPullAt: string | null };
      lastContactAt: string | null;
      health: SyncHealth;
    };

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

function sharedSet(db: DB): Set<string> {
  try { return new Set(JSON.parse(getSyncValue(db, "shared_modules") ?? "[]") as string[]); } catch { return new Set(); }
}

/** This laptop's own changes since the sent-bookmark whose note's PRIMARY module is shared. */
export function unsentSharedCount(db: DB): number {
  if (!isSyncEnabled(db)) return 0;
  ensureCrsqlite(db);
  const shared = sharedSet(db);
  if (shared.size === 0) return 0;
  const since = Number(getSyncValue(db, "sent_db_version") ?? 0);
  const moduleOf = new Map<string, string | null>();
  let n = 0;
  for (const w of readOwnChanges(db, since)) {
    const pk = Buffer.from(w.pk, "base64");
    let module: string | null;
    if (w.table === "modules") {
      const r = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
      module = r ? String(r.cell) : null;
    } else {
      const ulid = entryUlidOf(db, w.table, pk);
      if (!ulid) continue;
      if (!moduleOf.has(ulid)) {
        const e = db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(ulid) as { module: string | null } | undefined;
        moduleOf.set(ulid, e?.module ?? null);
      }
      module = moduleOf.get(ulid) ?? null;
    }
    if (module && shared.has(module)) n++;
  }
  return n;
}

export function readSyncOverview(
  db: DB,
  opts: { courierDir?: string; isAlive?: (pid: number) => boolean } = {},
): SyncOverview {
  if (!isSyncEnabled(db)) return { enabled: false };
  const files = courierFiles(opts.courierDir ?? defaultCourierDir());
  const isAlive = opts.isAlive ?? defaultIsAlive;
  let st: any = null;
  try { st = existsSync(files.status) ? JSON.parse(readFileSync(files.status, "utf8")) : null; } catch { st = null; }
  let pid: number | null = null;
  try { pid = Number(readFileSync(files.pid, "utf8").trim()) || null; } catch { pid = st?.pid ?? null; }
  const running = pid !== null && isAlive(pid);
  const unsent = unsentSharedCount(db);
  const lastPushAt: string | null = st?.lastPushAt ?? null;
  const lastPullAt: string | null = st?.lastPullAt ?? null;
  const lastContactAt = [lastPushAt, lastPullAt].filter(Boolean).sort().pop() ?? null;
  const state: string = st?.state ?? "unknown";
  let health: SyncHealth;
  if (!st) health = "unknown";
  else if (!running) health = "not-syncing";
  else if (state === "needs-update") health = "needs-update";
  else if (state === "revoked") health = "revoked";
  else if (state === "offline" || state === "starting" || unsent > 0) health = "behind";
  else health = "ok";
  return {
    enabled: true,
    postOffice: getSyncValue(db, "po_url") ?? "",
    deviceId: getSyncValue(db, "device_id") ?? "",
    sharedModules: [...sharedSet(db)].sort(),
    unsent,
    courier: { running, state, lastError: st?.lastError ?? null, lastPushAt, lastPullAt },
    lastContactAt,
    health,
  };
}
```

(If `SYNC_KEYS`/`COURIER_KEYS` constants exist for these key names in core, use them instead of the string literals.) Export from `core/src/index.ts`: `export * from './sync/overview.js';`.

- [ ] **Step 5: The courier CLI uses it** — in `courier/src/cli.ts` `status`, replace `unsent = readOwnChanges(db, sent).length;` with `unsent = unsentSharedCount(db);` and change the printed line to `not yet sent: ${unsent} change(s) in shared modules`. Update any courier CLI test that asserts the old wording.

- [ ] **Step 6: Run** — `cd core && npx tsx --test test/sync-overview.test.ts` → PASS; build core + courier, `cd courier && npx tsx --test test/*.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/sync/courier-paths.ts core/src/sync/overview.ts core/src/index.ts core/test/sync-overview.test.ts courier/src/paths.ts courier/src/cli.ts courier/test
git commit -m "feat(sync): readSyncOverview for the web UI; unsent counts shared modules only"
```

---

### Task 4: Settling a conflict safely (version check + V9)

**Files:**
- Create: `core/src/ops/merge.ts`
- Modify: `core/src/ops/update.ts`, `core/src/ops/edit.ts`, `core/src/index.ts`
- Modify: `post-office/test/merge.test.ts` (callers of the changed API)
- Test: `post-office/test/merge-resolve.test.ts` (new; it lives in post-office because building a real flagged note needs the office's merge, and core cannot import post-office)

**Interfaces:**
- Produces:

```ts
export class VersionsChangedError extends Error {}   // name "VersionsChangedError"
export class NeedsMergeError extends Error { id: number }
export interface MergeVersion { rev_id: string; title: string; summary: string; description: string | null; author: string | null; created_at: string }
export interface MergeView { id: number; current: { title: string; summary: string; description: string | null }; heads: MergeVersion[] }
export function currentHeads(db: DB, ulid: string): string[];                      // sorted rev_ids
export function getMergeView(db: DB, id: number): MergeView;                       // throws if not flagged
export function resolveWithText(db: DB, a: { id: number; expectedHeads: string[]; title: string; summary: string; description: string | null }): { id: number };
export function resolveNeedsMerge(db: DB, id: number, expectedHeads: string[]): { id: number };  // signature CHANGED
```

- [ ] **Step 1: Write the failing tests**

The setup copies `machine`/`forkedPair` from `post-office/test/merge.test.ts` (they are not exported).

```ts
// file: post-office/test/merge-resolve.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, updateEntry, editEntry, resolveNeedsMerge, readOwnChanges, applyChanges, decodeChange, reindexFts,
  getMergeView, resolveWithText, currentHeads, VersionsChangedError, NeedsMergeError,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

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

/** A note whose title was edited to 'A' on one machine and 'B' on the other: flagged, two versions. Returns machine a's DB. */
async function flagged() {
  const s = tempStore();
  const a = machine('d-a'), b = machine('d-b');
  setAllocator({ allocate: async () => 10 });
  const { id } = await addEntryAsync(a.db, { type: 'decision', title: 't', summary: 's', description: 'x', module: 'm' });
  a.push(s.store); b.pull(s.store);
  updateEntry(a.db, { id, title: 'A' });
  updateEntry(b.db, { id, title: 'B' });
  a.push(s.store); b.push(s.store); a.pull(s.store);
  assert.equal((a.db.prepare('SELECT needs_merge FROM entries WHERE id = ?').get(id) as any).needs_merge, 1);
  return { db: a.db, id, cleanup: () => { setAllocator(null); a.cleanup(); b.cleanup(); s.cleanup(); } };
}

test('getMergeView lists every version with author and time', async () => {
  const f = await flagged();
  try {
    const v = getMergeView(f.db, f.id);
    assert.equal(v.heads.length, 2);
    assert.deepEqual(v.heads.map((h) => h.title).sort(), ['A', 'B']);
    assert.ok(v.heads.every((h) => typeof h.created_at === 'string' && 'author' in h));
  } finally { f.cleanup(); }
});

test('resolveWithText with the versions you saw: text saved, flag cleared, all versions folded in', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    resolveWithText(f.db, { id: f.id, expectedHeads: heads, title: 'A and B', summary: 's', description: null });
    const row = f.db.prepare('SELECT title, needs_merge, ulid FROM entries WHERE id = ?').get(f.id) as any;
    assert.equal(row.title, 'A and B');
    assert.equal(row.needs_merge, 0);
    assert.equal(currentHeads(f.db, row.ulid).length, 1, 'one version again');
  } finally { f.cleanup(); }
});

test('a changed set of versions is refused and nothing is written', async () => {
  const f = await flagged();
  try {
    const before = f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id);
    assert.throws(() => resolveWithText(f.db, { id: f.id, expectedHeads: ['not-a-real-rev'], title: 'X', summary: 's', description: null }), VersionsChangedError);
    assert.throws(() => resolveNeedsMerge(f.db, f.id, ['not-a-real-rev']), VersionsChangedError);
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    assert.throws(() => resolveWithText(f.db, { id: f.id, expectedHeads: heads.slice(0, 1), title: 'X', summary: 's', description: null }), VersionsChangedError, 'seeing only one of two versions is not enough');
    assert.deepEqual(f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id), before);
  } finally { f.cleanup(); }
});

test('resolveNeedsMerge with the versions you saw keeps the current text and clears the flag', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    const title = (f.db.prepare('SELECT title FROM entries WHERE id = ?').get(f.id) as any).title;
    resolveNeedsMerge(f.db, f.id, heads);
    const row = f.db.prepare('SELECT title, needs_merge FROM entries WHERE id = ?').get(f.id) as any;
    assert.deepEqual([row.title, row.needs_merge], [title, 0]);
  } finally { f.cleanup(); }
});

test('V9: an ordinary edit of a flagged note is refused with the merge link', async () => {
  const f = await flagged();
  try {
    const msg = new RegExp(`E-${String(f.id).padStart(5, '0')} needs a merge first: open /merge/${f.id} in the collab web UI`);
    assert.throws(() => updateEntry(f.db, { id: f.id, summary: 'sneaky' }), (e: any) => e instanceof NeedsMergeError && msg.test(e.message));
    assert.throws(() => editEntry(f.db, { id: f.id, type: 'decision', title: 'C', summary: 's', module: 'm' } as any), (e: any) => e instanceof NeedsMergeError && msg.test(e.message));
  } finally { f.cleanup(); }
});

test('getMergeView on a note that is not flagged throws a clear error', async () => {
  const f = await flagged();
  try {
    const heads = getMergeView(f.db, f.id).heads.map((h) => h.rev_id);
    resolveNeedsMerge(f.db, f.id, heads);
    assert.throws(() => getMergeView(f.db, f.id), /is not waiting for a merge/);
  } finally { f.cleanup(); }
});
```



- [ ] **Step 2: Run to verify they fail** — build core, then `cd post-office && npx tsx --test test/merge-resolve.test.ts` → FAIL (`getMergeView` not exported).

- [ ] **Step 3: Implement `core/src/ops/merge.ts`**

```ts
// file: core/src/ops/merge.ts
import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { ownerOf } from "../entry-write.js";
import { headsOf, revisionsOf, snapshotForRevision, finishRevision } from "../revisions.js";
import { ensureCrsqlite } from "../sync/extension.js";

// Settling a note whose edits collided (spec part 2, V4/V5). The caller says
// which versions it showed the person (expectedHeads); if another edit arrived
// meanwhile, nothing is written (VersionsChangedError -> HTTP 409).

export class VersionsChangedError extends Error {
  constructor(id: number) {
    super(`E-${String(id).padStart(5, "0")} changed while you were deciding; reload the versions`);
    this.name = "VersionsChangedError";
  }
}

export class NeedsMergeError extends Error {
  constructor(readonly id: number) {
    super(`E-${String(id).padStart(5, "0")} needs a merge first: open /merge/${id} in the collab web UI`);
    this.name = "NeedsMergeError";
  }
}

export interface MergeVersion { rev_id: string; title: string; summary: string; description: string | null; author: string | null; created_at: string }
export interface MergeView { id: number; current: { title: string; summary: string; description: string | null }; heads: MergeVersion[] }

export function currentHeads(db: DB, ulid: string): string[] {
  return headsOf(revisionsOf(db, ulid)).map((h) => h.rev_id).sort();
}

function flaggedUlid(db: DB, id: number): string {
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  const r = db.prepare(`SELECT needs_merge FROM entries WHERE ulid = ?`).get(owner.ulid) as { needs_merge: number } | undefined;
  if (!r || r.needs_merge !== 1) throw new Error(`E-${id} is not waiting for a merge`);
  return owner.ulid as string;
}

/** Throws VersionsChangedError unless the note's versions are exactly `expected`. */
export function assertHeads(db: DB, id: number, ulid: string, expected: string[]): void {
  const now = currentHeads(db, ulid);
  const want = [...new Set(expected)].sort();
  if (now.length !== want.length || now.some((h, i) => h !== want[i])) throw new VersionsChangedError(id);
}

export function getMergeView(db: DB, id: number): MergeView {
  const ulid = flaggedUlid(db, id);
  const cur = db.prepare(`SELECT title, summary, description FROM entries WHERE ulid = ?`).get(ulid) as MergeView["current"];
  const heads = headsOf(revisionsOf(db, ulid)).map((h) => ({
    rev_id: h.rev_id, title: h.title, summary: h.summary, description: h.description, author: h.author ?? null, created_at: h.created_at,
  }));
  return { id, current: cur, heads };
}

/** Pick a version or save a hand-combined text. Any write here settles the flag (finishRevision folds every head). */
export function resolveWithText(
  db: DB,
  a: { id: number; expectedHeads: string[]; title: string; summary: string; description: string | null },
): { id: number } {
  ensureCrsqlite(db);
  if (!a.title?.trim()) throw new Error("title cannot be blank");
  if (!a.summary?.trim()) throw new Error("summary cannot be blank");
  if (a.summary.length > 200) throw new Error(`summary exceeds 200 chars (got ${a.summary.length})`);
  db.transaction(() => {
    const ulid = flaggedUlid(db, a.id);
    assertHeads(db, a.id, ulid, a.expectedHeads);
    const before = snapshotForRevision(db, ulid);
    db.prepare(
      `UPDATE entries SET title = ?, summary = ?, description = ?, tokens_estimate = ? WHERE ulid = ?`,
    ).run(a.title, a.summary, a.description, estimateTokens(a.description), ulid);
    finishRevision(db, before);
  })();
  return { id: a.id };
}
```

- [ ] **Step 4: Change `resolveNeedsMerge` and add V9 (`core/src/ops/update.ts`, `core/src/ops/edit.ts`)**

In `update.ts`, `import { assertHeads, NeedsMergeError } from "./merge.js";` and replace `resolveNeedsMerge` with:

```ts
export function resolveNeedsMerge(db: DB, id: number, expectedHeads: string[]): { id: number } {
  ensureCrsqlite(db);
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  db.transaction(() => {
    const before = snapshotForRevision(db, owner.ulid as string);
    if (!before || before.needs_merge !== 1) throw new Error(`E-${id} is not waiting for a merge`);
    assertHeads(db, id, owner.ulid as string, expectedHeads);
    finishRevision(db, before);
  })();
  return { id };
}
```

In `updateEntry`'s transaction, right after `const before = ...snapshotForRevision(...)`, add `if (before?.needs_merge === 1) throw new NeedsMergeError(args.id);`. Do the same in `editEntry` (`core/src/ops/edit.ts`) right after its `const before = ...` line, using its id variable. (merge.ts imports from update.ts? It must NOT, to avoid a cycle: merge.ts imports only revisions/entry-write/db/extension, as written.)

Export from `core/src/index.ts`: `export * from './ops/merge.js';`.

- [ ] **Step 5: Update callers of the changed API** — in `post-office/test/merge.test.ts`: `resolveNeedsMerge(a.db, id)` becomes `resolveNeedsMerge(a.db, id, getMergeView(a.db, id).heads.map((h) => h.rev_id))`; the test that settles a flagged note by an ordinary `updateEntry` (around line 77, "line ONE (both)") must use `resolveWithText` with the current heads instead (that is now the only way, V9). Search the whole repo for other `resolveNeedsMerge(` and `updateEntry(` calls on flagged notes (`grep -rn "resolveNeedsMerge(" --include=*.ts .`) and update them the same way.

- [ ] **Step 6: Run** — `cd core && npx tsx --test test/merge-resolve.test.ts test/sync-revisions.test.ts test/write-paths-0006.test.ts`; build core; `cd post-office && npx tsx --test test/merge.test.ts`; `cd courier && npx tsx --test test/acceptance.test.ts` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/ops/merge.ts core/src/ops/update.ts core/src/ops/edit.ts core/src/index.ts post-office/test/merge-resolve.test.ts post-office/test/merge.test.ts
git commit -m "feat(sync): settle conflicts with a version check; ordinary edits of a flagged note are refused (V9)"
```

---

### Task 5: Web server routes `/api/sync/*`

**Files:**
- Create: `server/src/tools/sync.ts`
- Modify: `server/src/server.ts`, `server/src/tools/collab.ts`
- Test: `test/api.sync.test.mts` (new)

**Interfaces:**
- Consumes: `readSyncOverview`, `getMergeView`, `resolveWithText`, `resolveNeedsMerge`, `VersionsChangedError`, `NeedsMergeError` (core); `callGroq`, `testHooks` (`server/src/tools/ai.ts`).
- Produces (HTTP):
  - `GET /api/sync/status` → `SyncOverview`
  - `GET /api/sync/needs-merge` → `{ results: Array<{ id, title, module, type, updated_at }> }`
  - `GET /api/sync/versions?id=N` → `MergeView` | 404 `{error}`
  - `POST /api/sync/resolve` body `{ id, expectedHeads: string[], choice: "keep-current" | { title, summary, description } }` → 200 `{ ok: true, id }` | 409 `{ error: "versions-changed" }` | 400/404 `{ error }`
  - `POST /api/sync/explain` body `{ id }` → `{ text }` | 503 `{ error: "ai-unavailable" }`
  - `GET /api/collab/modules` rows gain `shared: boolean` when sharing is on (absent when off).
  - `POST /api/collab/entry/upsert` on a flagged note → 409 `{ error: <NeedsMergeError message> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// file: test/api.sync.test.mts
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv: any;
before(async () => { srv = await startTestServer({ level: '0006' }); });
after(() => srv.close());

const get = async (p: string) => { const r = await fetch(srv.baseUrl + p); return { status: r.status, body: await r.json() }; };
const post = async (p: string, b: unknown) => { const r = await fetch(srv.baseUrl + p, { method: 'POST', body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('status on an unshared notebook is { enabled: false }', async () => {
  const r = await get('/api/sync/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: false });
});

test('needs-merge lists a flagged SESSION-NOTE (search filters do not hide it)', async () => {
  const id = await seedEntry(srv.db, { type: 'session-note', category: 'Activity', title: 'flagged log', module: 'm' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await get('/api/sync/needs-merge');
  assert.ok(r.body.results.some((x: any) => x.id === id && x.title === 'flagged log'));
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('versions of a note that is not flagged -> 404', async () => {
  const id = await seedEntry(srv.db, { title: 'calm' });
  assert.equal((await get(`/api/sync/versions?id=${id}`)).status, 404);
});

test('resolve with stale versions -> 409 versions-changed; bad body -> 400', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await post('/api/sync/resolve', { id, expectedHeads: ['stale'], choice: 'keep-current' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'versions-changed' });
  assert.equal((await post('/api/sync/resolve', { id })).status, 400);
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('upsert of a flagged note is refused with the merge link (V9)', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged2' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await post('/api/collab/entry/upsert', { id, type: 'decision', title: 'x', summary: 'y' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /needs a merge first: open \/merge\//);
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('explain without an AI key -> 503 ai-unavailable', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged3' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const saved = [process.env.GROQ_API_KEY, process.env.GROK_API_KEY];
  delete process.env.GROQ_API_KEY; delete process.env.GROK_API_KEY;
  const r = await post('/api/sync/explain', { id });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'ai-unavailable' });
  [process.env.GROQ_API_KEY, process.env.GROK_API_KEY] = saved as any;
});
```

(A note flagged directly with `UPDATE … needs_merge = 1` has one head, so the "stale" expectedHeads differs and 409 is right. The full two-version path is covered in core Task 4 and by hand in Task 9.)

- [ ] **Step 2: Run to verify they fail** — build server; `npx tsx --test test/api.sync.test.mts` → FAIL (404 on `/api/sync/*`).

- [ ] **Step 3: Implement `server/src/tools/sync.ts`**

```ts
// file: server/src/tools/sync.ts
import http from 'node:http';
import {
  getDb, readSyncOverview, getMergeView, resolveWithText, resolveNeedsMerge,
  VersionsChangedError, liveEntry,
} from '@collab-mcp/core';
import { callGroq } from './ai.js';

// Web UI part 2: sync health and settling conflicts. Read-only except resolve.
const db = getDb();

type Send = (status: number, body: any) => void;
const idParam = (req: http.IncomingMessage) => Number(new URL(req.url!, 'http://x').searchParams.get('id'));

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/sync/status': async (_req, _res, send) => send(200, readSyncOverview(db)),

  'GET /api/sync/needs-merge': async (_req, _res, send) => {
    const has = db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get();
    if (!has) return send(200, { results: [] });
    const rows = db.prepare(
      `SELECT e.id, e.title, e.module, e.type, e.updated_at FROM entries e
        WHERE e.needs_merge = 1 AND e.deprecated = 0 AND ${liveEntry(db, 'e')} ORDER BY e.id`,
    ).all();
    send(200, { results: rows });
  },

  'GET /api/sync/versions': async (req, _res, send) => {
    const id = idParam(req);
    if (!Number.isInteger(id) || id < 1) return send(400, { error: 'id must be a positive integer' });
    try { send(200, getMergeView(db, id)); }
    catch (e: any) { send(404, { error: e.message }); }
  },

  'POST /api/sync/resolve': async (_req, _res, send, body) => {
    const { id, expectedHeads, choice } = body ?? {};
    if (!Number.isInteger(id) || !Array.isArray(expectedHeads) || choice === undefined) {
      return send(400, { error: 'body must be { id, expectedHeads: string[], choice }' });
    }
    try {
      if (choice === 'keep-current') resolveNeedsMerge(db, id, expectedHeads);
      else resolveWithText(db, { id, expectedHeads, title: choice?.title, summary: choice?.summary, description: choice?.description ?? null });
      send(200, { ok: true, id });
    } catch (e: any) {
      if (e instanceof VersionsChangedError) return send(409, { error: 'versions-changed' });
      if (/no entry found|not waiting for a merge/.test(e.message)) return send(404, { error: e.message });
      send(400, { error: e.message });
    }
  },

  'POST /api/sync/explain': async (_req, _res, send, body) => {
    let view;
    try { view = getMergeView(db, Number(body?.id)); } catch (e: any) { return send(404, { error: e.message }); }
    const versions = view.heads
      .map((h, i) => `Version ${i + 1} (by ${h.author ?? 'unknown'}, ${h.created_at})\nTitle: ${h.title}\nSummary: ${h.summary}\nDescription: ${h.description ?? ''}`)
      .join('\n\n');
    try {
      const text = await callGroq([
        { role: 'system', content: 'Two or more people edited the same note at the same time. Describe, neutrally and briefly, what differs between the versions and what each one says. Never recommend, rank or choose a version; the person decides.' },
        { role: 'user', content: versions },
      ], { temperature: 0.1 });
      send(200, { text });
    } catch {
      send(503, { error: 'ai-unavailable' });
    }
  },
};
```

If `liveEntry` is not exported from core or has a different signature, use the same expression `runSearch` uses in `server/src/tools/collab.ts`.

- [ ] **Step 4: Mount, modules flag, V9 on upsert**

`server/src/server.ts`: `import * as sync from './tools/sync.js';` and add `...sync.routes,` to `routes`.

`server/src/tools/collab.ts` `GET /api/collab/modules`: after reading rows, add

```ts
      const overview = readSyncOverview(db);
      const shared = overview.enabled ? new Set(overview.sharedModules) : null;
      send(200, { results: shared ? rows.map((r: any) => ({ ...r, shared: shared.has(r.slug) })) : rows });
```

(import `readSyncOverview`). In `POST /api/collab/entry/upsert`'s catch, map `NeedsMergeError` (import from core) to `send(409, { error: err.message })` before the generic error branch.

- [ ] **Step 5: Run** — `npm -w @collab-mcp/core run build && npm -w @collab-mcp/server run build && npx tsx --test test/api.sync.test.mts` → PASS; then the whole root suite `npx tsx --test test/**/*.test.mts` → only the 4 known golden failures.

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/sync.ts server/src/server.ts server/src/tools/collab.ts test/api.sync.test.mts
git commit -m "feat(web): /api/sync routes (status, needs-merge, versions, resolve, explain); modules carry 'shared'"
```

---

### Task 6: Status bar, Needs-merge menu item and list

**Files:**
- Create: `ui/src/sync/view.ts`, `ui/src/sync/view.test.ts`, `ui/src/components/SyncBar.tsx`, `ui/src/pages/NeedsMerge.tsx`
- Modify: `ui/src/api/client.ts`, `ui/src/components/AppShell.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/App.tsx`

**Interfaces:**
- Produces (`ui/src/api/client.ts`): types `SyncOverview`, `MergeVersion`, `MergeView`, `NeedsMergeRow`; functions `syncStatus()`, `needsMerge()`, `mergeVersions(id)`, `resolveMerge(id, expectedHeads, choice)`, `explainMerge(id)`; `VERSIONS_CHANGED = 'versions-changed'`.
- Produces (`ui/src/sync/view.ts`): `barView(o: SyncOverview, now: Date): null | { tone: 'ok'|'warn'|'bad'; text: string; fix: string | null }`, `ago(iso: string | null, now: Date): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// file: ui/src/sync/view.test.ts
import { describe, it, expect } from 'vitest';
import { barView, ago } from './view';

const now = new Date('2026-10-04T10:10:00Z');
const base = {
  enabled: true as const, postOffice: 'https://x:7443', deviceId: 'd', sharedModules: ['portfolio'], unsent: 0,
  courier: { running: true, state: 'connected', lastError: null, lastPushAt: '2026-10-04T10:09:48Z', lastPullAt: null },
  lastContactAt: '2026-10-04T10:09:48Z', health: 'ok' as const,
};

describe('barView', () => {
  it('sharing off: no bar', () => expect(barView({ enabled: false }, now)).toBeNull());
  it('ok', () => expect(barView(base, now)).toEqual({ tone: 'ok', text: '● Sharing on · last contact 12 s ago · nothing waiting to send', fix: null }));
  it('behind with waiting changes', () =>
    expect(barView({ ...base, health: 'behind', unsent: 3, lastContactAt: '2026-10-04T10:06:00Z', courier: { ...base.courier, state: 'offline' } }, now))
      .toEqual({ tone: 'warn', text: '● Behind · last contact 4 min ago · 3 changes waiting to send · the courier is retrying', fix: null }));
  it('one change uses the singular', () =>
    expect(barView({ ...base, health: 'behind', unsent: 1 }, now)!.text).toContain('1 change waiting to send'));
  it('not syncing', () =>
    expect(barView({ ...base, health: 'not-syncing', unsent: 12 }, now))
      .toEqual({ tone: 'bad', text: '● Not syncing · the courier is not running · 12 changes waiting', fix: 'how to fix: run collab sync start' }));
  it('needs update', () =>
    expect(barView({ ...base, health: 'needs-update', courier: { ...base.courier, state: 'needs-update', lastError: 'update this laptop: the post office is on 0009_x, this notes DB is on 0008_revision_author' } }, now))
      .toEqual({ tone: 'bad', text: '● Not syncing · update this laptop: the post office is on 0009_x, this notes DB is on 0008_revision_author', fix: 'how to fix: git pull, npm run build, npm run migrate, then restart collab' }));
  it('revoked', () =>
    expect(barView({ ...base, health: 'revoked' }, now)!.text).toBe('● Not syncing · this laptop was removed from the team · ask the post office owner for a new join code'));
  it('unknown never looks healthy', () =>
    expect(barView({ ...base, health: 'unknown' }, now)).toEqual({ tone: 'bad', text: '● Sync status unknown', fix: 'how to fix: run collab sync status in a terminal' }));
});

describe('ago', () => {
  it('seconds, minutes, hours, never', () => {
    expect(ago('2026-10-04T10:09:48Z', now)).toBe('12 s ago');
    expect(ago('2026-10-04T10:06:00Z', now)).toBe('4 min ago');
    expect(ago('2026-10-04T07:10:00Z', now)).toBe('3 h ago');
    expect(ago(null, now)).toBe('never');
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `cd ui && npx vitest run src/sync/view.test.ts` → FAIL.

- [ ] **Step 3: Implement `ui/src/sync/view.ts` (this task's part)**

```ts
// file: ui/src/sync/view.ts
import type { SyncOverview } from '../api/client';

// Pure view logic for sync in the web UI (spec part 2). Components stay thin;
// this file is what the tests pin down. Plain words, no sync jargon.

export function ago(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

export function barView(o: SyncOverview, now: Date): null | { tone: 'ok' | 'warn' | 'bad'; text: string; fix: string | null } {
  if (!o.enabled) return null;
  const contact = `last contact ${ago(o.lastContactAt, now)}`;
  switch (o.health) {
    case 'ok':
      return { tone: 'ok', text: `● Sharing on · ${contact} · nothing waiting to send`, fix: null };
    case 'behind': {
      const parts = ['● Behind', contact];
      parts.push(o.unsent > 0 ? `${changes(o.unsent)} waiting to send` : 'nothing waiting to send');
      if (o.courier.state === 'offline' || o.courier.state === 'starting') parts.push('the courier is retrying');
      return { tone: 'warn', text: parts.join(' · '), fix: null };
    }
    case 'not-syncing':
      return { tone: 'bad', text: `● Not syncing · the courier is not running · ${changes(o.unsent)} waiting`, fix: 'how to fix: run collab sync start' };
    case 'needs-update':
      return { tone: 'bad', text: `● Not syncing · ${o.courier.lastError ?? 'update this laptop'}`, fix: 'how to fix: git pull, npm run build, npm run migrate, then restart collab' };
    case 'revoked':
      return { tone: 'bad', text: '● Not syncing · this laptop was removed from the team · ask the post office owner for a new join code', fix: null };
    default:
      return { tone: 'bad', text: '● Sync status unknown', fix: 'how to fix: run collab sync status in a terminal' };
  }
}
```

- [ ] **Step 4: Client calls (`ui/src/api/client.ts`)**, append:

```ts
// --- Sync (web UI part 2) ---
export type SyncOverview =
  | { enabled: false }
  | {
      enabled: true; postOffice: string; deviceId: string; sharedModules: string[]; unsent: number;
      courier: { running: boolean; state: string; lastError: string | null; lastPushAt: string | null; lastPullAt: string | null };
      lastContactAt: string | null;
      health: 'ok' | 'behind' | 'not-syncing' | 'needs-update' | 'revoked' | 'unknown';
    };
export interface MergeVersion { rev_id: string; title: string; summary: string; description: string | null; author: string | null; created_at: string }
export interface MergeView { id: number; current: { title: string; summary: string; description: string | null }; heads: MergeVersion[] }
export interface NeedsMergeRow { id: number; title: string; module: string | null; type: string; updated_at: string }
export type MergeChoice = 'keep-current' | { title: string; summary: string; description: string | null };
export const VERSIONS_CHANGED = 'versions-changed';

export const syncStatus = () => getJson<SyncOverview>('/api/sync/status');
export const needsMerge = () => getJson<{ results: NeedsMergeRow[] }>('/api/sync/needs-merge');
export const mergeVersions = (id: number) => getJson<MergeView>(`/api/sync/versions${qs({ id: String(id) })}`);
export const resolveMerge = (id: number, expectedHeads: string[], choice: MergeChoice) =>
  postJson<{ ok: true; id: number }>('/api/sync/resolve', { id, expectedHeads, choice });
export const explainMerge = (id: number) => postJson<{ text: string }>('/api/sync/explain', { id });
```

(`postJson` throws with the server's `error` string, so a 409 surfaces as `Error('versions-changed')`.)

- [ ] **Step 5: Components**

```tsx
// file: ui/src/components/SyncBar.tsx
import { useEffect, useState } from 'react';
import { syncStatus, type SyncOverview } from '../api/client';
import { barView } from '../sync/view';

const TONE = {
  ok: 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  bad: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
} as const;

/** Thin bar on every page (user chose A). Polls every 10 s and on focus. Hidden when sharing is off. */
export default function SyncBar() {
  const [o, setO] = useState<SyncOverview | null>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    let alive = true;
    const load = () => syncStatus().then((x) => { if (alive) { setO(x); setNow(new Date()); } }).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    window.addEventListener('focus', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', load); };
  }, []);
  const v = o ? barView(o, now) : null;
  if (!v) return null;
  return (
    <div role="status" className={`px-4 py-1.5 text-xs flex justify-between gap-4 ${TONE[v.tone]}`}>
      <span>{v.text}{v.fix ? <> · <code>{v.fix}</code></> : null}</span>
      {o?.enabled && <span className="opacity-70">shared: {o.sharedModules.join(', ') || 'none'}</span>}
    </div>
  );
}
```

```tsx
// file: ui/src/pages/NeedsMerge.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { needsMerge, type NeedsMergeRow } from '../api/client';

export default function NeedsMerge() {
  const [rows, setRows] = useState<NeedsMergeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { needsMerge().then((r) => setRows(r.results)).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="text-red-600">{error}</p>;
  if (!rows) return <p className="text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Needs merge</h1>
      <p className="text-sm text-gray-500">Two people changed these notes at the same time. Nothing was lost; pick the final text for each.</p>
      {rows.length === 0 ? <p>Nothing to merge.</p> : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((r) => (
            <li key={r.id} className="py-2 flex justify-between">
              <Link to={`/merge/${r.id}`} className="underline">E-{String(r.id).padStart(5, '0')} · {r.title}</Link>
              <span className="text-xs text-gray-500">{r.module ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`AppShell.tsx`: `import SyncBar from './SyncBar';` and render `<SyncBar />` right after `<KeyMissingNotice />` (before `<header>`).

`Sidebar.tsx`: fetch the count on mount and every 30 s with `needsMerge()`; when `count > 0`, render one more `NavLink` to `/needs-merge` labelled `Needs merge` with a badge `<span className="ml-2 rounded-full bg-amber-400 text-black px-2 text-xs">{count}</span>`, after the existing links. Keep `links` as is.

`App.tsx`: add `<Route path="/needs-merge" element={<NeedsMerge />} />` (import it).

- [ ] **Step 6: Run** — `cd ui && npx vitest run && npx tsc -b --noEmit` → PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/sync ui/src/api/client.ts ui/src/components/SyncBar.tsx ui/src/pages/NeedsMerge.tsx ui/src/components/AppShell.tsx ui/src/components/Sidebar.tsx ui/src/App.tsx
git commit -m "feat(ui): sync status bar on every page; Needs merge list"
```

---

### Task 7: The Merge page

**Files:**
- Modify: `ui/src/sync/view.ts`, `ui/src/sync/view.test.ts`
- Create: `ui/src/pages/Merge.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Produces: `fieldDiff(heads: MergeVersion[]): { title: boolean; summary: boolean; description: boolean }` (true = differs), `versionLabel(v: MergeVersion, i: number): string`.

- [ ] **Step 1: Failing tests (append to `ui/src/sync/view.test.ts`)**

```ts
import { fieldDiff, versionLabel } from './view';

describe('merge view', () => {
  const v = (o: Partial<any>) => ({ rev_id: 'r', title: 'T', summary: 'S', description: 'D', author: 'naveen', created_at: '2026-10-04 15:35:22.949', ...o });
  it('fieldDiff marks only the fields that differ', () => {
    expect(fieldDiff([v({ summary: 'Edited on NAVEEN' }), v({ summary: 'Edited on RINKU' })])).toEqual({ title: false, summary: true, description: false });
    expect(fieldDiff([v({}), v({ description: null })]).description).toBe(true);
  });
  it('versionLabel shows number, author and time; unknown author says so', () => {
    expect(versionLabel(v({}), 0)).toBe('Version 1 · naveen · 15:35');
    expect(versionLabel(v({ author: null }), 1)).toBe('Version 2 · unknown author · 15:35');
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (append to `view.ts`):

```ts
import type { MergeVersion } from '../api/client';

export function fieldDiff(heads: MergeVersion[]): { title: boolean; summary: boolean; description: boolean } {
  const differs = (k: 'title' | 'summary' | 'description') => new Set(heads.map((h) => h[k] ?? '')).size > 1;
  return { title: differs('title'), summary: differs('summary'), description: differs('description') };
}

export function versionLabel(v: MergeVersion, i: number): string {
  const hhmm = /\d{2}:\d{2}/.exec(v.created_at)?.[0] ?? v.created_at;
  return `Version ${i + 1} · ${v.author ?? 'unknown author'} · ${hhmm}`;
}
```

(Merge the `import type` with the existing one at the top of the file.)

- [ ] **Step 4: The page**

```tsx
// file: ui/src/pages/Merge.tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { mergeVersions, resolveMerge, explainMerge, VERSIONS_CHANGED, type MergeView, type MergeVersion } from '../api/client';
import { fieldDiff, versionLabel } from '../sync/view';

type Draft = { title: string; summary: string; description: string | null };

/** /merge/:id (user chose its own page). Pick a version or combine by hand; refused if the versions changed meanwhile. */
export default function Merge() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [view, setView] = useState<MergeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    mergeVersions(id).then(setView).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const expected = () => view!.heads.map((h) => h.rev_id);
  async function save(choice: Draft) {
    setBusy(true);
    try {
      await resolveMerge(id, expected(), choice);
      navigate('/needs-merge');
    } catch (e: any) {
      if (e.message === VERSIONS_CHANGED) { setChanged(true); setDraft(null); load(); }
      else setError(e.message);
    } finally { setBusy(false); }
  }
  async function onExplain() {
    setExplain('…');
    try { setExplain((await explainMerge(id)).text); } catch { setExplain("couldn't explain"); }
  }

  if (error) return <p className="text-red-600">{error}</p>;
  if (!view) return <p className="text-gray-500">Loading…</p>;
  const diff = fieldDiff(view.heads);
  const field = (v: MergeVersion, k: 'title' | 'summary' | 'description', label: string) =>
    diff[k]
      ? <div><div className="text-xs font-semibold uppercase text-gray-400">{label}</div><div className="whitespace-pre-wrap">{v[k] ?? ''}</div></div>
      : <div className="text-xs text-gray-400">{label} · same in both</div>;

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 text-sm">
        ⚠ <b>Two people changed this note at the same time.</b> Nothing was lost. Pick the final text; the choice syncs to everyone.
      </div>
      {changed && (
        <div role="alert" className="p-3 rounded bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200 text-sm">
          <b>Someone changed this note while you were deciding.</b> Nothing was saved. Here are the versions now.
        </div>
      )}
      <h1 className="text-xl font-bold">E-{String(id).padStart(5, '0')}</h1>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(view.heads.length, 3)}, minmax(0, 1fr))` }}>
        {view.heads.map((v, i) => (
          <div key={v.rev_id} className="border border-gray-300 dark:border-gray-700 rounded p-3 space-y-3 text-sm">
            <div className="text-xs font-semibold text-gray-500">{versionLabel(v, i)}</div>
            {field(v, 'title', 'Title')}
            {field(v, 'summary', 'Summary')}
            {field(v, 'description', 'Description')}
            <button disabled={busy} onClick={() => save({ title: v.title, summary: v.summary, description: v.description })}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Use this version</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => { const v = view.heads[0]; setDraft({ title: v.title, summary: v.summary, description: v.description }); }}
          className="px-3 py-1.5 rounded border text-sm">Combine by hand…</button>
        <button onClick={onExplain} className="px-3 py-1.5 rounded border text-sm">✦ Explain the difference (AI)</button>
      </div>
      {explain && <p className="text-sm whitespace-pre-wrap border-l-2 pl-3 text-gray-600 dark:text-gray-300">{explain}</p>}
      {draft && (
        <div className="space-y-2 border rounded p-3">
          <input className="w-full border rounded px-2 py-1" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input className="w-full border rounded px-2 py-1" value={draft.summary} maxLength={200} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          <textarea className="w-full border rounded px-2 py-1 h-40" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <button disabled={busy} onClick={() => save(draft)} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Save combined text</button>
        </div>
      )}
      <p className="text-xs text-gray-500">The AI only explains the difference; it never picks a version.</p>
    </div>
  );
}
```

`App.tsx`: add `<Route path="/merge/:id" element={<Merge />} />`.

- [ ] **Step 5: Run** — `cd ui && npx vitest run && npx tsc -b --noEmit` → PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/sync ui/src/pages/Merge.tsx ui/src/App.tsx
git commit -m "feat(ui): /merge/:id page: pick or combine, refused safely when the versions changed"
```

---

### Task 8: Shared labels, flagged banner, save note

**Files:**
- Modify: `ui/src/sync/view.ts`, `ui/src/sync/view.test.ts`, `ui/src/pages/Modules.tsx`, `ui/src/components/EntryDrawer.tsx`, `ui/src/components/DraftCard.tsx`, `ui/src/api/client.ts` (Entry gains `author?: string | null; needs_merge?: number`)

**Interfaces:**
- Produces: `shareLabel(module: string | null | undefined, o: SyncOverview | null): null | 'shared' | 'private'`, `saveNote(module, o): string | null`, `SHARED_LABEL = '⇄ Shared with team'`, `PRIVATE_LABEL = '🔒 Only on this laptop'`, and a small hook `useSyncOverview()` in `ui/src/components/SyncBar.tsx`'s sibling `ui/src/sync/useSyncOverview.ts` (fetch once on mount; no polling).

- [ ] **Step 1: Failing tests (append)**

```ts
import { shareLabel, saveNote } from './view';

describe('sharing labels', () => {
  const on = { ...base, sharedModules: ['portfolio'] };
  it('labels only when sharing is on', () => {
    expect(shareLabel('portfolio', on)).toBe('shared');
    expect(shareLabel('custom-reports', on)).toBe('private');
    expect(shareLabel('portfolio', { enabled: false })).toBeNull();
    expect(shareLabel('portfolio', null)).toBeNull();
    expect(shareLabel(null, on)).toBe('private');
  });
  it('save note only for a shared module', () => {
    expect(saveNote('portfolio', on)).toBe('⇄ portfolio is shared: when you save, this note goes to everyone on the team.');
    expect(saveNote('custom-reports', on)).toBeNull();
    expect(saveNote('portfolio', { enabled: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `view.ts`:

```ts
export const SHARED_LABEL = '⇄ Shared with team';
export const PRIVATE_LABEL = '🔒 Only on this laptop';

export function shareLabel(module: string | null | undefined, o: SyncOverview | null): null | 'shared' | 'private' {
  if (!o || !o.enabled) return null;
  return module && o.sharedModules.includes(module) ? 'shared' : 'private';
}

export function saveNote(module: string | null | undefined, o: SyncOverview | null): string | null {
  return shareLabel(module, o) === 'shared' ? `⇄ ${module} is shared: when you save, this note goes to everyone on the team.` : null;
}
```

```ts
// file: ui/src/sync/useSyncOverview.ts
import { useEffect, useState } from 'react';
import { syncStatus, type SyncOverview } from '../api/client';

/** One read of the sync overview for labels and notes (the bar does its own polling). */
export function useSyncOverview(): SyncOverview | null {
  const [o, setO] = useState<SyncOverview | null>(null);
  useEffect(() => { syncStatus().then(setO).catch(() => setO(null)); }, []);
  return o;
}
```

- [ ] **Step 4: Wire the three places**
  - `Modules.tsx`: in the module list item, after the slug line, when `m.shared !== undefined` render a pill: `m.shared ? SHARED_LABEL : PRIVATE_LABEL` (blue pill for shared, gray for private).
  - `EntryDrawer.tsx`: `const sync = useSyncOverview();`. Under the title in the header, render one line: `E-xxxxx · {entry.type}` is already shown; add the label pill when `shareLabel(entry.module, sync)` is not null, plus `· by {entry.author}` when `entry.author`. Add an amber banner (same style as the existing superseded banner) when `entry.needs_merge === 1`: `⚠ This note needs a merge: two versions exist.` with a `Link` "Pick the final text" to `/merge/${entry.id}` that also calls `closeDrawer()`. In edit mode, above the Save button, render `saveNote(editData.module ?? entry.module, sync)` when not null (blue note). If saving returns an error whose message contains `needs a merge first`, show it as is (the server text tells the user where to go).
  - `DraftCard.tsx`: `const sync = useSyncOverview();` and above the "Approve & Save" button render `saveNote(edited.module, sync)` when not null.
  - `client.ts` `Entry`: add `author?: string | null; needs_merge?: number;` (the entry route already returns all columns; check `GET /api/collab/entry` returns them, and if it selects explicit columns, add `author` and `needs_merge` there in `server/src/tools/collab.ts`).

- [ ] **Step 5: Run** — `cd ui && npx vitest run && npx tsc -b --noEmit`; if `server/src/tools/collab.ts` changed, build server and run `npx tsx --test test/**/*.test.mts` (only the 4 known golden failures).

- [ ] **Step 6: Commit**

```bash
git add ui/src server/src/tools/collab.ts
git commit -m "feat(ui): shared/private labels, flagged-note banner, and a note before saving into a shared module"
```

---

### Task 9: Spec correction, rollout notes, final check

- [ ] In `docs/superpowers/specs/2026-10-04-collab-web-sync-visibility-design.md`, Components §3, replace the `health` bullet with the rule from this plan's Global Constraints (behind = unsent > 0 or courier offline/starting; age is information only; add `revoked`). Add a line under "Risks": "0008 is released, not staged: merged code migrates on the next `migrate`/web-server start; the schema guard pauses out-of-date laptops."
- [ ] In `README.md` (section `## Optional: the web UI`), add a 5-line "Updating a team after a migration" note: back up; post office laptop: pull, build, restart `collab-post-office serve` (it migrates its store); each laptop: pull, build, `npm run migrate`, restart the web server, the MCP connection and the courier; until a laptop is updated its bar says "update this laptop" and it neither sends nor receives.
- [ ] Builds: core, post-office, courier, mcp, server; then:
  - `cd core && npx tsx --test test/*.test.ts` → PASS
  - `cd post-office && npx tsx --test test/*.test.ts` → PASS
  - `cd courier && npx tsx --test test/*.test.ts` → PASS
  - `npx tsx --test test/**/*.test.mts` → only the 4 known golden failures
  - `cd ui && npx vitest run && npx tsc -b --noEmit` → PASS / clean
  - `npx tsc --noEmit -p server`, `-p core`, `-p post-office`, `-p courier` → clean
- [ ] Commit: `git commit -m "docs: part 2 spec correction (health rule) and migration rollout notes"`.
- [ ] `git log --oneline collabv1..HEAD` shows 9 commits; `git status` clean; nothing from `dist/`, `vendor/`, `.superpowers/` committed.
- [ ] Final report: commits, per-command results, every deviation with its reason (especially the Task 1 spike outcome: did begin/commit alter run inside the transaction?).

By-hand checks after merge (the user, two laptops): update the post office then both laptops in the README order; make a fresh conflict; settle it on NAVEEN's `/merge/:id`; RINKU gets the text with the flag cleared and the resolution's author recorded; then settle E-738 the same way.
