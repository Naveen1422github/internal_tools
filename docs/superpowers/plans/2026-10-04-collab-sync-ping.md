# Sync v1 follow-up: Saves Ping the Courier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Code-block convention:** as in Plans 2 and 3: a block whose first line is `// file: <path>` is the COMPLETE content of a new file. Edits to existing files are described in prose with the exact snippet.

**Goal:** The courier stops checking the DB 4x a second. Instead, every program that writes a shared notes DB tells the courier "something changed" with a one-byte local UDP ping sent after the save commits. The web server stops writing notes/modules with raw SQL (it calls core), and a guard test keeps it that way.

**Architecture:** `core/src/sync/ping.ts` adds `installSyncPing(db)`. On a DB that shares, it registers a JS function `collab_sync_ping()` on that connection, plus TEMP triggers (per connection, never stored in the file) AFTER INSERT/UPDATE/DELETE on the 5 synced tables. The triggers fire inside the transaction, so the function only queues. A `setImmediate` later waits until the transaction is finished, reads the courier's port from `sync_state.courier_port`, and sends one UDP datagram to `127.0.0.1:<port>`. `getDb` calls it, so the MCP server, the REST server and every script are covered with no per-call-site code. The courier binds a UDP socket on `127.0.0.1:0`, writes the port to `sync_state`, debounces pings 200 ms into a push, and deletes the port on stop.

**Tech Stack:** TypeScript 5.3, Node ≥ 20.9 (`node:dgram`), better-sqlite3 11 (`db.function`), cr-sqlite 0.16.3, node:test via tsx 4.

**Spec:** `docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md` (D4, Components 2 "Watch"). Decision: collab **E-720**, as amended by **E-722** (the temp-trigger choke point replaces the "ping inside each core op" idea). Background: E-716 (fs.watch fails on Windows), E-718/E-719.

**Worktree:** `C:/Users/NaveenPrajapati/Downloads/dev/wt-collab-sync-ping`, branch `collab-sync-ping` (from `collabv1` @ 1cb1956). `vendor/crsqlite/crsqlite.dll` is already copied in (never commit it). Run `npm install` at the worktree root once before Task 1.

## Global Constraints

- **Settled, never re-opened:** local-first SQLite; cr-sqlite replicates; post office allocates numbers; HTTPS + pinning; revoke ⇒ 401; idle = no NETWORK work.
- **A ping never slows down or breaks a save.** No await on a write path. Every socket error is swallowed. If setting up the ping hook fails in `getDb`, log one line to stderr and keep going.
- **The ping is only a hint.** The courier always pushes everything since its sent-bookmark, never "the note that pinged". A lost ping means delay, never loss. The courier pushes once after it starts listening (saves made while it was down or starting).
- **Never stored in the DB file:** only `CREATE TEMP TRIGGER`. A plain connection that never registered the function (a SQLite GUI, the post office, another tool) must still be able to write.
- **The courier's own connection never installs the hook.** Applying pulled changes must not ping itself. Neither does the post office store.
- **Bind to `127.0.0.1` only, never `0.0.0.0`** (no Windows firewall prompt, nothing off-machine).
- **Sharing OFF ⇒ zero behaviour change:** `installSyncPing` returns false and installs nothing.
- Windows is the real platform. No POSIX-only calls.
- Never commit `vendor/`, `dist/`, keys, certificates, join codes.
- Commits go on branch `collab-sync-ping` only. Never touch the `collabv1` worktree (`frontend2/internal-tools`), which is the user's tree.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `core/src/sync/ping.ts` | new | `COURIER_PORT_KEY`, `readCourierPort`, `sendCourierPing`, `installSyncPing` |
| `core/src/db.ts` | modify | `getDb` calls `installSyncPing` |
| `core/src/index.ts` | modify | export `./sync/ping.js` |
| `core/test/sync-ping.test.ts` | new | hook tests |
| `core/test/fixtures/ping-writer.ts` | new | short-lived child process for the "script writes and exits" test |
| `courier/src/engine.ts` | modify | UDP listener replaces the `data_version` poll |
| `courier/test/world.ts` | modify | `openWriter` installs the hook (as `getDb` does) |
| `courier/test/engine.test.ts` | modify | ping ⇒ push; port published and removed |
| `core/src/ops/edit.ts` | new | `editEntry`, `reassignModule` (moved from the REST server) |
| `core/src/ops/module.ts` | modify | `upsertModule`, `deleteModule` (moved from the REST server) |
| `core/test/ops-moved-writes.test.ts` | new | tests for the moved writes |
| `server/src/tools/collab.ts` | modify | 4 routes call core |
| `scratch-log-start.js` | delete | leftover script with raw INSERTs |
| `core/test/guard-writers.test.ts` | new | fails if code outside core writes a synced table |
| spec + `courier/src/engine.ts` header comment | modify | wording |

## Interfaces produced

- core: `COURIER_PORT_KEY = "courier_port"`; `readCourierPort(db): number | null`; `sendCourierPing(port: number): void`; `installSyncPing(db): boolean` (true = installed or already installed).
- core: `editEntry(db, args: EditEntryArgs): { id: number }`; `reassignModule(db, ids: number[], module: string): { updated: number }`; `upsertModule(db, args: UpsertModuleArgs): { slug: string }`; `deleteModule(db, slug: string): { deleted: true } | { deleted: false; entry_count: number; task_count: number }`; `EntryNotFoundError`.
- courier: `CourierOptions.pollMs` removed. `watch` now means "listen for save pings". `Courier.pingPort: number | null` (for tests and `status`).

## Review Focus

1. **A ping sent before the save is committed.** Triggers fire mid-transaction. A manual `BEGIN … await … COMMIT` must not ping until COMMIT, otherwise the courier reads, finds nothing, and the note waits for the next ping. Pinned in Task 1 (manual-transaction test).
2. **A short-lived script that writes and then exits normally** must still get its ping out (socket not unref'd before the send callback). Pinned in Task 1 (spawned child test). Accepted gap: a script that calls `process.exit()` right after writing drops the ping. Verified 2026-10-04 that today's scripts only `process.exit()` on error paths, before any write.
3. **`closeDb()` straight after a write** (parse-codex-output, log-collab): the deferred ping can no longer read `sync_state`, so it uses the port read at install / last ping. Pinned in Task 1.
4. **Courier restarted on a new port:** writers re-read the port at every ping. Pinned in Task 1 (port change test).
5. **The courier pinging itself** after applying pulled rows (loop) is impossible because its connection never installs the hook. Pinned in Task 2 (no push after a pull with nothing local).

---

### Task 1: The ping hook in core

**Files:**
- Create: `core/src/sync/ping.ts`, `core/test/sync-ping.test.ts`, `core/test/fixtures/ping-writer.ts`
- Modify: `core/src/db.ts` (`getDb`, right after the `loadCrsqlite` block), `core/src/index.ts`

**Interfaces:**
- Consumes: `SYNCED_TABLES` (`core/src/sync/enable.ts`), `getSyncValue`, `isSyncEnabled` (`core/src/sync/state.ts`), test helper `freshDb({ shared: true })` (`core/test/helpers/sync.ts`), `insertEntryRow` (`core/src/entry-write.ts`, needs `assigned: { ulid, id }` on a shared DB), `updateEntry`.
- Produces: `COURIER_PORT_KEY`, `readCourierPort`, `sendCourierPing`, `installSyncPing`.

- [ ] **Step 1: Write the failing tests**

```ts
// file: core/test/sync-ping.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createSocket, type Socket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { insertEntryRow } from '../src/entry-write.js';
import { updateEntry } from '../src/ops/update.js';
import { setSyncValue } from '../src/sync/state.js';
import { loadCrsqlite } from '../src/sync/extension.js';
import { COURIER_PORT_KEY, installSyncPing, readCourierPort } from '../src/sync/ping.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listener(): Promise<{ sock: Socket; port: number; hits: () => number; close: () => void }> {
  const sock = createSocket('udp4');
  let n = 0;
  sock.on('message', () => { n += 1; });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { sock, port: sock.address().port, hits: () => n, close: () => sock.close() };
}
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}
let seq = 0;
const row = (title: string) => {
  seq += 1;
  return { type: 'decision', kind: 'signal', title, summary: 's', description: 'd', status: 'active', agent: 'Claude',
    module: null, task_id: null, tokens_estimate: 1, assigned: { ulid: `01JPING0000000000000000${String(seq).padStart(3, '0')}`, id: 1000 + seq } };
};

test('sharing off: installs nothing, returns false', () => {
  const t = freshDb({ shared: false });
  try {
    assert.strictEqual(installSyncPing(t.db), false);
    const n = (t.db.prepare(`SELECT count(*) c FROM sqlite_temp_master WHERE type='trigger'`).get() as any).c;
    assert.strictEqual(n, 0);
  } finally { t.cleanup(); }
});

test('core insert, core edit, raw UPDATE and raw module INSERT each ping once, after the save', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    assert.strictEqual(installSyncPing(t.db), true);
    assert.strictEqual(installSyncPing(t.db), true, 'second call is a no-op');
    const { id } = insertEntryRow(t.db, row('a'));
    await until(() => l.hits() === 1);
    updateEntry(t.db, { id, title: 'b' }); // entries UPDATE x2 + revision INSERTs: ONE ping per burst
    await until(() => l.hits() === 2);
    t.db.exec(`UPDATE entries SET summary = 'raw' WHERE id = ${id}`);
    await until(() => l.hits() === 3);
    t.db.exec(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`);
    await until(() => l.hits() === 4);
    await sleep(100);
    assert.strictEqual(l.hits(), 4, 'no extra pings');
  } finally { l.close(); t.cleanup(); }
});

test('nothing is stored in the DB file; a plain connection without the function can still write', async () => {
  const t = freshDb({ shared: true });
  try {
    installSyncPing(t.db);
    const stored = (t.db.prepare(`SELECT count(*) c FROM main.sqlite_master WHERE type='trigger' AND sql LIKE '%collab_sync_ping%'`).get() as any).c;
    assert.strictEqual(stored, 0);
    const other = new Database(t.path);
    try {
      loadCrsqlite(other);
      other.exec(`INSERT INTO modules (slug, name) VALUES ('gui', 'written by another tool')`);
    } finally { try { other.prepare('SELECT crsql_finalize()').get(); } catch { /* closing */ } other.close(); }
  } finally { t.cleanup(); }
});

test('manual BEGIN … await … COMMIT: no ping until COMMIT', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    installSyncPing(t.db);
    t.db.exec('BEGIN');
    insertEntryRow(t.db, row('in-tx'));
    await sleep(150);
    assert.strictEqual(l.hits(), 0, 'pinged before commit');
    t.db.exec('COMMIT');
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});

test('closeDb straight after a write still pings (last known port)', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    installSyncPing(t.db);
    insertEntryRow(t.db, row('then-close'));
    t.db.prepare('SELECT crsql_finalize()').get();
    t.db.close();
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});

test('the port is re-read at every ping (courier restarted on a new port)', async () => {
  const t = freshDb({ shared: true });
  const l1 = await listener(), l2 = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l1.port));
    installSyncPing(t.db);
    insertEntryRow(t.db, row('one'));
    await until(() => l1.hits() === 1);
    setSyncValue(t.db, COURIER_PORT_KEY, String(l2.port));
    insertEntryRow(t.db, row('two'));
    await until(() => l2.hits() === 1);
    assert.strictEqual(l1.hits(), 1);
  } finally { l1.close(); l2.close(); t.cleanup(); }
});

test('no courier listening / no port: the save still succeeds', async () => {
  const t = freshDb({ shared: true });
  try {
    installSyncPing(t.db);
    assert.strictEqual(readCourierPort(t.db), null);
    insertEntryRow(t.db, row('nobody'));
    setSyncValue(t.db, COURIER_PORT_KEY, '1'); // a port nobody listens on
    insertEntryRow(t.db, row('closed-port'));
    await sleep(100);
  } finally { t.cleanup(); }
});

test('a separate script that writes and exits normally gets its ping out', async () => {
  const t = freshDb({ shared: true });
  const l = await listener();
  try {
    setSyncValue(t.db, COURIER_PORT_KEY, String(l.port));
    t.db.prepare('SELECT crsql_finalize()').get();
    t.db.close();
    const fixture = fileURLToPath(new URL('./fixtures/ping-writer.ts', import.meta.url));
    const code = await new Promise<number>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', fixture, t.path], { stdio: 'inherit', env: process.env });
      p.on('error', reject);
      p.on('exit', (c) => resolve(c ?? -1));
    });
    assert.strictEqual(code, 0);
    await until(() => l.hits() === 1);
  } finally { l.close(); t.cleanup(); }
});
```

```ts
// file: core/test/fixtures/ping-writer.ts
// A short-lived "script": opens a shared DB the way every tool does (getDb),
// writes one row, closes, and lets the process end on its own.
import { getDb, closeDb } from '../../src/db.js';

const db = getDb(process.argv[2]);
db.exec(`INSERT INTO modules (slug, name) VALUES ('from-script', 'written by a child process')`);
closeDb();
```

Note: `freshDb` runs `migrateTo('0007', { includeStaged: true })`. If `getDb` in the child refuses because the file is at a staged level, set `COLLAB_DB_CREATE` only if needed. First check what `getDb` does for an existing 0007 file. It should just open it.

- [ ] **Step 2: Run them to confirm they fail**

Run (in `core/`): `npx tsx --test test/sync-ping.test.ts`
Expected: FAIL, `Cannot find module '../src/sync/ping.js'`.

- [ ] **Step 3: Implement**

```ts
// file: core/src/sync/ping.ts
import { createSocket } from "node:dgram";
import type { DB } from "../db.js";
import { SYNCED_TABLES } from "./enable.js";
import { getSyncValue, isSyncEnabled } from "./state.js";

// Push on write (spec D4, collab E-720/E-722). A connection that writes a
// shared DB tells the courier "something changed" with one UDP byte to
// 127.0.0.1:<courier_port>. TEMP triggers (this connection only, never stored
// in the file) call a JS function registered on this connection, so every
// write path is covered: core ops, raw SQL, scripts. The ping is only a hint:
// the courier always pushes everything since its bookmark, so a lost ping
// costs delay, never data. It never blocks or fails a save.

/** sync_state key (local-only): the UDP port the courier listens on. Written by the courier. */
export const COURIER_PORT_KEY = "courier_port";
const FN = "collab_sync_ping";
const EVENTS = ["insert", "update", "delete"] as const;
const installed = new WeakSet<DB>();

export function readCourierPort(db: DB): number | null {
  const v = Number(getSyncValue(db, COURIER_PORT_KEY));
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
}

/** Fire-and-forget. The socket stays referenced until the send completes, so a script that ends normally still gets it out. */
export function sendCourierPing(port: number): void {
  const sock = createSocket("udp4");
  const close = () => { try { sock.close(); } catch { /* already closed */ } };
  sock.on("error", close);
  try { sock.send(Buffer.from([1]), port, "127.0.0.1", close); } catch { close(); }
}

/** Installs the hook on a connection to a shared DB. false = sharing is off, nothing installed. */
export function installSyncPing(db: DB): boolean {
  if (installed.has(db)) return true;
  if (!isSyncEnabled(db)) return false;
  let port = readCourierPort(db);
  let queued = false;
  const fire = (): void => {
    // Triggers fire inside the transaction: wait for it to end (COMMIT or ROLLBACK).
    if (db.open && db.inTransaction) { setTimeout(fire, 25); return; }
    queued = false;
    if (db.open) { try { port = readCourierPort(db); } catch { /* keep the last known port */ } }
    if (port) sendCourierPing(port);
  };
  db.function(FN, { deterministic: false }, () => {
    if (!queued) { queued = true; setImmediate(fire); }
    return null;
  });
  for (const t of SYNCED_TABLES) {
    for (const ev of EVENTS) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${FN}_${t}_${ev} AFTER ${ev.toUpperCase()} ON main.${t} BEGIN SELECT ${FN}(); END`);
    }
  }
  installed.add(db);
  return true;
}
```

In `core/src/db.ts` `getDb`, right after the `if (hasCrrTables(db)) { … loadCrsqlite … }` block and before `_db = db;`, add:

```ts
  // Push on write: tell the courier after each save (never blocks the save).
  try { installSyncPing(db); } catch (e) {
    console.error(`[collab-mcp] sync ping not installed (the courier will only catch up on restart): ${(e as Error).message}`);
  }
```

and import it: `import { installSyncPing } from "./sync/ping.js";`. Check that this import doesn't create a cycle that breaks loading: `sync/state.ts` only imports the `DB` type, and `enable.ts` is already imported by `db.ts`'s dependency graph. If a cycle error appears, move the call into a tiny `core/src/open-hooks.ts` imported by `db.ts`.

In `core/src/index.ts` add `export * from './sync/ping.js';` after `./sync/changes.js`.

- [ ] **Step 4: Run them to confirm they pass**

Run (in `core/`): `npx tsx --test test/sync-ping.test.ts` → all 8 PASS. Then the whole core suite: `npm test` → 198 + 8 pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add core/src/sync/ping.ts core/src/db.ts core/src/index.ts core/test/sync-ping.test.ts core/test/fixtures/ping-writer.ts
git commit -m "feat(core): saves ping the courier over local UDP via per-connection TEMP triggers (E-722)"
```

---

### Task 2: The courier listens instead of polling

**Files:**
- Modify: `courier/src/engine.ts`, `courier/test/world.ts`, `courier/test/engine.test.ts`

**Interfaces:**
- Consumes: `COURIER_PORT_KEY`, `installSyncPing` from `@collab-mcp/core` (Task 1); existing `setSyncValue`.
- Produces: `CourierOptions` without `pollMs`; `Courier.pingPort`.

- [ ] **Step 1: Write the failing tests** (append to `courier/test/engine.test.ts`, reusing its existing imports and helpers. Add `getSyncValue`, `COURIER_PORT_KEY`, `addEntryAsync` to the core import, and `startOffice`, `joinedDb`, `openWriter`, `closeWriter`, `until`, `tempDir` from `./world.js` if not already imported):

```ts
test('the courier publishes its ping port, a save pings it, the save is pushed; stop removes the port', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const j = await joinedDb(office, t.dir, 'a');
  const c = new Courier({ dbPath: j.path, retryMs: 60_000, maxReconnectMs: 200 });
  const w = openWriter(j.path);
  try {
    c.start();
    await until(() => c.status.state === 'connected' && c.pingPort !== null, 3000, 'connected + listening');
    assert.strictEqual(getSyncValue(w, COURIER_PORT_KEY), String(c.pingPort));
    const before = c.status.sentTotal;
    await addEntryAsync(w, { type: 'decision', title: 'pinged', summary: 's', module: 'team' });
    await until(() => c.status.sentTotal > before, 2000, 'the ping-triggered push');
  } finally {
    await c.stop();
    assert.strictEqual(getSyncValue(w, COURIER_PORT_KEY), null, 'stop removes the port');
    closeWriter(w); await office.close(); t.cleanup();
  }
});

test('applying pulled changes does not make the courier ping itself (no push request after a pull)', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const ca = new Courier({ dbPath: ja.path, retryMs: 60_000, maxReconnectMs: 200 });
  const cb = new Courier({ dbPath: jb.path, retryMs: 60_000, maxReconnectMs: 200 });
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  try {
    ca.start(); cb.start();
    await until(() => ca.status.state === 'connected' && cb.status.state === 'connected', 3000);
    const { id } = await addEntryAsync(wa, { type: 'decision', title: 'echo-check', summary: 's', module: 'team' });
    await until(() => wb.prepare('SELECT 1 FROM entries WHERE id = ?').get(id) !== undefined, 3000, 'B received');
    await new Promise((r) => setTimeout(r, 500));
    const bPushes = office.requests.filter((r) => r.device === jb.device && r.route.startsWith('POST /v1/changes')).length;
    assert.strictEqual(bPushes, 0, 'B pushed after only receiving');
  } finally { await ca.stop(); await cb.stop(); closeWriter(wa); closeWriter(wb); await office.close(); t.cleanup(); }
});
```

Before relying on `r.route.startsWith('POST /v1/changes')`, check how `onRequest` formats `route` in `post-office/src/server.ts` and match it exactly.

- [ ] **Step 2: Run to confirm failure**

Run (in `courier/`): `npx tsx --test test/engine.test.ts`
Expected: FAIL (`pingPort` undefined / no `courier_port` in sync_state).

- [ ] **Step 3: Implement**

In `courier/test/world.ts` `openWriter`, after `if (hasCrrTables(db)) loadCrsqlite(db);` add `installSyncPing(db);` (import it from `@collab-mcp/core`). Update its comment: "opened the way core's getDb opens one (cr-sqlite loaded, save ping installed when the DB shares)".

In `courier/src/engine.ts`:
1. Header comment: replace "Push on write (SQLite's data_version checked 4x a second, ~200 ms debounce)" with "Push on write (each save pings us over local UDP, ~200 ms debounce; collab E-722)".
2. `CourierOptions`: delete `pollMs` and its comment. Change the `watch` comment to `/** Listen for save pings (off in unit tests that drive push/pull by hand). */`.
3. Fields: delete `poller` and `lastDataVersion`. Add `private pingSock: Socket | null = null;` and `pingPort: number | null = null;` (public, read-only use). Import `createSocket, type Socket` from `node:dgram`, and `COURIER_PORT_KEY` from `@collab-mcp/core`.
4. Constructor defaults: remove `pollMs: 250`.
5. `start()`: `if (this.opt.watch) this.listen();` (replaces `this.watchDb()`).
6. `stop()`: replace `this.stopPolling();` with `this.closeListener();` (it must run BEFORE `closeDb`, which it already does in that position).
7. Replace the whole `watchDb` / `dataVersion` / `stopPolling` block (and its doc comment) with:

```ts
  /**
   * Push on write: every program that writes this DB pings us after its save
   * commits (core installSyncPing, collab E-722). Our own connection never
   * installs that hook, so applying pulled changes causes no ping (no echo).
   * Not fs.watch (misses writes on Windows, E-716), not polling.
   */
  private listen(): void {
    const sock = createSocket("udp4");
    this.pingSock = sock;
    sock.on("message", () => this.onPing());
    sock.on("error", (e) => this.log(`save-ping listener failed: ${e.message}`));
    sock.bind(0, "127.0.0.1", () => {
      if (this.stopped) return;
      this.pingPort = sock.address().port;
      try { setSyncValue(this.db, COURIER_PORT_KEY, String(this.pingPort)); }
      catch (e) { this.log(`could not publish the ping port: ${(e as Error).message}`); }
      void this.pushNow(); // saves made while we were down or starting
    });
  }

  private onPing(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.pushNow();
    }, this.opt.debounceMs);
  }

  private closeListener(): void {
    if (!this.pingSock) return;
    try { this.pingSock.close(); } catch { /* already closed */ }
    this.pingSock = null;
    this.pingPort = null;
    try { if (this.db.open) this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(COURIER_PORT_KEY); } catch { /* best effort */ }
  }
```

8. Search `courier/` for any remaining `pollMs` / `data_version` / `watchDb` reference (cli.ts, tests) and remove it.

- [ ] **Step 4: Run to confirm pass**

Run (in `courier/`): `npm test` → all pass, including `acceptance.test.ts` 9/9 and `live.test.ts` (its "idle = no work" test must still see 0 pending timers and no requests). Run `acceptance.test.ts` 3 times in a row: it must be green all 3 times.

- [ ] **Step 5: Commit**

```bash
git add courier/src/engine.ts courier/test/world.ts courier/test/engine.test.ts
git commit -m "feat(courier): listen for save pings on 127.0.0.1 UDP instead of polling data_version (E-722)"
```

---

### Task 3: The web server writes through core; delete the scratch script

The REST server writes notes and modules with its own SQL in 4 routes. Move that code into core unchanged, so every write lives in one place (revisions, checks, future rules). **Move, don't rewrite:** the HTTP responses must stay byte-for-byte the same.

**Files:**
- Create: `core/src/ops/edit.ts`, `core/test/ops-moved-writes.test.ts`
- Modify: `core/src/ops/module.ts`, `core/src/index.ts`, `server/src/tools/collab.ts` (routes `POST /api/collab/entry/upsert` edit branch ≈ lines 214-235, `POST /api/collab/entry/reassign-module` ≈ 276-312, `POST /api/collab/module/upsert` ≈ 362-382, `POST /api/collab/module/delete` ≈ 420-438)
- Delete: `scratch-log-start.js`

**Interfaces:**
- Consumes: `ownerOf`, `replaceLinks`, `insertEntryModules` (`entry-write.ts`), `snapshotForRevision`, `finishRevision` (`revisions.ts`), `hasUlidPrimaryKey` (`schema.ts`), `estimateTokens`, `validateEntryInput`, `KIND_BY_TYPE` (find where the server imports each of these and import from the same core module).
- Produces: `editEntry`, `EditEntryArgs`, `EntryNotFoundError`, `reassignModule`, `upsertModule`, `UpsertModuleArgs`, `deleteModule`.

- [ ] **Step 1: Write the failing tests**

```ts
// file: core/test/ops-moved-writes.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { editEntry, reassignModule, EntryNotFoundError } from '../src/ops/edit.js';
import { upsertModule, deleteModule } from '../src/ops/module.js';

test('editEntry rewrites fields + links and records a revision', () => {
  const t = freshDb();
  try {
    initModule(t.db, { slug: 'a' }); initModule(t.db, { slug: 'b' });
    const { id } = addEntry(t.db, { type: 'decision', title: 't1', summary: 's1', module: 'a' });
    const r = editEntry(t.db, { id, type: 'gotcha', title: 't2', summary: 's2', description: 'd2', agent: 'User',
      modules: ['b', 'a'], category: undefined, task_id: null, refs: [{ ref_type: 'url', ref_value: 'https://x' }] });
    assert.strictEqual(r.id, id);
    const e = t.db.prepare('SELECT type, title, module FROM entries WHERE id = ?').get(id) as any;
    assert.deepStrictEqual(e, { type: 'gotcha', title: 't2', module: 'b' });
    const revs = (t.db.prepare('SELECT count(*) c FROM entry_revisions').get() as any).c;
    assert.ok(revs >= 1, 'edit recorded a revision');
  } finally { t.cleanup(); }
});

test('editEntry: unknown id throws EntryNotFoundError; bad input throws before writing', () => {
  const t = freshDb();
  try {
    assert.throws(() => editEntry(t.db, { id: 999, type: 'decision', title: 't', summary: 's' }), EntryNotFoundError);
    const { id } = addEntry(t.db, { type: 'decision', title: 't', summary: 's' });
    assert.throws(() => editEntry(t.db, { id, type: 'decision', title: 't', summary: 'x'.repeat(201) }));
    assert.strictEqual((t.db.prepare('SELECT summary FROM entries WHERE id = ?').get(id) as any).summary, 's');
  } finally { t.cleanup(); }
});

test('reassignModule moves the primary module; unknown target throws', () => {
  const t = freshDb();
  try {
    initModule(t.db, { slug: 'a' }); initModule(t.db, { slug: 'b' });
    const { id } = addEntry(t.db, { type: 'decision', title: 't', summary: 's', module: 'a' });
    assert.deepStrictEqual(reassignModule(t.db, [id, id, 4242], 'b'), { updated: 1 });
    assert.strictEqual((t.db.prepare('SELECT module FROM entries WHERE id = ?').get(id) as any).module, 'b');
    assert.throws(() => reassignModule(t.db, [id], 'nope'), /target module 'nope' does not exist/);
  } finally { t.cleanup(); }
});

test('upsertModule inserts then updates; deleteModule refuses a module in use', () => {
  const t = freshDb();
  try {
    upsertModule(t.db, { slug: 'm', name: 'M' });
    upsertModule(t.db, { slug: 'm', name: 'M2', status: 'archived' });
    assert.deepStrictEqual(t.db.prepare('SELECT name, status FROM modules WHERE slug = ?').get('m'), { name: 'M2', status: 'archived' });
    assert.throws(() => upsertModule(t.db, { slug: 'Bad_Slug' }), /invalid slug/);
    addEntry(t.db, { type: 'decision', title: 't', summary: 's', module: 'm' });
    assert.deepStrictEqual(deleteModule(t.db, 'm'), { deleted: false, entry_count: 1, task_count: 0 });
    upsertModule(t.db, { slug: 'empty' });
    assert.deepStrictEqual(deleteModule(t.db, 'empty'), { deleted: true });
  } finally { t.cleanup(); }
});
```

Adjust `addEntry` calls if `freshDb()` (0007, not shared) needs the local allocator. It should, since sharing is off.

- [ ] **Step 2: Run to confirm failure**

Run (in `core/`): `npx tsx --test test/ops-moved-writes.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement by moving the server code**

Create `core/src/ops/edit.ts` with:
- `export class EntryNotFoundError extends Error` (message `entry ${id} not found`, name `EntryNotFoundError`).
- `export interface EditEntryArgs { id: number; type: string; title: string; summary: string; description?: string | null; agent?: string | null; module?: string | null; modules?: string[]; category?: string; task_id?: string | null; refs?: Array<{ ref_type?: string; ref_value?: string; type?: string; value?: string }> }`.
- `export function editEntry(db, args): { id: number }`. Its body is the server's edit path moved verbatim: `validateEntryInput` (throw `new Error(v.errors[0])` when not ok), `KIND_BY_TYPE`, the module ordering/dedupe (`moduleCandidates` → `orderedModules` → `primaryModule`), the `normRefs` mapping, `ownerOf` (throw `EntryNotFoundError` when null), and the transaction (snapshot → UPDATE → `replaceLinks` → `finishRevision`). Return `{ id: owner.id }`.
- `export function reassignModule(db, ids: number[], module: string): { updated: number }`. The server's reassign body moved verbatim. Throw `new Error(\`target module '${module}' does not exist\`)` when the module row is missing. De-duplicate ids. Skip ids with no owner.

In `core/src/ops/module.ts` add:
- `export interface UpsertModuleArgs { slug: string; name?: string | null; summary?: string | null; description?: string | null; current_goal?: string | null; status?: string }`
- `export function upsertModule(db, args): { slug: string }`: same `SLUG_REGEX` check and error text as `initModule`, then the server's `INSERT … ON CONFLICT(slug) DO UPDATE …` with `status || 'active'`. Pass `?? null` for the optional fields (the server passed `undefined` → better-sqlite3 binds that as NULL. Keep that behaviour).
- `export function deleteModule(db, slug): { deleted: true } | { deleted: false; entry_count: number; task_count: number }`: the server's count query. If either count > 0, return `{ deleted: false, … }`, else `DELETE` and return `{ deleted: true }`.

Export `./ops/edit.js` from `core/src/index.ts` (after `./ops/update.js`).

In `server/src/tools/collab.ts`:
- Edit branch of `entry/upsert`: keep the server's existing validation up front, so the 400 response is unchanged. Replace the `ownerOf` + `tx` block with `const r = editEntry(db, { id: Number(id), type, title, summary, description, agent, modules: orderedModules, category: resolvedCategory, task_id, refs: normRefs }); send(200, { ok: true, id: r.id });`. In the catch, map `EntryNotFoundError` to `send(404, { error: err.message })` (today's text is `entry ${id} not found`, which is the same).
- `reassign-module`: keep the 400 checks for `ids`/`module` shape. Then `try { const { updated } = reassignModule(db, ids, module); send(200, { ok: true, updated, module }); } catch (err) { send(/does not exist/.test(err.message) ? 400 : 500, { error: err.message }); }`.
- `module/upsert`: keep the slug 400 check. Replace the SQL with `upsertModule(db, { slug, name, summary, description, current_goal, status }); send(200, { ok: true, slug });`.
- `module/delete`: `const r = deleteModule(db, body.slug); if (!r.deleted) return send(409, { error: \`module '${body.slug}' has ${r.entry_count} entries and ${r.task_count} tasks. Reassign or delete those first.\`, entry_count: r.entry_count, task_count: r.task_count }); send(200, { ok: true });`.
- Remove imports that are now unused (`snapshotForRevision`, `finishRevision`, `insertEntryModules`, etc., only if nothing else in the file uses them).

Delete `scratch-log-start.js` (`git rm scratch-log-start.js`).

- [ ] **Step 4: Run to confirm pass**

Run (in `core/`): `npm test` → all pass. Run `npx tsc --noEmit -p server` (or the server's own tsc config) → clean. Run the mcp golden test (`npm --prefix mcp run test:golden`). The 4 failures that already exist (REST search snippet shows ULID; doctor table counts) are expected and must not grow.

- [ ] **Step 5: Commit**

```bash
git add core/src/ops/edit.ts core/src/ops/module.ts core/src/index.ts core/test/ops-moved-writes.test.ts server/src/tools/collab.ts
git rm scratch-log-start.js
git commit -m "refactor(server): REST note/module writes go through core (editEntry, reassignModule, upsertModule, deleteModule)"
```

---

### Task 4: Guard test: only core writes the synced tables

**Files:**
- Create: `core/test/guard-writers.test.ts`

- [ ] **Step 1: Write the test**

```ts
// file: core/test/guard-writers.test.ts
// Every write to a synced table goes through core (collab E-720): one place
// for revisions, input checks and future rules. This test fails if any code
// outside core writes one with its own SQL.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNCED_TABLES } from '../src/sync/enable.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // internal-tools/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-share', 'vendor', 'docs', 'test', 'tests', 'migrations']);
const ALLOWED = ['core/src/', 'post-office/src/']; // core itself; the post office's own store
const EXT = /\.(ts|js|mjs|cjs|py|sh)$/;
const WRITE = new RegExp(String.raw`\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(main\.)?(${SYNCED_TABLES.join('|')})\b`, 'i');

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (EXT.test(name)) yield p;
  }
}

test('no code outside core writes a synced table directly', () => {
  const offenders: string[] = [];
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f).split(sep).join('/');
    if (ALLOWED.some((a) => rel.startsWith(a))) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (WRITE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(offenders, [], `write through core instead (collab E-720):\n${offenders.join('\n')}`);
});
```

- [ ] **Step 2: Run it**

Run (in `core/`): `npx tsx --test test/guard-writers.test.ts` → PASS (Task 3 removed the offenders). Then check that it catches things: temporarily add the line `db.exec("UPDATE entries SET title = 'x'")` to `server/src/tools/collab.ts`, run it → FAIL naming that file:line. Revert the temporary line. If it reports a hit in an `mcp/src/scripts/rehearse-*` or similar one-off migration script, add that exact path to `ALLOWED` with a comment saying why. Do not widen the regex exclusions.

- [ ] **Step 3: Commit**

```bash
git add core/test/guard-writers.test.ts
git commit -m "test(core): guard that only core writes the synced tables (E-720)"
```

---

### Task 5: Spec wording + final verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md`

- [ ] **Step 1: Update the spec**
- D4 row (line ~18): change "Idle = no work." to "Idle = no work (no network, no timers; each save pings the courier over local UDP, collab E-722)."
- Components 2, the "**Watch:**" bullet (line ~44): replace it with: "**Save ping:** every connection that writes the shared notes DB (core `getDb` installs it) sends one UDP byte to `127.0.0.1:<courier_port>` after its save commits. The courier listens there, debounces ~200 ms, then reads `crsql_changes` since its last-sent `db_version`. It pushes once on start for anything it missed. File watching was dropped (misses writes on Windows, E-716). So was polling (E-720/E-722)."

- [ ] **Step 2: Full verification**

From the worktree root: core `npm test`, post-office `npm test`, courier `npm test` (acceptance 9/9, three runs), `npx tsc --noEmit` in core, server, courier, post-office, mcp, and the mcp golden test (only the 4 known failures). Check no leaked `node` processes are left over.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md
git commit -m "docs(sync): D4/Components 2: save ping replaces the watch (E-722)"
```

---

## Spec check (done before building)

| Requirement | Where |
|---|---|
| D4 push on write, ~200 ms debounce | Tasks 1, 2 |
| D4 idle = no work | Task 2 (`live.test.ts` idle test still green), Task 5 wording |
| Never blocks local work | Task 1 (no-courier test, try/catch in getDb) |
| No echo / loops | Task 2 (B never pushes after only receiving) |
| E-720: every writer goes through core, enforced | Tasks 3, 4 |
| Courier catch-up after downtime | Task 2 (`pushNow` after bind) + existing `syncNow` on connect |

## Decisions where the spec is silent (recorded)

1. Port: random free port per courier start (`127.0.0.1:0`), published in `sync_state.courier_port` and removed on stop. Writers re-read it at each ping. A fixed port would clash with a second courier for a second notes DB.
2. One ping per burst per connection (`queued` flag), not one per row.
3. A connection opened before sharing was enabled has no hook. `collab sync setup` already tells the user to restart those programs (Plan 3, gap 7).
4. Hand edits in a SQLite GUI don't ping. They go out with the next save from any tool, or on courier restart. Accepted (E-720).

## Out of scope

- Go-live (release 0007, post office on the main laptop, two-laptop test): unchanged, next after this merges.
- The REST search snippet showing a ULID, and the doctor golden counts: separate small fix.
