# Sync v1, Plan 3 of 3: The Courier, `collab sync`, and the Acceptance Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Code-block convention:** as in Plan 2: a block whose first line is `// file: <path>` is the COMPLETE content of a new file. Edits to existing files are described in prose with the exact snippet.

**Goal:** One small courier per machine that sends this machine's shared changes to the post office the moment they are saved, collects everyone else's when the doorbell rings, retries every 30 s when something is down, and does nothing when nothing changes; one plain command family (`collab sync setup/start/stop/status/autostart/uninstall`, plus `share`) that sets it up and takes it away without surprises; and the spec's 9 acceptance tests running two simulated machines and a post office in ONE process.

**Architecture:** A new workspace package `courier/` (`@collab-mcp/courier`, bin `collab`). `engine.ts` holds the `Courier` class: its own better-sqlite3 connection to the notes DB (cr-sqlite loaded), a directory watch on the DB and its WAL (200 ms debounce) that triggers a push, an SSE doorbell that triggers a pull, a 30 s retry timer that exists only after a failure, and a promise chain that serialises all network work. Push = this machine's OWN changes since its sent-bookmark, kept only if the entry's primary module is shared (team-wide list from the post office), sent in chunks; the bookmark advances only after every chunk is acknowledged. Pull = deliveries after the receive-bookmark, applied + FTS re-indexed + bookmark advanced in ONE transaction. `autostart.ts` builds a pure, testable plan per OS (Windows Task Scheduler XML via `%SystemRoot%\System32\schtasks.exe`, macOS LaunchAgent plist, Linux systemd user unit). `cli.ts` wires the commands. Core gains `disableSync` (for `uninstall`).

**Tech Stack:** TypeScript 5.3, Node ≥ 20.9 built-ins (`fs.watch`, `child_process`, `https` via core), better-sqlite3 11, cr-sqlite 0.16.3, node:test via tsx. No new third-party dependency.

**Spec:** `docs/superpowers/specs/2026-10-04-collab-team-sync-v1-design.md`: D4 (push on write, doorbell, 30 s retry, idle = no work), D5, D6 (one courier, opt-in autostart, prints what it installs, `uninstall`), D9, D10, D11, D12, D15; Components 2; Data flow; Failure table; Testing 1–9.

**Builds on Plan 2:** `readOwnChanges`, `applyChanges`, `entryUlidOf`, `reindexFts`, `requestJson`, `openEventStream`, `parseJoinCode`, `postOfficeTargetFromDb`, `SYNC_KEYS`, `enableSync`; post office `createStore`, `startPostOffice`, `addMember`, `setModuleShared`, `revokeMember`, `seedFromNotesDb`.

## Global Constraints

- Settled decisions as in Plan 2 (local-first SQLite, cr-sqlite replication, no LWW for text, numbers only from the post office, notes only, HTTPS + pinning, revoke ⇒ 401).
- **Never blocks local work.** The courier is a separate process; a stopped courier costs nothing but delay. Every tool keeps reading and writing.
- **Idle = no work:** no polling. Timers exist only for the debounce after a file change, a retry after a failure, a reconnect after a dropped doorbell. The doorbell's 25 s keep-alive comment is the only steady traffic.
- **Start-at-login is opt-in, default NO.** Setup asks `[y/N]` (or `--autostart` / `--no-autostart`); a non-interactive stdin answers No. Setup and `autostart on` print the name and location of everything they register, and how to remove it.
- **OS integration is never exercised in this sandbox.** Autostart is tested through its generated files and commands only (`--dry-run`). On Windows, system tools are called by FULL path (`%SystemRoot%\System32\schtasks.exe`): Git Bash's GNU tools have shadowed Windows ones before.
- Every connection that writes a shared DB loads cr-sqlite (the courier opens its connection with `loadCrsqlite`).
- `0007` stays staged. `setup` runs RELEASED migrations only, and refuses a DB without 0007 with a go-live message; `--include-staged` exists for rehearsals and tests. Nothing here enables sync on a real DB.
- Never commit `vendor/`, `dist/`, certificates, keys, join codes.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `core/src/sync/enable.ts` | modify | `disableSync` (undo `enableSync` for `uninstall`) |
| `core/src/ops/doctor.ts` | modify | cr-sqlite's leftover `crsql_*` bookkeeping tables are never "extra" |
| `post-office/src/server.ts` | modify | test hook `dropChangesAnswer` (acceptance test 8) |
| `courier/package.json`, `tsconfig.json` | new | workspace package, bin `collab` |
| `courier/src/keys.ts` | new | courier bookmarks in `sync_state` |
| `courier/src/paths.ts` | new | per-OS courier folder (config, pid, status, log) |
| `courier/src/engine.ts` | new | the `Courier`: push, pull, watch, doorbell, retry |
| `courier/src/autostart.ts` | new | per-OS login entry: plan, install, remove |
| `courier/src/setup.ts` | new | `setup` and `uninstall` as functions (used by the CLI and the tests) |
| `courier/src/cli.ts`, `bin.ts`, `index.ts` | new | `collab sync …` |
| `courier/test/*.test.ts` | new | unit tests + the 9 acceptance tests |

## Interfaces produced

- core: `disableSync(db) → { wasEnabled }`.
- courier: `COURIER_KEYS`; `courierDir(env, platform, home)`, `courierFiles(dir)`; `class Courier { constructor(opts); start(); stop(); pushNow(); pullNow(); syncNow(); whenIdle(); status }`; `autostartPlan(ctx)`, `installAutostart(plan, deps)`, `removeAutostart(plan, deps)`; `setup(opts)`, `uninstall(opts)`; `runCli(argv, io, deps)`.

## Review Focus

1. **Bookmarks:** the sent-bookmark advances only after every chunk is acknowledged; the receive-bookmark advances in the same transaction as the applied rows. A crash anywhere ⇒ resend or refetch, never loss; the post office de-duplicates ⇒ never a duplicate. Pinned by acceptance test 8.
2. **The module filter (D10):** a private-module note (or a note with no module) never leaves the machine, while its number request (ULID only) does. A module shared later is backfilled; a note MOVED into a shared module is sent whole. Pinned in Task 3 and acceptance test 6.
3. **Echo and loops:** received rows are never re-sent (`readOwnChanges` keeps own-site rows only); the courier's own writes trigger the watcher but cost no network. Pinned in Task 3.
4. **Revoked:** the courier says "access revoked" and stops (no retries, no reconnects). Pinned in Task 4 and acceptance test 7.
5. **Uninstall removes everything setup added:** login entry, courier folder, the key in `sync_state`, and the CRR conversion (the DB opens without cr-sqlite again; notes stay). Pinned in Task 6.
6. **Autostart commands:** full paths, correct quoting, nothing registered in tests. Pinned in Task 5.

---
### Task 1: `disableSync` (what `uninstall` needs from core)

**Files:**
- Modify: `core/src/sync/enable.ts`, `core/src/ops/doctor.ts`
- Create: `core/test/sync-disable.test.ts`

**Interfaces produced:** `disableSync(db) → { wasEnabled }`.

`uninstall` must remove everything `setup` added. In the notes DB that is: the CRR conversion (cr-sqlite's `crsql_as_table` drops its clock tables and triggers), the guarded bookkeeping triggers (they call a cr-sqlite function, so they go back to their 0006 bodies), and every `sync_state` key (the machine key with it). `enabled` becomes `'0'`: new notes get local numbers again. Notes themselves, including ones received from the team, stay. cr-sqlite leaves three bookkeeping tables (`crsql_master`, `crsql_site_id`, `crsql_tracked_peers`) behind; they are harmless, and doctor must not call them "extra".

- [ ] **Step 1: Write the failing tests.**

```ts
// file: core/test/sync-disable.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { doctor } from '../src/ops/doctor.js';
import { setAllocator } from '../src/sync/allocator.js';
import { setSyncValue, isSyncEnabled } from '../src/sync/state.js';
import { disableSync } from '../src/sync/enable.js';
import { hasCrrTables, isCrsqliteLoaded } from '../src/sync/extension.js';

test('disableSync undoes enableSync; the DB then opens and writes without cr-sqlite', async () => {
  const { db, path, cleanup } = freshDb({ shared: true });
  try {
    setSyncValue(db, 'device_key', 'secret');
    setSyncValue(db, 'po_url', 'https://10.0.0.1:7443');
    setAllocator({ allocate: async () => 50 });
    await addEntryAsync(db, { type: 'decision', title: 'kept', summary: 's', module: 'm' });
    assert.deepEqual(disableSync(db), { wasEnabled: true });
    assert.equal(hasCrrTables(db), false);
    assert.equal(isSyncEnabled(db), false);
    assert.deepEqual(db.prepare('SELECT key, value FROM sync_state').all(), [{ key: 'enabled', value: '0' }]);
    db.prepare('SELECT crsql_finalize()').get();
    db.close();
    const plain = new Database(path); // no extension loaded
    try {
      assert.equal(isCrsqliteLoaded(plain), false);
      assert.equal(addEntry(plain, { type: 'decision', title: 'after', summary: 's', module: 'm' }).id, 51);
      plain.prepare(`UPDATE entries SET updated_at = '2000-01-01 00:00:00' WHERE id = 50`).run();
      plain.prepare(`UPDATE entries SET status = 'resolved' WHERE id = 50`).run();
      const r = plain.prepare(`SELECT title, updated_at FROM entries WHERE id = 50`).get() as { title: string; updated_at: string };
      assert.equal(r.title, 'kept');
      assert.notEqual(r.updated_at, '2000-01-01 00:00:00', 'the restored 0006 trigger runs');
      const checks = doctor(plain).checks;
      for (const name of ['schema.tables', 'schema.indexes', 'schema.triggers']) {
        assert.equal(checks.find((c) => c.name === name)!.severity, 'ok', name);
      }
      assert.equal(checks.find((c) => c.name === 'sync.extension'), undefined);
    } finally { plain.close(); }
  } finally { setAllocator(null); cleanup(); }
});

test('disableSync on a DB that never shared is a no-op', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.deepEqual(disableSync(db), { wasEnabled: false });
    assert.equal(isCrsqliteLoaded(db), false);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Run: `cd core && npx tsx --test test/sync-disable.test.ts`. Expected: FAIL, `disableSync` is not exported.

- [ ] **Step 3: Implement.** In `core/src/sync/enable.ts`: import `hasCrrTables` from `./extension.js` (next to `loadCrsqlite`), and append:

```ts
/** The guarded trigger SQL with its guard removed: the 0006 body again. */
function unguard(sql: string): string {
  return sql
    .replace(/WHEN crsql_internal_sync_bit\(\) = 0\s+AND /g, "WHEN ")
    .replace(/\s*WHEN crsql_internal_sync_bit\(\) = 0\n/g, "\n");
}

/**
 * Undo enableSync (`collab sync uninstall`). The shared tables become plain
 * tables again (cr-sqlite's crsql_as_table drops its clocks and triggers), the
 * bookkeeping triggers get their 0006 bodies back, every sync_state key goes
 * (the machine key with it) and `enabled` becomes '0': new notes get local
 * numbers again. Notes are untouched. The DB then opens without cr-sqlite.
 */
export function disableSync(db: DB): { wasEnabled: boolean } {
  if (!hasSyncState(db)) return { wasEnabled: false };
  const wasEnabled = isSyncEnabled(db);
  if (!wasEnabled && !hasCrrTables(db)) return { wasEnabled };
  loadCrsqlite(db);
  db.transaction(() => {
    for (const t of SYNCED_TABLES) db.prepare(`SELECT crsql_as_table(?)`).get(t);
    for (const [name, sql] of GUARDED_TRIGGERS_SQL) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(unguard(sql));
    }
    db.prepare(`DELETE FROM sync_state WHERE key <> 'enabled'`).run();
    setSyncValue(db, "enabled", "0");
  })();
  return { wasEnabled };
}
```

In `core/src/ops/doctor.ts` change the `ours` line to:

```ts
  // cr-sqlite's own objects (crsql_* bookkeeping, <t>__crsql_* clocks/triggers)
  // are never "extra"; crsql_* tables can outlive a disableSync.
  const ours = (name: string) => !(name.startsWith("crsql_") || (shared && name.includes("crsql")));
```

- [ ] **Step 4: Run and confirm it passes.** Run: `cd core && npx tsx --test test/sync-disable.test.ts test/sync-prep.test.ts test/doctor-0006.test.ts`, then `npm -w @collab-mcp/core test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): disableSync, so uninstall can remove everything setup added (sync v1 plan 3)`

---

### Task 2: The courier package and its test world

**Files:**
- Create: `courier/package.json`, `courier/tsconfig.json`, `courier/src/keys.ts`, `courier/src/paths.ts`, `courier/src/index.ts`, `courier/test/world.ts`, `courier/test/paths.test.ts`
- Modify: root `package.json` (`workspaces` += `"courier"`), `post-office/src/server.ts` (two test hooks)

**Interfaces produced:** `COURIER_KEYS`, `courierDir(env, platform, home)`, `courierFiles(dir) → { dir, config, pid, status, log }`; post office `testHooks.dropChangesAnswer(device)` (accept, then drop the answer) and `testHooks.onRequest(route, device)`.

- [ ] **Step 1: Scaffold.**

```json
// file: courier/package.json
{
  "name": "@collab-mcp/courier",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Sync v1 courier: sends this machine's shared notes to the post office and collects everyone else's. CLI: collab sync ...",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "bin": { "collab": "./dist/bin.js" },
  "scripts": {
    "build": "tsc",
    "pretest": "npm --prefix ../core run build && npm --prefix ../post-office run build",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@collab-mcp/core": "*",
    "better-sqlite3": "^11.3.0"
  },
  "devDependencies": {
    "@collab-mcp/post-office": "*",
    "@types/better-sqlite3": "^7.6.8",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "~5.3.3"
  },
  "engines": { "node": ">=20.9.0" }
}
```

```json
// file: courier/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "declaration": true, "rootDir": "src", "types": ["node"] },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Root `package.json`: add `"courier"` to `workspaces` after `"post-office"`; run `npm install` (`--force` on EBADPLATFORM).

```ts
// file: courier/src/keys.ts
// The courier's bookmarks live in the notes DB's LOCAL-ONLY sync_state, next
// to the post office config (core SYNC_KEYS). Never shared.
export const COURIER_KEYS = {
  /** Own changes up to this db_version are acknowledged by the post office. */
  sent: "sent_db_version",
  /** Deliveries up to this seq are applied here. */
  recv: "recv_seq",
  /** JSON list: the team's shared modules, as last heard from the post office (D10). */
  shared: "shared_modules",
  /** JSON list: shared modules whose older notes were already sent (backfill done). */
  backfilled: "backfilled_modules",
} as const;
```

```ts
// file: courier/src/paths.ts
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** The courier's folder: config, pid, status, log. Per user, never in a repo. */
export function courierDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.COLLAB_COURIER_DIR) return env.COLLAB_COURIER_DIR; // tests, and a second courier for a second notes DB
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab", "courier");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab", "courier");
  return posix.join(env.XDG_STATE_HOME || posix.join(home, ".local", "state"), "collab", "courier");
}

export interface CourierFiles { dir: string; config: string; pid: string; status: string; log: string }
export function courierFiles(dir: string): CourierFiles {
  return {
    dir,
    config: join(dir, "config.json"),
    pid: join(dir, "courier.pid"),
    status: join(dir, "status.json"),
    log: join(dir, "courier.log"),
  };
}
```

```ts
// file: courier/src/index.ts
export * from "./keys.js";
export * from "./paths.js";
```

- [ ] **Step 2: The post office test hooks.** In `post-office/src/server.ts`, extend `testHooks` to

```ts
  testHooks?: {
    dropAllocateAnswer?: (ulid: string) => boolean;
    /** Accept a push, then drop the connection instead of answering (acceptance test 8). */
    dropChangesAnswer?: (device: string) => boolean;
    /** Every request, with the device id it CLAIMS (before authentication), so tests also count refused ones. */
    onRequest?: (route: string, device: string) => void;
  };
```

right after `const route = ...` in `handle` add `o.testHooks?.onRequest?.(route, /^Bearer ([^:\s]+):/.exec(req.headers.authorization ?? "")?.[1] ?? "");`, and in `POST /v1/changes`, after the `ring`/`log` block and before `return send(...)`: `if (o.testHooks?.dropChangesAnswer?.(me.device_id)) { req.socket.destroy(); return; }`.

- [ ] **Step 3: The test world (shared by Tasks 3, 4, 6, 7).**

```ts
// file: courier/test/world.ts
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  migrateTo, enableSync, generateSelfSignedCert, formatJoinCode, hasCrrTables, loadCrsqlite, isCrsqliteLoaded,
  setSyncValue, requestJson, SYNC_KEYS,
} from '@collab-mcp/core';
import { createStore, closeStore, startPostOffice, addMember, type PostOffice, type Store } from '@collab-mcp/post-office';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 5000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

export function tempDir(prefix = 'collab-courier-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A writer connection, opened the way core's getDb opens one (cr-sqlite loaded when the DB shares). */
export function openWriter(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  if (hasCrrTables(db)) loadCrsqlite(db);
  return db;
}
export function closeWriter(db: Database.Database): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) { try { db.prepare('SELECT crsql_finalize()').get(); } catch { /* closing anyway */ } }
  db.close();
}

export interface Office {
  store: Store;
  readonly po: PostOffice;
  readonly url: string;
  fingerprint: string;
  requests: Array<{ route: string; device: string }>;
  hooks: { dropChangesAnswer?: (device: string) => boolean };
  /** One-time join code for a new member. */
  code(name: string): { code: string; device: string };
  down(): Promise<void>;
  up(): Promise<void>;
  close(): Promise<void>;
}

/** A post office on 127.0.0.1 that can go down and come back on the same port with the same store. */
export async function startOffice(dir: string, seedMaxId: number): Promise<Office> {
  const store = createStore(join(dir, 'office.db'), { seedMaxId });
  const cert = generateSelfSignedCert();
  const requests: Office['requests'] = [];
  const hooks: Office['hooks'] = {};
  const opts = {
    store, certPem: cert.certPem, keyPem: cert.keyPem, host: '127.0.0.1', heartbeatMs: 1000, revokeCheckMs: 100,
    testHooks: {
      onRequest: (route: string, device: string) => { requests.push({ route, device }); },
      dropChangesAnswer: (device: string) => hooks.dropChangesAnswer?.(device) ?? false,
    },
  };
  let po = await startPostOffice({ ...opts, port: 0 });
  const port = po.port;
  let running = true;
  return {
    store, fingerprint: cert.fingerprint, requests, hooks,
    get po() { return po; },
    get url() { return po.url; },
    code(name) {
      const { deviceId, secret } = addMember(store, name);
      return { code: formatJoinCode({ url: po.url, fingerprint: cert.fingerprint, device: deviceId, secret }), device: deviceId };
    },
    async down() { if (running) { running = false; await po.close(); } },
    async up() { if (!running) { po = await startPostOffice({ ...opts, port }); running = true; } },
    async close() { await this.down(); closeStore(store); },
  };
}

/** A shared notes DB joined to `office` WITHOUT the setup command (Tasks 3-4 test the engine alone). */
export async function joinedDb(office: Office, dir: string, name: string): Promise<{ path: string; device: string }> {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, 'collab.db');
  const db = new Database(path);
  try {
    migrateTo(db, '0007', { includeStaged: true });
    enableSync(db);
    const { deviceId, secret } = addMember(office.store, name);
    const r = await requestJson({ url: office.url, fingerprint: office.fingerprint }, 'POST', '/v1/join', { device: deviceId, secret });
    setSyncValue(db, SYNC_KEYS.url, office.url);
    setSyncValue(db, SYNC_KEYS.fingerprint, office.fingerprint);
    setSyncValue(db, SYNC_KEYS.device, deviceId);
    setSyncValue(db, SYNC_KEYS.key, r.body.key);
    return { path, device: deviceId };
  } finally { closeWriter(db); }
}
```

- [ ] **Step 4: A first test (paths) to prove the package runs.**

```ts
// file: courier/test/paths.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { courierDir, courierFiles } from '../src/paths.js';

test('the courier folder per OS (never in a repo)', () => {
  assert.equal(courierDir({ LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' }, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\courier');
  assert.equal(courierDir({}, 'darwin', '/Users/n'), '/Users/n/Library/Application Support/collab/courier');
  assert.equal(courierDir({}, 'linux', '/home/n'), '/home/n/.local/state/collab/courier');
  assert.equal(courierDir({ XDG_STATE_HOME: '/s' }, 'linux', '/home/n'), '/s/collab/courier');
  assert.equal(courierDir({ COLLAB_COURIER_DIR: '/c' }, 'win32', 'C:\\Users\\n'), '/c');
  assert.deepEqual(Object.keys(courierFiles('/x')), ['dir', 'config', 'pid', 'status', 'log']);
});
```

- [ ] **Step 5: Run.** Run: `npm -w @collab-mcp/courier test` (fails first: `Cannot find module '../src/paths.js'` if the test is written before `paths.ts`; then PASS), and `npm -w @collab-mcp/post-office test` (still PASS with the hooks).

- [ ] **Step 6: Commit** `feat(courier): package scaffold, bookmarks, folders; post office test hooks (sync v1 plan 3)`

---
### Task 3: The courier engine: push and pull

**Files:**
- Create: `courier/src/engine.ts`, `courier/test/engine.test.ts`
- Modify: `courier/src/index.ts`

**Interfaces produced:** `class Courier` with `constructor(opts)`, `status`, `pushNow()`, `pullNow()`, `syncNow()`, `stop()`, `whenIdle()`, `pendingTimers()`; `CourierOptions`, `CourierStatus`, `CourierState`.

Push rules (D10, Components 2 "Filter"):
- Only this machine's OWN changes since the sent-bookmark (`readOwnChanges`): a received row is never sent back.
- A change travels iff the PRIMARY module (`entries.module`) of its note is in the team's shared list (`modules` rows: iff the module itself is shared). No module = private.
- A module that became shared since the last push: its older notes are sent too (backfill). A note MOVED into a shared module (its `module` column changed and the note was not created in this batch) is sent whole. Both read all own changes once; rare.
- Chunks of `batchSize`. The sent-bookmark (and the backfilled list) is written only after EVERY chunk was acknowledged, and only when it changed (an unchanged write would wake the file watch for nothing).
- Failure => state `offline`, `lastError`, ONE retry timer (`retryMs`, 30 s). 401 => `revoked`, no timers.

Pull: fetch after the receive-bookmark until nothing is new; per page, apply + `reindexFts` + bookmark in ONE transaction.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: courier/test/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, getSyncValue, updateEntry } from '@collab-mcp/core';
import { setModuleShared } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, type Office } from './world.js';
import { Courier } from '../src/engine.js';
import { COURIER_KEYS } from '../src/keys.js';

async function setting(seed = 0) {
  const t = tempDir();
  const office = await startOffice(t.dir, seed);
  const opened: Array<{ close(): void }> = [];
  const couriers: Courier[] = [];
  const machine = async (name: string) => {
    const j = await joinedDb(office, t.dir, name);
    const w = openWriter(j.path);
    opened.push({ close: () => closeWriter(w) });
    const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
    couriers.push(c);
    return { ...j, w, c };
  };
  return {
    office, machine,
    done: async () => { for (const c of couriers) await c.stop(); for (const o of opened) o.close(); await office.close(); t.cleanup(); },
  };
}
const inStore = (o: Office, title: string) => !!o.store.prepare('SELECT 1 FROM entries WHERE title = ?').get(title);
const lastSeq = (o: Office) => (o.store.prepare('SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries').get() as { s: number }).s;
const fullRow = (o: Office, title: string) => o.store.prepare('SELECT title, summary, type, module FROM entries WHERE title = ?').get(title) as any;

test('push sends only notes whose primary module is shared; numbers are still asked for all', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    const shared = await addEntryAsync(a.w, { type: 'decision', title: 'team note', summary: 's', module: 'team' });
    await addEntryAsync(a.w, { type: 'decision', title: 'private note', summary: 's', module: 'private' });
    await addEntryAsync(a.w, { type: 'decision', title: 'loose note', summary: 's' });
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'team note'), true);
    assert.equal(inStore(s.office, 'private note'), false);
    assert.equal(inStore(s.office, 'loose note'), false);
    assert.equal((s.office.store.prepare('SELECT COUNT(*) c FROM po_allocations').get() as { c: number }).c, 3, 'only ULIDs were sent for the private ones');
    assert.ok(shared.id >= 1);
    const seq = lastSeq(s.office);
    await a.c.pushNow();
    assert.equal(lastSeq(s.office), seq, 'nothing new to send');
    assert.equal(Number(getSyncValue(a.w, COURIER_KEYS.sent)), (a.w.prepare('SELECT crsql_db_version() v').get() as { v: number }).v);
  } finally { await s.done(); }
});

test('a module shared later is backfilled; a note moved into a shared module is sent whole', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    await addEntryAsync(a.w, { type: 'decision', title: 'later note', summary: 'from before sharing', module: 'later' });
    const moved = await addEntryAsync(a.w, { type: 'gotcha', title: 'moved note', summary: 'was private', module: 'private' });
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'later note'), false);
    setModuleShared(s.office.store, 'later', true);
    await a.c.syncNow();
    assert.deepEqual(fullRow(s.office, 'later note'), { title: 'later note', summary: 'from before sharing', type: 'decision', module: 'later' });
    a.w.prepare(`UPDATE entries SET module = 'team' WHERE id = ?`).run(moved.id);
    await a.c.pushNow();
    assert.deepEqual(fullRow(s.office, 'moved note'), { title: 'moved note', summary: 'was private', type: 'gotcha', module: 'team' });
  } finally { await s.done(); }
});

test('pull applies, re-indexes search, moves the bookmark; received rows are never sent back', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a'), b = await s.machine('b');
    const { id } = await addEntryAsync(a.w, { type: 'decision', title: 'okapi sighting', summary: 's', module: 'team' });
    await a.c.syncNow();
    await b.c.syncNow();
    assert.equal((b.w.prepare(`SELECT COUNT(*) c FROM entries_fts WHERE entries_fts MATCH 'okapi'`).get() as { c: number }).c, 1);
    assert.equal(Number(getSyncValue(b.w, COURIER_KEYS.recv)), lastSeq(s.office));
    const seq = lastSeq(s.office);
    await b.c.pushNow();
    assert.equal(lastSeq(s.office), seq, 'no echo');
    updateEntry(b.w, { id, description: 'edited on b' });
    await b.c.pushNow();
    await a.c.pullNow();
    assert.equal((a.w.prepare('SELECT description d FROM entries WHERE id = ?').get(id) as { d: string }).d, 'edited on b');
  } finally { await s.done(); }
});

test('the sent-bookmark moves only after the post office acknowledged', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    await a.c.syncNow();
    let drop = true;
    s.office.hooks.dropChangesAnswer = () => { const d = drop; drop = false; return d; };
    await addEntryAsync(a.w, { type: 'decision', title: 'unacknowledged', summary: 's', module: 'team' });
    const before = Number(getSyncValue(a.w, COURIER_KEYS.sent) ?? 0);
    await a.c.pushNow();
    assert.equal(a.c.status.state, 'offline');
    assert.equal(Number(getSyncValue(a.w, COURIER_KEYS.sent) ?? 0), before, 'not acknowledged => not advanced');
    assert.equal(a.c.pendingTimers(), 1, 'a retry is scheduled');
    const stored = lastSeq(s.office);
    await a.c.pushNow();
    assert.equal(lastSeq(s.office), stored, 'the resend was all duplicates');
    assert.ok(Number(getSyncValue(a.w, COURIER_KEYS.sent)) > before);
    assert.equal((s.office.store.prepare(`SELECT COUNT(*) c FROM entries WHERE title = 'unacknowledged'`).get() as { c: number }).c, 1);
  } finally { s.office.hooks.dropChangesAnswer = undefined; await s.done(); }
});

test('a DB that is not set up is refused with a clear message', () => {
  const t = tempDir();
  try {
    const db = openWriter(`${t.dir}/plain.db`);
    db.exec('CREATE TABLE x (a)');
    closeWriter(db);
    assert.throws(() => new Courier({ dbPath: `${t.dir}/plain.db`, watch: false }), /collab sync setup/);
  } finally { t.cleanup(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Run: `npm -w @collab-mcp/courier test`. Expected: FAIL, `Cannot find module '../src/engine.js'`.

- [ ] **Step 3: Implement** (Task 4 replaces this file with the version that adds the watch and the doorbell; this one has everything else).

```ts
// file: courier/src/engine.ts
import Database from "better-sqlite3";
import type { FSWatcher } from "node:fs";
import {
  loadCrsqlite, isCrsqliteLoaded, isSyncEnabled, getSyncValue, setSyncValue, postOfficeTargetFromDb,
  readOwnChanges, decodeChange, applyChanges, reindexFts, entryUlidOf, requestJson,
  AccessRevokedError, type PostOfficeTarget, type WireChange, type EventStream,
} from "@collab-mcp/core";
import { COURIER_KEYS as K } from "./keys.js";

// The courier (spec Components 2, D4). Task 3: push and pull; Task 4 adds the watch and the doorbell.
// One per machine, client-agnostic: it
// opens the notes DB itself. Push on write (a watch on the DB and its WAL,
// ~200 ms debounce), pull when the doorbell rings (SSE), retry every 30 s after
// a failure, nothing at all while nothing changes. All network work runs one
// job at a time. Bookmarks make every step safe to repeat: the sent-bookmark
// moves only after the post office acknowledged; the receive-bookmark moves in
// the same transaction as the rows it covers.

export type CourierState = "starting" | "connected" | "offline" | "revoked" | "stopped";

export interface CourierStatus {
  state: CourierState;
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  sentTotal: number;
  receivedTotal: number;
}

export interface CourierOptions {
  dbPath: string;
  /** After a failed push/pull (D4: 30 s). */
  retryMs?: number;
  /** After a file change, before pushing (~200 ms). */
  debounceMs?: number;
  /** Cap of the doorbell's reconnect back-off (30 s: "reconnects within 30 s"). */
  maxReconnectMs?: number;
  /** Changes per request. */
  batchSize?: number;
  /** Watch the DB file (off in unit tests that drive push/pull by hand). */
  watch?: boolean;
  log?: (line: string) => void;
  onStatus?: (s: CourierStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;
const now = () => new Date().toISOString();
const changeKey = (w: WireChange) => `${w.site_id}|${w.db_version}|${w.seq}|${w.table}|${w.pk}|${w.cid}`;

export class Courier {
  readonly db: Database.Database;
  readonly target: PostOfficeTarget;
  private readonly opt: Required<Omit<CourierOptions, "log" | "onStatus">> & Pick<CourierOptions, "log" | "onStatus">;
  private st: CourierStatus = { state: "starting", lastError: null, lastPushAt: null, lastPullAt: null, sentTotal: 0, receivedTotal: 0 };
  private stream: EventStream | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private reconnectDelay = 1000;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: CourierOptions) {
    this.opt = { retryMs: 30_000, debounceMs: 200, maxReconnectMs: 30_000, batchSize: 2000, watch: true, ...opts };
    this.db = new Database(opts.dbPath, { fileMustExist: true });
    try {
      this.db.pragma("journal_mode = WAL");
      loadCrsqlite(this.db); // this connection writes a shared DB: it must carry cr-sqlite
      if (!isSyncEnabled(this.db)) throw new Error(`${opts.dbPath} does not share notes yet: run \`collab sync setup <join code>\` first`);
      const t = postOfficeTargetFromDb(this.db);
      if (!t) throw new Error(`${opts.dbPath} has no post office configured: run \`collab sync setup <join code>\` first`);
      this.target = t;
    } catch (e) {
      this.closeDb();
      throw e;
    }
  }

  get status(): CourierStatus {
    return { ...this.st };
  }

  /** Timers waiting to fire. 0 = idle and healthy (D4: idle = no work). */
  pendingTimers(): number {
    return [this.debounceTimer, this.retryTimer, this.reconnectTimer].filter((t) => t !== null).length;
  }

  /** Resolves when the work queued so far is done. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.watcher?.close();
    this.watcher = null;
    this.stream?.close();
    this.stream = null;
    await this.chain;
    this.closeDb();
    if (this.st.state !== "revoked") this.set({ state: "stopped" });
  }

  pushNow(): Promise<void> {
    return this.enqueue(() => this.push());
  }
  pullNow(): Promise<void> {
    return this.enqueue(() => this.pull());
  }
  /** Modules, then pull, then push: what a (re)connect does. */
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshModules();
      await this.pull();
      await this.push();
    });
  }

  // ------------------------------------------------------------ internals
  private set(patch: Partial<CourierStatus>): void {
    this.st = { ...this.st, ...patch };
    this.opt.onStatus?.(this.status);
  }
  private log(line: string): void {
    this.opt.log?.(line);
  }
  private clearTimers(): void {
    for (const t of [this.debounceTimer, this.retryTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.debounceTimer = this.retryTimer = this.reconnectTimer = null;
  }
  private closeDb(): void {
    if (!this.db?.open) return;
    if (isCrsqliteLoaded(this.db)) {
      try { this.db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
    }
    this.db.close();
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.stopped || this.st.state === "revoked") return;
      try {
        await job();
      } catch (e) {
        this.failed(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.chain = next;
    return next;
  }

  private failed(e: Error): void {
    if (e instanceof AccessRevokedError) return this.revoked(e);
    this.log(`sync failed, retrying in ${Math.round(this.opt.retryMs / 1000)} s: ${e.message}`);
    this.set({ state: "offline", lastError: e.message });
    if (!this.retryTimer && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.syncNow();
      }, this.opt.retryMs);
    }
  }

  /** Failure table: "The courier shows 'access revoked' and stops retrying." */
  private revoked(e?: Error): void {
    this.clearTimers();
    this.stream?.close();
    this.stream = null;
    this.watcher?.close();
    this.watcher = null;
    this.set({ state: "revoked", lastError: e?.message ?? "access revoked: the post office refused this machine's key; ask its owner for a new join code" });
    this.log("access revoked: the post office refused this machine's key. Stopped (no retries). Ask its owner for a new join code.");
  }

  private sharedModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.shared) ?? "[]") as string[]); } catch { return new Set(); }
  }
  private backfilledModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.backfilled) ?? "[]") as string[]); } catch { return new Set(); }
  }

  /** The note a change belongs to and that note's PRIMARY module (D10); for a modules row, its slug. */
  private placeOf(w: WireChange, memo: Map<string, string | null>): { ulid: string | null; module: string | null } {
    const pk = Buffer.from(w.pk, "base64");
    if (w.table === "modules") {
      const r = this.db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
      return { ulid: null, module: r ? String(r.cell) : null };
    }
    const ulid = entryUlidOf(this.db, w.table, pk);
    if (!ulid) return { ulid: null, module: null };
    if (!memo.has(ulid)) {
      const e = this.db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(ulid) as { module: string | null } | undefined;
      memo.set(ulid, e?.module ?? null);
    }
    return { ulid, module: memo.get(ulid) ?? null };
  }

  private async refreshModules(): Promise<void> {
    const r = await requestJson(this.target, "GET", "/v1/modules");
    if (r.status !== 200 || !Array.isArray(r.body?.shared)) throw new Error(`the post office did not list the shared modules (${r.status})`);
    const next = JSON.stringify([...(r.body.shared as string[])].sort());
    if (next !== getSyncValue(this.db, K.shared)) setSyncValue(this.db, K.shared, next);
  }

  /**
   * Send this machine's OWN changes since the sent-bookmark whose note's primary
   * module is shared (D10). Also: older notes of a module shared since the last
   * push (backfill), and the whole of a note just MOVED into a shared module.
   */
  private async push(): Promise<void> {
    const since = Number(getSyncValue(this.db, K.sent) ?? 0);
    const shared = this.sharedModules();
    const done = this.backfilledModules();
    const backfill = new Set([...shared].filter((m) => !done.has(m)));
    const memo = new Map<string, string | null>();
    const out = new Map<string, WireChange>();
    const moved = new Set<string>();
    const createdNow = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, module } = this.placeOf(w, memo);
      if (!module || !shared.has(module)) continue;
      out.set(changeKey(w), w);
      if (w.table === "entries" && ulid) {
        if (w.cid === "created_at") createdNow.add(ulid);
        if (w.cid === "module") moved.add(ulid);
      }
    }
    for (const u of createdNow) moved.delete(u); // a new note is not a move: it is already whole
    if (backfill.size > 0 || moved.size > 0) {
      for (const w of readOwnChanges(this.db, 0)) {
        if (w.db_version > top) continue; // newer than this push: the next push takes it
        const { ulid, module } = this.placeOf(w, memo);
        if ((module && backfill.has(module)) || (ulid && moved.has(ulid))) out.set(changeKey(w), w);
      }
    }
    const batch = [...out.values()];
    for (let i = 0; i < batch.length; i += this.opt.batchSize) {
      const r = await requestJson(this.target, "POST", "/v1/changes", { changes: batch.slice(i, i + this.opt.batchSize) });
      if (r.status !== 200) throw new Error(`the post office refused the changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
    }
    // Only now is everything up to `top` acknowledged. A crash before this line
    // means a resend, which the post office de-duplicates.
    const sharedJson = JSON.stringify([...shared].sort());
    if (top !== since || sharedJson !== getSyncValue(this.db, K.backfilled)) {
      this.db.transaction(() => {
        setSyncValue(this.db, K.sent, String(top));
        setSyncValue(this.db, K.backfilled, sharedJson);
      })();
    }
    if (batch.length > 0) {
      this.set({ sentTotal: this.st.sentTotal + batch.length, lastPushAt: now(), lastError: null });
      this.log(`sent ${batch.length} change(s)`);
    }
  }

  /** Fetch deliveries after the receive-bookmark; apply + re-index (D15) + move the bookmark in ONE transaction. */
  private async pull(): Promise<void> {
    let after = Number(getSyncValue(this.db, K.recv) ?? 0);
    for (;;) {
      const r = await requestJson(this.target, "GET", `/v1/changes?after=${after}&limit=${this.opt.batchSize}`);
      if (r.status !== 200) throw new Error(`the post office did not send changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
      const last = Number(r.body?.last_seq);
      const changes = (r.body?.changes ?? []) as WireChange[];
      if (!Number.isInteger(last) || last <= after) break; // nothing new (and the office now knows we hold `after`)
      this.db.transaction(() => {
        if (changes.length > 0) {
          const applied = applyChanges(this.db, changes.map(decodeChange));
          reindexFts(this.db, applied.entryUlids);
        }
        setSyncValue(this.db, K.recv, String(last));
      })();
      after = last;
      if (changes.length > 0) {
        this.set({ receivedTotal: this.st.receivedTotal + changes.length, lastPullAt: now(), lastError: null });
        this.log(`received ${changes.length} change(s)`);
      }
    }
  }
}
```

`index.ts`: add `export * from "./engine.js";`.

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/courier test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(courier): push by shared module (backfill, moved notes) and pull with FTS re-index (sync v1 plan 3)`

---

### Task 4: Push on write, the doorbell, retry, revoked

**Files:**
- Replace: `courier/src/engine.ts`
- Create: `courier/test/live.test.ts`

**Interfaces produced:** `Courier.start()`.

- Watch: `fs.watch` on the DB's FOLDER (works on Windows, macOS and Linux; a file watch would miss the WAL), filtered to the DB and `<db>-wal`, debounced (`debounceMs`, 200 ms) => push. The courier's own pulls also touch the file: the resulting push finds no own changes and costs no request.
- Doorbell: `GET /v1/events`. `ready` => state `connected` + modules, pull, push (this is also the catch-up after any outage). `changes` => pull. `modules` => refresh + push (backfill). `revoked` or a 401 => `revoked`. Dropped => `offline`, reconnect after 1 s, doubling, capped at `maxReconnectMs` (30 s: "reconnects within 30 s").

- [ ] **Step 1: Write the failing tests.**

```ts
// file: courier/test/live.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, updateEntry } from '@collab-mcp/core';
import { setModuleShared, revokeMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until, sleep } from './world.js';
import { Courier } from '../src/engine.js';

async function pair() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  const opts = { retryMs: 300, maxReconnectMs: 200 };
  const ca = new Courier({ dbPath: ja.path, ...opts }), cb = new Courier({ dbPath: jb.path, ...opts });
  ca.start(); cb.start();
  await until(() => ca.status.state === 'connected' && cb.status.state === 'connected', 3000, 'both doorbells');
  return {
    t, office, ja, jb, wa, wb, ca, cb,
    done: async () => { await ca.stop(); await cb.stop(); closeWriter(wa); closeWriter(wb); await office.close(); t.cleanup(); },
  };
}
const title = (db: any, id: number) => (db.prepare('SELECT title, description FROM entries WHERE id = ?').get(id) as any) ?? null;

test('a save on one machine reaches the other with nobody calling push or pull', async () => {
  const p = await pair();
  try {
    const { id } = await addEntryAsync(p.wa, { type: 'decision', title: 'tapir', summary: 's', module: 'team' });
    await until(() => title(p.wb, id)?.title === 'tapir', 2000, 'the doorbell + pull');
  } finally { await p.done(); }
});

test('idle = no work: no requests while nothing changes, no timers pending', async () => {
  const p = await pair();
  try {
    await addEntryAsync(p.wa, { type: 'decision', title: 'settle', summary: 's', module: 'team' });
    await until(() => p.wb.prepare(`SELECT 1 FROM entries WHERE title = 'settle'`).get() !== undefined, 2000);
    await sleep(500);
    const n = p.office.requests.length;
    await sleep(1000);
    assert.equal(p.office.requests.length, n, 'no requests in a quiet second');
    assert.equal(p.ca.pendingTimers() + p.cb.pendingTimers(), 0);
  } finally { await p.done(); }
});

test('the post office goes away and comes back: the doorbell reconnects and offline edits arrive', async () => {
  const p = await pair();
  try {
    const { id } = await addEntryAsync(p.wa, { type: 'decision', title: 'ibis', summary: 's', description: 'v1', module: 'team' });
    await until(() => title(p.wb, id)?.description === 'v1', 2000);
    await p.office.down();
    await until(() => p.ca.status.state === 'offline' && p.cb.status.state === 'offline', 3000, 'both offline');
    updateEntry(p.wa, { id, description: 'v2, written while the post office was down' });
    await sleep(400);
    await p.office.up();
    await until(() => title(p.wb, id)?.description === 'v2, written while the post office was down', 5000, 'catch-up');
    await until(() => p.ca.status.state === 'connected', 2000);
  } finally { await p.done(); }
});

test('revoked: "access revoked", and no more retries or reconnects', async () => {
  const p = await pair();
  try {
    revokeMember(p.office.store, p.jb.device);
    await until(() => p.cb.status.state === 'revoked', 3000, 'the revoked state');
    assert.match(p.cb.status.lastError ?? '', /revoked/);
    const fromB = () => p.office.requests.filter((r) => r.device === p.jb.device).length;
    await addEntryAsync(p.wa, { type: 'decision', title: 'not for b', summary: 's', module: 'team' });
    const n = fromB();
    await sleep(800);
    assert.equal(fromB(), n, 'B makes no more requests');
    assert.equal(p.cb.pendingTimers(), 0);
  } finally { await p.done(); }
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `c.start is not a function` (TypeError).

- [ ] **Step 3: Implement.** Replace `courier/src/engine.ts` with:

```ts
// file: courier/src/engine.ts
import Database from "better-sqlite3";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  loadCrsqlite, isCrsqliteLoaded, isSyncEnabled, getSyncValue, setSyncValue, postOfficeTargetFromDb,
  readOwnChanges, decodeChange, applyChanges, reindexFts, entryUlidOf, requestJson, openEventStream,
  AccessRevokedError, type PostOfficeTarget, type WireChange, type EventStream,
} from "@collab-mcp/core";
import { COURIER_KEYS as K } from "./keys.js";

// The courier (spec Components 2, D4). One per machine, client-agnostic: it
// opens the notes DB itself. Push on write (a watch on the DB and its WAL,
// ~200 ms debounce), pull when the doorbell rings (SSE), retry every 30 s after
// a failure, nothing at all while nothing changes. All network work runs one
// job at a time. Bookmarks make every step safe to repeat: the sent-bookmark
// moves only after the post office acknowledged; the receive-bookmark moves in
// the same transaction as the rows it covers.

export type CourierState = "starting" | "connected" | "offline" | "revoked" | "stopped";

export interface CourierStatus {
  state: CourierState;
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  sentTotal: number;
  receivedTotal: number;
}

export interface CourierOptions {
  dbPath: string;
  /** After a failed push/pull (D4: 30 s). */
  retryMs?: number;
  /** After a file change, before pushing (~200 ms). */
  debounceMs?: number;
  /** Cap of the doorbell's reconnect back-off (30 s: "reconnects within 30 s"). */
  maxReconnectMs?: number;
  /** Changes per request. */
  batchSize?: number;
  /** Watch the DB file (off in unit tests that drive push/pull by hand). */
  watch?: boolean;
  log?: (line: string) => void;
  onStatus?: (s: CourierStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;
const now = () => new Date().toISOString();
const changeKey = (w: WireChange) => `${w.site_id}|${w.db_version}|${w.seq}|${w.table}|${w.pk}|${w.cid}`;

export class Courier {
  readonly db: Database.Database;
  readonly target: PostOfficeTarget;
  private readonly opt: Required<Omit<CourierOptions, "log" | "onStatus">> & Pick<CourierOptions, "log" | "onStatus">;
  private st: CourierStatus = { state: "starting", lastError: null, lastPushAt: null, lastPullAt: null, sentTotal: 0, receivedTotal: 0 };
  private stream: EventStream | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private reconnectDelay = 1000;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: CourierOptions) {
    this.opt = { retryMs: 30_000, debounceMs: 200, maxReconnectMs: 30_000, batchSize: 2000, watch: true, ...opts };
    this.db = new Database(opts.dbPath, { fileMustExist: true });
    try {
      this.db.pragma("journal_mode = WAL");
      loadCrsqlite(this.db); // this connection writes a shared DB: it must carry cr-sqlite
      if (!isSyncEnabled(this.db)) throw new Error(`${opts.dbPath} does not share notes yet: run \`collab sync setup <join code>\` first`);
      const t = postOfficeTargetFromDb(this.db);
      if (!t) throw new Error(`${opts.dbPath} has no post office configured: run \`collab sync setup <join code>\` first`);
      this.target = t;
    } catch (e) {
      this.closeDb();
      throw e;
    }
  }

  get status(): CourierStatus {
    return { ...this.st };
  }

  /** Timers waiting to fire. 0 = idle and healthy (D4: idle = no work). */
  pendingTimers(): number {
    return [this.debounceTimer, this.retryTimer, this.reconnectTimer].filter((t) => t !== null).length;
  }

  /** Resolves when the work queued so far is done. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  start(): void {
    if (this.stopped) throw new Error("this courier was stopped; make a new one");
    if (this.opt.watch) this.watchDb();
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.watcher?.close();
    this.watcher = null;
    this.stream?.close();
    this.stream = null;
    await this.chain;
    this.closeDb();
    if (this.st.state !== "revoked") this.set({ state: "stopped" });
  }

  pushNow(): Promise<void> {
    return this.enqueue(() => this.push());
  }
  pullNow(): Promise<void> {
    return this.enqueue(() => this.pull());
  }
  /** Modules, then pull, then push: what a (re)connect does. */
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshModules();
      await this.pull();
      await this.push();
    });
  }

  // ------------------------------------------------------------ internals
  private set(patch: Partial<CourierStatus>): void {
    this.st = { ...this.st, ...patch };
    this.opt.onStatus?.(this.status);
  }
  private log(line: string): void {
    this.opt.log?.(line);
  }
  private clearTimers(): void {
    for (const t of [this.debounceTimer, this.retryTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.debounceTimer = this.retryTimer = this.reconnectTimer = null;
  }
  private closeDb(): void {
    if (!this.db?.open) return;
    if (isCrsqliteLoaded(this.db)) {
      try { this.db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
    }
    this.db.close();
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.stopped || this.st.state === "revoked") return;
      try {
        await job();
      } catch (e) {
        this.failed(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.chain = next;
    return next;
  }

  private failed(e: Error): void {
    if (e instanceof AccessRevokedError) return this.revoked(e);
    this.log(`sync failed, retrying in ${Math.round(this.opt.retryMs / 1000)} s: ${e.message}`);
    this.set({ state: "offline", lastError: e.message });
    if (!this.retryTimer && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.syncNow();
      }, this.opt.retryMs);
    }
  }

  /** Failure table: "The courier shows 'access revoked' and stops retrying." */
  private revoked(e?: Error): void {
    this.clearTimers();
    this.stream?.close();
    this.stream = null;
    this.watcher?.close();
    this.watcher = null;
    this.set({ state: "revoked", lastError: e?.message ?? "access revoked: the post office refused this machine's key; ask its owner for a new join code" });
    this.log("access revoked: the post office refused this machine's key. Stopped (no retries). Ask its owner for a new join code.");
  }

  private sharedModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.shared) ?? "[]") as string[]); } catch { return new Set(); }
  }
  private backfilledModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.backfilled) ?? "[]") as string[]); } catch { return new Set(); }
  }

  /** The note a change belongs to and that note's PRIMARY module (D10); for a modules row, its slug. */
  private placeOf(w: WireChange, memo: Map<string, string | null>): { ulid: string | null; module: string | null } {
    const pk = Buffer.from(w.pk, "base64");
    if (w.table === "modules") {
      const r = this.db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
      return { ulid: null, module: r ? String(r.cell) : null };
    }
    const ulid = entryUlidOf(this.db, w.table, pk);
    if (!ulid) return { ulid: null, module: null };
    if (!memo.has(ulid)) {
      const e = this.db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(ulid) as { module: string | null } | undefined;
      memo.set(ulid, e?.module ?? null);
    }
    return { ulid, module: memo.get(ulid) ?? null };
  }

  private async refreshModules(): Promise<void> {
    const r = await requestJson(this.target, "GET", "/v1/modules");
    if (r.status !== 200 || !Array.isArray(r.body?.shared)) throw new Error(`the post office did not list the shared modules (${r.status})`);
    const next = JSON.stringify([...(r.body.shared as string[])].sort());
    if (next !== getSyncValue(this.db, K.shared)) setSyncValue(this.db, K.shared, next);
  }

  /**
   * Send this machine's OWN changes since the sent-bookmark whose note's primary
   * module is shared (D10). Also: older notes of a module shared since the last
   * push (backfill), and the whole of a note just MOVED into a shared module.
   */
  private async push(): Promise<void> {
    const since = Number(getSyncValue(this.db, K.sent) ?? 0);
    const shared = this.sharedModules();
    const done = this.backfilledModules();
    const backfill = new Set([...shared].filter((m) => !done.has(m)));
    const memo = new Map<string, string | null>();
    const out = new Map<string, WireChange>();
    const moved = new Set<string>();
    const createdNow = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, module } = this.placeOf(w, memo);
      if (!module || !shared.has(module)) continue;
      out.set(changeKey(w), w);
      if (w.table === "entries" && ulid) {
        if (w.cid === "created_at") createdNow.add(ulid);
        if (w.cid === "module") moved.add(ulid);
      }
    }
    for (const u of createdNow) moved.delete(u); // a new note is not a move: it is already whole
    if (backfill.size > 0 || moved.size > 0) {
      for (const w of readOwnChanges(this.db, 0)) {
        if (w.db_version > top) continue; // newer than this push: the next push takes it
        const { ulid, module } = this.placeOf(w, memo);
        if ((module && backfill.has(module)) || (ulid && moved.has(ulid))) out.set(changeKey(w), w);
      }
    }
    const batch = [...out.values()];
    for (let i = 0; i < batch.length; i += this.opt.batchSize) {
      const r = await requestJson(this.target, "POST", "/v1/changes", { changes: batch.slice(i, i + this.opt.batchSize) });
      if (r.status !== 200) throw new Error(`the post office refused the changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
    }
    // Only now is everything up to `top` acknowledged. A crash before this line
    // means a resend, which the post office de-duplicates.
    const sharedJson = JSON.stringify([...shared].sort());
    if (top !== since || sharedJson !== getSyncValue(this.db, K.backfilled)) {
      this.db.transaction(() => {
        setSyncValue(this.db, K.sent, String(top));
        setSyncValue(this.db, K.backfilled, sharedJson);
      })();
    }
    if (batch.length > 0) {
      this.set({ sentTotal: this.st.sentTotal + batch.length, lastPushAt: now(), lastError: null });
      this.log(`sent ${batch.length} change(s)`);
    }
  }

  /** Fetch deliveries after the receive-bookmark; apply + re-index (D15) + move the bookmark in ONE transaction. */
  private async pull(): Promise<void> {
    let after = Number(getSyncValue(this.db, K.recv) ?? 0);
    for (;;) {
      const r = await requestJson(this.target, "GET", `/v1/changes?after=${after}&limit=${this.opt.batchSize}`);
      if (r.status !== 200) throw new Error(`the post office did not send changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
      const last = Number(r.body?.last_seq);
      const changes = (r.body?.changes ?? []) as WireChange[];
      if (!Number.isInteger(last) || last <= after) break; // nothing new (and the office now knows we hold `after`)
      this.db.transaction(() => {
        if (changes.length > 0) {
          const applied = applyChanges(this.db, changes.map(decodeChange));
          reindexFts(this.db, applied.entryUlids);
        }
        setSyncValue(this.db, K.recv, String(last));
      })();
      after = last;
      if (changes.length > 0) {
        this.set({ receivedTotal: this.st.receivedTotal + changes.length, lastPullAt: now(), lastError: null });
        this.log(`received ${changes.length} change(s)`);
      }
    }
  }

  /** Push on write: any change to the DB or its WAL, debounced. */
  private watchDb(): void {
    const dir = dirname(this.opt.dbPath);
    const base = basename(this.opt.dbPath);
    this.watcher = watch(dir, (_event, name) => {
      const n = name === null || name === undefined ? null : String(name);
      if (n !== null && n !== base && n !== `${base}-wal`) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.pushNow();
      }, this.opt.debounceMs);
    });
    this.watcher.on("error", (e) => this.log(`file watch failed: ${e.message}`));
  }

  /** The doorbell. On (re)connect: catch up both ways. Dropped: reconnect with back-off up to 30 s. */
  private connect(): void {
    if (this.stopped || this.st.state === "revoked") return;
    this.stream = openEventStream(this.target, "/v1/events", {
      event: (name) => {
        if (name === "ready") {
          this.reconnectDelay = 1000;
          this.set({ state: "connected", lastError: null });
          void this.syncNow();
        } else if (name === "changes") {
          void this.pullNow();
        } else if (name === "modules") {
          void this.enqueue(async () => {
            await this.refreshModules();
            await this.push();
          });
        } else if (name === "revoked") {
          this.revoked();
        }
      },
      close: (err) => {
        this.stream = null;
        if (this.stopped || this.st.state === "revoked") return;
        if (err instanceof AccessRevokedError) return this.revoked(err);
        this.set({ state: "offline", lastError: err?.message ?? this.st.lastError });
        const delay = Math.min(this.reconnectDelay, this.opt.maxReconnectMs);
        this.reconnectDelay = Math.min(delay * 2, this.opt.maxReconnectMs);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      },
    });
  }
}
```

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/courier test`. Expected: PASS (engine and live tests).

- [ ] **Step 5: Commit** `feat(courier): push on write (watch + debounce), SSE doorbell, 30 s retry, revoked stops (sync v1 plan 3)`

---

### Task 5: Start at login, per OS (dry-run tested)

**Files:**
- Create: `courier/src/autostart.ts`, `courier/test/autostart.test.ts`
- Modify: `courier/src/index.ts`

**Interfaces produced:** `AutostartContext`, `AutostartPlan`, `autostartPlan(ctx)`, `installAutostart(plan, deps)`, `removeAutostart(plan, deps) -> notes`, `TASK_NAME`, `LAUNCHD_LABEL`, `SYSTEMD_UNIT`.

- **Windows:** a Task Scheduler task `CollabSync` registered from an XML definition (`%SystemRoot%\System32\schtasks.exe /Create /TN CollabSync /XML <file> /F`), with a `LogonTrigger` for THIS user and `LeastPrivilege`. Plain `schtasks /SC ONLOGON` needs admin rights; a per-user logon trigger from XML is expected not to (verify on Windows). The action runs `node bin.js sync start`, which spawns the hidden background courier and exits (a console window may flash briefly at login: verify on Windows). The XML is UTF-16LE with a BOM (what schtasks expects) and CRLF line ends.
- **macOS:** `~/Library/LaunchAgents/com.collab.sync.plist` running `node bin.js sync run` (`RunAtLoad`); the file is the registration (read at login); removal also runs `/bin/launchctl bootout gui/<uid>/com.collab.sync`.
- **Linux:** `~/.config/systemd/user/collab-sync.service` + `/usr/bin/systemctl --user daemon-reload` + `enable`; removal: `disable`, delete, `daemon-reload`.
- Removal is best effort ("already gone" is fine) and returns notes; installation failing is an error that names the command.

- [ ] **Step 1: Write the failing tests** (dry-run only: every test injects `run/write/remove`; nothing touches the OS).

```ts
// file: courier/test/autostart.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type Command } from '../src/autostart.js';

// Dry-run only: nothing here registers anything with the OS.
const win: AutostartContext = {
  platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', binPath: 'C:\\tools\\R&D\\internal_tools\\courier\\dist\\bin.js',
  home: 'C:\\Users\\naveen', env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'LAPTOP1', USERNAME: 'naveen' },
  courierDir: 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier', logPath: 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier\\courier.log',
};

function recorder() {
  const ran: Command[] = [], wrote: Array<[string, Buffer]> = [], removed: string[] = [];
  return { ran, wrote, removed, deps: { run: (c: Command) => { ran.push(c); }, write: (p: string, b: Buffer) => { wrote.push([p, b]); }, remove: (p: string) => { removed.push(p); } } };
}

test('Windows: a Task Scheduler task from an XML definition, schtasks by full path', () => {
  const p = autostartPlan(win);
  assert.equal(p.kind, 'windows-task');
  assert.deepEqual(p.install, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Create', '/TN', 'CollabSync', '/XML', 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier\\collab-sync-task.xml', '/F'] }]);
  assert.deepEqual(p.remove, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Delete', '/TN', 'CollabSync', '/F'] }]);
  const bytes = p.files[0].content;
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'UTF-16LE with BOM');
  const text = bytes.subarray(2).toString('utf16le');
  assert.match(text, /<LogonTrigger>[\s\S]*<UserId>LAPTOP1\\naveen<\/UserId>/);
  assert.match(text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(text, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(text, /<Arguments>&quot;C:\\tools\\R&amp;D\\internal_tools\\courier\\dist\\bin.js&quot; sync start<\/Arguments>/);
  assert.match(text, /\r\n/);
  assert.match(p.describe.join('\n'), /autostart off/);
  assert.match(p.describe.join('\n'), /without admin/);
});

test('Windows falls back to %windir% and C:\\Windows for System32', () => {
  assert.equal(autostartPlan({ ...win, env: { windir: 'D:\\WIN', USERNAME: 'n' } }).install[0].file, 'D:\\WIN\\System32\\schtasks.exe');
  assert.equal(autostartPlan({ ...win, env: { USERNAME: 'n' } }).install[0].file, 'C:\\Windows\\System32\\schtasks.exe');
});

test('macOS: a LaunchAgent plist; the file is the registration', () => {
  const p = autostartPlan({ ...win, platform: 'darwin', nodePath: '/opt/homebrew/bin/node', binPath: '/Users/n/it/courier/dist/bin.js', home: '/Users/n', env: {}, logPath: '/Users/n/l.log', uid: 501 });
  assert.equal(p.files[0].path, '/Users/n/Library/LaunchAgents/com.collab.sync.plist');
  const text = p.files[0].content.toString('utf8');
  assert.match(text, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/n\/it\/courier\/dist\/bin.js<\/string>\s*<string>sync<\/string>\s*<string>run<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.deepEqual(p.install, []);
  assert.deepEqual(p.remove, [{ file: '/bin/launchctl', args: ['bootout', 'gui/501/com.collab.sync'] }]);
});

test('Linux: a systemd user unit, quoted and %-escaped', () => {
  const p = autostartPlan({ ...win, platform: 'linux', nodePath: '/usr/bin/node', binPath: '/home/n/100% it/courier/dist/bin.js', home: '/home/n', env: {}, systemctl: '/usr/bin/systemctl' });
  assert.equal(p.files[0].path, '/home/n/.config/systemd/user/collab-sync.service');
  assert.match(p.files[0].content.toString('utf8'), /^ExecStart="\/usr\/bin\/node" "\/home\/n\/100%% it\/courier\/dist\/bin.js" sync run$/m);
  assert.deepEqual(p.install.map((c) => c.args), [['--user', 'daemon-reload'], ['--user', 'enable', 'collab-sync.service']]);
  assert.deepEqual(p.remove.map((c) => c.args), [['--user', 'disable', 'collab-sync.service']]);
  assert.deepEqual(p.afterRemove.map((c) => c.args), [['--user', 'daemon-reload']]);
  assert.equal(autostartPlan({ ...win, platform: 'linux', home: '/h', env: { XDG_CONFIG_HOME: '/cfg' } }).files[0].path, '/cfg/systemd/user/collab-sync.service');
});

test('install writes then runs; remove runs, deletes, and tolerates "already gone"', () => {
  const p = autostartPlan(win);
  const r = recorder();
  installAutostart(p, r.deps);
  assert.deepEqual(r.wrote.map(([path]) => path), [p.files[0].path]);
  assert.deepEqual(r.ran, p.install);
  const r2 = recorder();
  const notes = removeAutostart(p, { ...r2.deps, run: () => { throw new Error('ERROR: The system cannot find the file specified.'); } });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /already removed/);
  assert.deepEqual(r2.removed, [p.files[0].path]);
  assert.throws(() => installAutostart(p, { ...r.deps, run: () => { throw new Error('Access is denied.'); } }), /could not register start-at-login[\s\S]*Access is denied/);
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/autostart.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: courier/src/autostart.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";

// Start-at-login (spec D6): opt-in, default NO, never silent. Each OS gets a
// PURE plan (files + commands + plain-language description) so the exact
// effect can be printed and tested without registering anything. System tools
// are called by FULL path: on Windows, Git Bash's GNU tools have shadowed
// Windows ones before.

export interface AutostartContext {
  platform: NodeJS.Platform;
  /** The node executable (process.execPath). */
  nodePath: string;
  /** courier/dist/bin.js */
  binPath: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Where the Windows task definition is kept (the courier folder). */
  courierDir: string;
  /** Where launchd sends the courier's output (macOS). */
  logPath: string;
  /** macOS: the user's uid, for launchctl's gui/<uid> domain. */
  uid?: number;
  /** Linux: the systemctl binary. */
  systemctl?: string;
}

export interface Command { file: string; args: string[] }

export interface AutostartPlan {
  kind: "windows-task" | "launchd" | "systemd-user";
  name: string;
  files: Array<{ path: string; content: Buffer }>;
  install: Command[];
  /** Run before the files are deleted. */
  remove: Command[];
  /** Run after the files are deleted. */
  afterRemove: Command[];
  /** Printed by setup and `autostart on|off`: what, where, how to remove. */
  describe: string[];
}

export const TASK_NAME = "CollabSync";
export const LAUNCHD_LABEL = "com.collab.sync";
export const SYSTEMD_UNIT = "collab-sync.service";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function autostartPlan(c: AutostartContext): AutostartPlan {
  if (c.platform === "win32") {
    const schtasks = win32.join(c.env.SystemRoot || c.env.windir || "C:\\Windows", "System32", "schtasks.exe");
    const user = c.env.USERDOMAIN && c.env.USERNAME ? `${c.env.USERDOMAIN}\\${c.env.USERNAME}` : c.env.USERNAME ?? "";
    const xmlPath = win32.join(c.courierDir, "collab-sync-task.xml");
    // A LogonTrigger limited to this user + LeastPrivilege: a standard user can
    // register it (schtasks /SC ONLOGON without /XML needs admin rights).
    const body = [
      `<?xml version="1.0" encoding="UTF-16"?>`,
      `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
      `  <RegistrationInfo>`,
      `    <Description>Collab notes sync: starts the courier when you log in. Remove with: collab sync autostart off</Description>`,
      `  </RegistrationInfo>`,
      `  <Triggers>`,
      `    <LogonTrigger>`,
      `      <Enabled>true</Enabled>`,
      `      <UserId>${xml(user)}</UserId>`,
      `    </LogonTrigger>`,
      `  </Triggers>`,
      `  <Principals>`,
      `    <Principal id="Author">`,
      `      <UserId>${xml(user)}</UserId>`,
      `      <LogonType>InteractiveToken</LogonType>`,
      `      <RunLevel>LeastPrivilege</RunLevel>`,
      `    </Principal>`,
      `  </Principals>`,
      `  <Settings>`,
      `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
      `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
      `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
      `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
      `    <Enabled>true</Enabled>`,
      `  </Settings>`,
      `  <Actions Context="Author">`,
      `    <Exec>`,
      `      <Command>${xml(c.nodePath)}</Command>`,
      `      <Arguments>${xml(`"${c.binPath}" sync start`)}</Arguments>`,
      `    </Exec>`,
      `  </Actions>`,
      `</Task>`,
      ``,
    ].join("\r\n");
    // schtasks reads an XML task definition as UTF-16 (little-endian, with BOM).
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    return {
      kind: "windows-task",
      name: TASK_NAME,
      files: [{ path: xmlPath, content }],
      install: [{ file: schtasks, args: ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"] }],
      remove: [{ file: schtasks, args: ["/Delete", "/TN", TASK_NAME, "/F"] }],
      afterRemove: [],
      describe: [
        `Windows Task Scheduler task "${TASK_NAME}": at your logon, as you, without admin rights, runs`,
        `  "${c.nodePath}" "${c.binPath}" sync start`,
        `its definition is kept at ${xmlPath}`,
        `remove it with: collab sync autostart off   (or: "${schtasks}" /Delete /TN ${TASK_NAME} /F)`,
      ],
    };
  }

  if (c.platform === "darwin") {
    const plist = posix.join(c.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const body = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      `    <string>${xml(c.nodePath)}</string>`,
      `    <string>${xml(c.binPath)}</string>`,
      `    <string>sync</string>`,
      `    <string>run</string>`,
      `  </array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>StandardOutPath</key><string>${xml(c.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(c.logPath)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    return {
      kind: "launchd",
      name: LAUNCHD_LABEL,
      files: [{ path: plist, content: Buffer.from(body, "utf8") }],
      install: [], // ~/Library/LaunchAgents is read at login: the file is the registration
      remove: [{ file: "/bin/launchctl", args: ["bootout", `gui/${c.uid ?? 501}/${LAUNCHD_LABEL}`] }],
      afterRemove: [],
      describe: [
        `macOS LaunchAgent ${LAUNCHD_LABEL}: at your next login, runs "${c.nodePath}" "${c.binPath}" sync run`,
        `file: ${plist}`,
        `remove it with: collab sync autostart off   (or delete that file)`,
      ],
    };
  }

  // Linux (and other Unixes with systemd): a user unit, no root needed.
  const unitDir = posix.join(c.env.XDG_CONFIG_HOME || posix.join(c.home, ".config"), "systemd", "user");
  const unit = posix.join(unitDir, SYSTEMD_UNIT);
  const systemctl = c.systemctl ?? "/usr/bin/systemctl";
  // systemd unit quoting: "..." with \\ and \" escaped; % is a specifier, so %%.
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  const body = [
    `[Unit]`,
    `Description=Collab notes sync courier (remove with: collab sync autostart off)`,
    ``,
    `[Service]`,
    `ExecStart=${q(c.nodePath)} ${q(c.binPath)} sync run`,
    `Restart=on-failure`,
    `RestartSec=30`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
  return {
    kind: "systemd-user",
    name: SYSTEMD_UNIT,
    files: [{ path: unit, content: Buffer.from(body, "utf8") }],
    install: [
      { file: systemctl, args: ["--user", "daemon-reload"] },
      { file: systemctl, args: ["--user", "enable", SYSTEMD_UNIT] },
    ],
    remove: [{ file: systemctl, args: ["--user", "disable", SYSTEMD_UNIT] }],
    afterRemove: [{ file: systemctl, args: ["--user", "daemon-reload"] }],
    describe: [
      `systemd user unit ${SYSTEMD_UNIT} (enabled: starts at your login), runs "${c.nodePath}" "${c.binPath}" sync run`,
      `file: ${unit}`,
      `remove it with: collab sync autostart off   (or: systemctl --user disable ${SYSTEMD_UNIT} and delete that file)`,
    ],
  };
}

export interface AutostartDeps {
  run?: (c: Command) => void;
  write?: (path: string, content: Buffer) => void;
  remove?: (path: string) => void;
}

const real: Required<AutostartDeps> = {
  run: (c) => { execFileSync(c.file, c.args, { stdio: "pipe", windowsHide: true }); },
  write: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
  remove: (path) => rmSync(path, { force: true }),
};

export function installAutostart(plan: AutostartPlan, deps: AutostartDeps = {}): void {
  const d = { ...real, ...deps };
  for (const f of plan.files) d.write(f.path, f.content);
  for (const c of plan.install) {
    try {
      d.run(c);
    } catch (e) {
      throw new Error(`could not register start-at-login (${c.file} ${c.args.join(" ")}): ${(e as Error).message}`);
    }
  }
}

/** Best effort: removing something already gone is fine. Returns notes about steps that failed. */
export function removeAutostart(plan: AutostartPlan, deps: AutostartDeps = {}): string[] {
  const d = { ...real, ...deps };
  const notes: string[] = [];
  const attempt = (c: Command) => {
    try { d.run(c); } catch (e) { notes.push(`${c.file} ${c.args.join(" ")}: ${(e as Error).message.split("\n")[0]} (already removed?)`); }
  };
  plan.remove.forEach(attempt);
  for (const f of plan.files) d.remove(f.path);
  plan.afterRemove.forEach(attempt);
  return notes;
}
```

`index.ts`: add `export * from "./autostart.js";`.

- [ ] **Step 4: Run and confirm it passes.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(courier): opt-in start at login: Task Scheduler XML, LaunchAgent, systemd user unit (sync v1 plan 3)`

---

### Task 6: `collab sync` commands

**Files:**
- Create: `courier/src/setup.ts`, `courier/src/cli.ts`, `courier/src/bin.ts`, `courier/test/cli.test.ts`
- Modify: `courier/src/index.ts`

**Interfaces produced:** `CourierConfig`, `readCourierConfig`, `writeCourierConfig`, `setup(opts)`, `uninstall(opts)`, `runCli(argv, io, deps) -> { code, courier?, stop? }`, `USAGE`.

Commands (all print plainly what they do):
- `setup <join code> [--db <path>] [--autostart | --no-autostart] [--upload-existing]`: asks `Start sync automatically when you log in? [y/N]` unless a flag answers (no TTY => No). Order: migrate (released migrations only; `--include-staged` for rehearsals) and refuse without 0007; refuse a DB with notes unless `--upload-existing` (D11: only the DB the post office was seeded from); redeem the ONE-TIME join code BEFORE changing anything; then `enableSync` (backup first when the DB has notes), store url/pin/device/key and zeroed bookmarks in `sync_state`, write the courier config, install autostart if chosen. A refused setup leaves no trace (a notes file it created is removed). It ends with: what changed, "restart every program that writes this notes DB", which notes leave the machine, and `collab sync uninstall`.
- `start [--foreground]`: one courier per machine (pid file); spawns `collab sync run` detached and hidden (`windowsHide`), output to `courier.log`.
- `run`: the courier in the foreground (what `start`, launchd and systemd run); writes the pid file and `status.json`; `bin.ts` stops it cleanly on SIGINT/SIGTERM.
- `stop`: SIGTERM to the pid (on Windows this terminates at once; the bookmarks make that safe).
- `status [--team]`: running or not, last state (`ACCESS REVOKED` spelled out), last error, bookmarks, local changes not yet sent, start-at-login; `--team` asks the post office.
- `modules`, `share <module>`, `unshare <module>`: the team-wide list (D10).
- `autostart on|off [--dry-run]`.
- `uninstall [--yes]`: stop the courier, remove the login entry, `disableSync` the notes DB (key deleted, plain tables, notes kept), delete the courier folder; mention the setup backup and that the post office owner can revoke the device.

- [ ] **Step 1: Write the failing tests.**

```ts
// file: courier/test/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrateTo, addEntry, isSyncEnabled, hasCrrTables, getSyncValue, SYNC_KEYS } from '@collab-mcp/core';
import { tempDir, startOffice, openWriter, closeWriter, until } from './world.js';
import { runCli } from '../src/cli.js';
import type { Command } from '../src/autostart.js';

function io() {
  const out: string[] = [], err: string[] = [];
  return { out, err, text: () => out.join('\n'), io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}
function recorder() {
  const ran: Command[] = [], wrote: string[] = [], removed: string[] = [];
  return { ran, wrote, removed, deps: { run: (c: Command) => { ran.push(c); }, write: (p: string) => { wrote.push(p); }, remove: (p: string) => { removed.push(p); } } };
}
async function env() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const courierDir = join(t.dir, 'courier');
  const rec = recorder();
  const deps = (ask = '') => ({
    courierDir, ask: async () => ask, autostartDeps: rec.deps,
    autostartCtx: { platform: 'linux' as NodeJS.Platform, home: t.dir, env: {}, systemctl: '/usr/bin/systemctl' },
  });
  return { t, office, courierDir, rec, deps, db: join(t.dir, 'b', 'collab.db'), done: async () => { await office.close(); t.cleanup(); } };
}
const shared = (path: string) => { const db = openWriter(path); try { return [isSyncEnabled(db), getSyncValue(db, SYNC_KEYS.key) !== null] as const; } finally { closeWriter(db); } };

test('setup joins, turns sharing on and says exactly what it did; the default answer is no', async () => {
  const e = await env();
  try {
    const c = io();
    const r = await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], c.io, e.deps(''));
    assert.equal(r.code, 0, c.err.join('\n'));
    assert.match(c.text(), /start at login: no/);
    assert.match(c.text(), /collab sync uninstall/);
    assert.match(c.text(), /created a new, empty notes DB/);
    assert.match(c.text(), /Restart every program that writes this notes DB/);
    assert.deepEqual([e.rec.ran.length, e.rec.wrote.length], [0, 0], 'nothing registered');
    assert.deepEqual(shared(e.db), [true, true]);
    const s = io();
    await runCli(['sync', 'status'], s.io, e.deps());
    assert.match(s.text(), /not running/);
    assert.match(s.text(), /start at login: no/);
  } finally { await e.done(); }
});

test('setup asks; "y" registers the login entry and prints it', async () => {
  const e = await env();
  try {
    const c = io();
    assert.equal((await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], c.io, e.deps('y'))).code, 0);
    assert.match(c.text(), /start at login: YES/);
    assert.match(c.text(), /collab-sync\.service/);
    assert.equal(e.rec.wrote.length, 1);
    assert.deepEqual(e.rec.ran.map((x) => x.args.join(' ')), ['--user daemon-reload', '--user enable collab-sync.service']);
  } finally { await e.done(); }
});

test('a DB with notes needs --upload-existing; a refused setup changes nothing and keeps the code usable', async () => {
  const e = await env();
  try {
    const main = join(e.t.dir, 'main.db');
    const db = new Database(main);
    migrateTo(db, '0006', { includeStaged: true });
    addEntry(db, { type: 'decision', title: 'old', summary: 's' });
    db.close();
    const { code } = e.office.code('main');
    const c = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', main, '--no-autostart', '--include-staged'], c.io, e.deps())).code, 1);
    assert.match(c.err.join('\n'), /--upload-existing/);
    assert.equal(existsSync(e.courierDir), false);
    const c2 = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', main, '--no-autostart', '--include-staged', '--upload-existing'], c2.io, e.deps())).code, 0, c2.err.join('\n'));
    assert.match(c2.text(), /backup first/);
  } finally { await e.done(); }
});

test('a used join code is refused and leaves no notes file behind', async () => {
  const e = await env();
  try {
    const { code } = e.office.code('b');
    assert.equal((await runCli(['sync', 'setup', code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps())).code, 0);
    const other = join(e.t.dir, 'c', 'collab.db');
    const c = io();
    assert.equal((await runCli(['sync', 'setup', code, '--db', other, '--no-autostart', '--include-staged'], c.io, { ...e.deps(), courierDir: join(e.t.dir, 'courier2') })).code, 1);
    assert.match(c.err.join('\n'), /refused the join code/);
    assert.equal(existsSync(other), false);
  } finally { await e.done(); }
});

test('modules, share, status --team talk to the post office', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const c = io();
    assert.equal((await runCli(['sync', 'share', 'team'], c.io, e.deps())).code, 0);
    assert.match(c.text(), /team/);
    const m = io();
    await runCli(['sync', 'modules'], m.io, e.deps());
    assert.match(m.text(), /shared modules \(for the whole team\): team/);
    const s = io();
    await runCli(['sync', 'status', '--team'], s.io, e.deps());
    assert.match(s.text(), /team \(deliveries/);
    assert.match(s.text(), /\bb\b/);
  } finally { await e.done(); }
});

test('autostart on --dry-run shows the Windows commands and registers nothing', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const c = io();
    const winDeps = { ...e.deps(), autostartCtx: { platform: 'win32' as NodeJS.Platform, env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'PC', USERNAME: 'n' }, nodePath: 'C:\\node\\node.exe', binPath: 'C:\\it\\courier\\dist\\bin.js', courierDir: 'C:\\Users\\n\\AppData\\Local\\collab\\courier' } };
    assert.equal((await runCli(['sync', 'autostart', 'on', '--dry-run'], c.io, winDeps)).code, 0);
    assert.match(c.text(), /dry run: nothing is registered/);
    assert.match(c.text(), /run "C:\\Windows\\System32\\schtasks\.exe" \/Create \/TN CollabSync \/XML/);
    assert.deepEqual([e.rec.ran.length, e.rec.wrote.length], [0, 0]);
  } finally { await e.done(); }
});

test('uninstall --yes removes everything setup added; the notes stay', async () => {
  const e = await env();
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--include-staged'], io().io, e.deps('y'));
    const w = openWriter(e.db);
    w.prepare(`INSERT INTO entries (ulid, id, title, summary) VALUES ('01J0000000000000000000000A', 7, 'kept', 's')`).run();
    closeWriter(w);
    const c = io();
    assert.equal((await runCli(['sync', 'uninstall', '--yes'], c.io, e.deps())).code, 0, c.err.join('\n'));
    assert.match(c.text(), /removed start-at-login/);
    assert.ok(e.rec.ran.some((x) => x.args.join(' ') === '--user disable collab-sync.service'));
    assert.equal(existsSync(e.courierDir), false);
    const db = new Database(e.db);
    try {
      assert.equal(hasCrrTables(db), false);
      assert.equal(getSyncValue(db, SYNC_KEYS.key), null);
      assert.equal((db.prepare(`SELECT title FROM entries WHERE id = 7`).get() as { title: string }).title, 'kept');
    } finally { db.close(); }
    const again = io();
    assert.equal((await runCli(['sync', 'uninstall', '--yes'], again.io, e.deps())).code, 1);
  } finally { await e.done(); }
});

test('start launches ONE background courier; stop ends it', async () => {
  const e = await env();
  const saved = process.env.COLLAB_COURIER_DIR;
  process.env.COLLAB_COURIER_DIR = e.courierDir; // the child finds the same folder
  try {
    await runCli(['sync', 'setup', e.office.code('b').code, '--db', e.db, '--no-autostart', '--include-staged'], io().io, e.deps());
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const deps = { ...e.deps(), launcher: { file: process.execPath, args: ['--import', 'tsx', bin] } };
    const c = io();
    assert.equal((await runCli(['sync', 'start'], c.io, deps)).code, 0, c.err.join('\n'));
    assert.match(c.text(), /running in the background \(pid \d+\)/);
    await until(() => e.office.po.listeners().length === 1, 10_000, 'the background courier to ring in');
    const again = io();
    await runCli(['sync', 'start'], again.io, deps);
    assert.match(again.text(), /already running/);
    const s = io();
    await runCli(['sync', 'status'], s.io, deps);
    assert.match(s.text(), /running \(pid \d+\)/);
    const stop = io();
    await runCli(['sync', 'stop'], stop.io, deps);
    assert.match(stop.text(), /stopped/);
    await until(() => e.office.po.listeners().length === 0, 5000, 'the doorbell to hang up');
  } finally {
    if (saved === undefined) delete process.env.COLLAB_COURIER_DIR; else process.env.COLLAB_COURIER_DIR = saved;
    await e.done();
  }
});

test('anything else prints the usage', async () => {
  const c = io();
  assert.equal((await runCli(['sync', 'frobnicate'], c.io, { courierDir: '/nonexistent' })).code, 2);
  assert.match(c.err.join('\n'), /collab sync setup/);
  assert.equal((await runCli(['other'], io().io)).code, 2);
});
```

- [ ] **Step 2: Run and confirm it fails.** Expected: FAIL, `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Implement.**

```ts
// file: courier/src/setup.ts
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  migrate, enableSync, disableSync, isSyncEnabled, hasCrrTables, loadCrsqlite, isCrsqliteLoaded, setSyncValue,
  postOfficeTargetFromDb, parseJoinCode, requestJson, SYNC_KEYS,
} from "@collab-mcp/core";
import { COURIER_KEYS } from "./keys.js";
import { courierFiles } from "./paths.js";
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type AutostartDeps, type AutostartPlan } from "./autostart.js";

// `collab sync setup` and `collab sync uninstall` as plain functions (the CLI
// and the acceptance tests share them). Setup says exactly what it did and how
// to undo it; uninstall removes everything setup added (spec D6).

export interface CourierConfig {
  dbPath: string;
  postOffice: string;
  device: string;
  autostart: boolean;
  backup: string | null;
}

export function readCourierConfig(dir: string): CourierConfig | null {
  const f = courierFiles(dir).config;
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as CourierConfig;
}
export function writeCourierConfig(dir: string, cfg: CourierConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(courierFiles(dir).config, JSON.stringify(cfg, null, 2) + "\n");
}

function openNotes(path: string, create: boolean): Database.Database {
  const db = new Database(path, { fileMustExist: !create });
  db.pragma("journal_mode = WAL");
  if (hasCrrTables(db)) loadCrsqlite(db);
  return db;
}
function closeNotes(db: Database.Database): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) {
    try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  }
  db.close();
}

export interface SetupOptions {
  code: string;
  dbPath: string;
  courierDir: string;
  /** The answer to "Start sync automatically when you log in? [y/N]" (default no). */
  autostart: boolean;
  /** Only for the notes DB the post office was seeded from (D11). */
  uploadExisting?: boolean;
  /** Rehearsals/tests only, until 0007 is released (go-live). */
  includeStaged?: boolean;
  autostartCtx: AutostartContext;
  autostartDeps?: AutostartDeps;
  out: (line: string) => void;
}

export interface SetupResult {
  dbPath: string;
  device: string;
  created: boolean;
  backup: string | null;
  autostart: AutostartPlan | null;
}

export async function setup(o: SetupOptions): Promise<SetupResult> {
  const files = courierFiles(o.courierDir);
  if (readCourierConfig(o.courierDir)) {
    throw new Error(`this machine is already set up for sync (${files.config}); run \`collab sync uninstall\` first`);
  }
  const jc = parseJoinCode(o.code);
  const dbPath = resolve(o.dbPath);
  const created = !existsSync(dbPath);
  let backup: string | null = null;
  if (created) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openNotes(dbPath, true);
  let ok = false;
  try {
    migrate(db, { includeStaged: o.includeStaged === true });
    if (!db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0007_sync_prep'`).get()) {
      throw new Error("this build has not released migration 0007_sync_prep yet (the sync go-live step), so sharing cannot be set up");
    }
    if (isSyncEnabled(db) && postOfficeTargetFromDb(db)) throw new Error(`${dbPath} already shares notes with a post office`);
    const notes = (db.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c;
    if (notes > 0 && !o.uploadExisting) {
      throw new Error(
        `${dbPath} already holds ${notes} note(s). In v1 a new machine starts with an empty notes file (spec D11); ` +
          `only the notes DB the post office was seeded from joins with its notes. If this IS that DB, add --upload-existing.`,
      );
    }
    // The join code is one-time: redeem it BEFORE changing anything, so a bad code changes nothing.
    const r = await requestJson({ url: jc.url, fingerprint: jc.fingerprint }, "POST", "/v1/join", { device: jc.device, secret: jc.secret });
    if (r.status !== 200 || typeof r.body?.key !== "string") {
      throw new Error(`the post office refused the join code: ${r.body?.error ?? `status ${r.status}`}`);
    }
    backup = enableSync(db, { backup: notes > 0 }).backup;
    db.transaction(() => {
      setSyncValue(db, SYNC_KEYS.url, jc.url);
      setSyncValue(db, SYNC_KEYS.fingerprint, jc.fingerprint);
      setSyncValue(db, SYNC_KEYS.device, jc.device);
      setSyncValue(db, SYNC_KEYS.key, r.body.key as string);
      setSyncValue(db, COURIER_KEYS.sent, "0");
      setSyncValue(db, COURIER_KEYS.recv, "0");
    })();
    ok = true;
  } finally {
    closeNotes(db);
    // A refused setup leaves no trace: a notes file it created is removed again.
    if (!ok && created) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  }
  writeCourierConfig(o.courierDir, { dbPath, postOffice: jc.url, device: jc.device, autostart: o.autostart, backup });
  let plan: AutostartPlan | null = null;
  if (o.autostart) {
    plan = autostartPlan(o.autostartCtx);
    installAutostart(plan, o.autostartDeps);
  }

  o.out(`Sync is set up on this machine. What changed:`);
  o.out(`  - joined the post office at ${jc.url} as device ${jc.device} (its certificate is pinned: ${jc.fingerprint.slice(0, 16)}…)`);
  o.out(created ? `  - created a new, empty notes DB: ${dbPath}` : `  - notes DB: ${dbPath}`);
  o.out(`  - turned on sharing in it${backup ? ` (backup first: ${backup})` : ""}; this machine's key is stored in its local-only sync_state table`);
  o.out(`  - wrote ${files.config}`);
  if (plan) {
    o.out(`  - start at login: YES`);
    for (const line of plan.describe) o.out(`      ${line}`);
  } else {
    o.out(`  - start at login: no (start it yourself: collab sync start; change later: collab sync autostart on)`);
  }
  o.out(`Restart every program that writes this notes DB (MCP servers, the REST server) so they load cr-sqlite.`);
  o.out(`Only notes in shared modules leave this machine (see: collab sync modules). Every new note now gets its number from the post office.`);
  o.out(`To remove all of this: collab sync uninstall`);
  return { dbPath, device: jc.device, created, backup, autostart: plan };
}

export interface UninstallOptions {
  courierDir: string;
  autostartCtx: AutostartContext;
  autostartDeps?: AutostartDeps;
  /** Stops a running courier first (the CLI passes its pid-based stop). */
  stopCourier?: () => Promise<void>;
  out: (line: string) => void;
}

/** Removes everything setup added. Notes stay (received ones too); new notes get local numbers again. */
export async function uninstall(o: UninstallOptions): Promise<void> {
  const cfg = readCourierConfig(o.courierDir);
  if (!cfg) throw new Error("nothing to remove: this machine is not set up for sync");
  await o.stopCourier?.();
  o.out(`Removing sync from this machine:`);
  if (cfg.autostart) {
    const notes = removeAutostart(autostartPlan(o.autostartCtx), o.autostartDeps);
    o.out(`  - removed start-at-login${notes.length ? ` (notes: ${notes.join("; ")})` : ""}`);
  }
  if (existsSync(cfg.dbPath)) {
    const db = openNotes(cfg.dbPath, false);
    try { disableSync(db); } finally { closeNotes(db); }
    o.out(`  - turned sharing off in ${cfg.dbPath}: the key is deleted, the tables are plain again, every note stays`);
  }
  rmSync(o.courierDir, { recursive: true, force: true });
  o.out(`  - deleted ${o.courierDir}`);
  if (cfg.backup) o.out(`The backup taken at setup is still at ${cfg.backup} (delete it when you no longer need it).`);
  o.out(`Ask the post office owner to revoke ${cfg.device} if this machine should never sync again.`);
}
```

```ts
// file: courier/src/cli.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  resolveDbPath, loadCrsqlite, getSyncValue, postOfficeTargetFromDb, readOwnChanges, requestJson, type PostOfficeTarget,
} from "@collab-mcp/core";
import { Courier, type CourierStatus } from "./engine.js";
import { COURIER_KEYS } from "./keys.js";
import { courierDir as defaultCourierDir, courierFiles } from "./paths.js";
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type AutostartDeps } from "./autostart.js";
import { setup, uninstall, readCourierConfig, writeCourierConfig } from "./setup.js";

export interface Io { out(line: string): void; err(line: string): void }

export interface CliDeps {
  courierDir?: string;
  /** Asks the user; the default reads one line from a TTY and answers "" (= No) otherwise. */
  ask?: (question: string) => Promise<string>;
  autostartCtx?: Partial<AutostartContext>;
  autostartDeps?: AutostartDeps;
  /** How `start` launches `collab sync run` (default: this node + this script). */
  launcher?: { file: string; args: string[] };
  /** Courier timings (tests). */
  courierOptions?: { retryMs?: number; debounceMs?: number; maxReconnectMs?: number };
}

export interface CliResult {
  code: number;
  /** `sync run`: the running courier and how to stop it (bin.ts wires the signals). */
  courier?: Courier;
  stop?: () => Promise<void>;
}

export const USAGE = `collab sync: share chosen modules of your collab notes with your other machines

  collab sync setup <join code> [--db <notes.db>] [--autostart | --no-autostart] [--upload-existing]
  collab sync start [--foreground]      start the courier in the background
  collab sync stop
  collab sync status [--team]
  collab sync modules | share <module> | unshare <module>
  collab sync autostart on|off [--dry-run]
  collab sync uninstall [--yes]         remove everything setup added

Notes are always saved locally; the courier sends and collects them. If it is not
running, nothing is lost: it catches up when it starts.`;

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  const valued = new Set(["db"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.has(name) && argv[i + 1] !== undefined) { opt[name] = argv[i + 1]; i++; } else opt[name] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function defaultAsk(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openReadable(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true });
  loadCrsqlite(db);
  return db;
}
function closeReadable(db: Database.Database): void {
  try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  db.close();
}

export async function runCli(argv: string[], io: Io, deps: CliDeps = {}): Promise<CliResult> {
  const { pos, opt } = parseArgs(argv);
  if (pos[0] !== "sync") { io.err(USAGE); return { code: 2 }; }
  const cmd = pos[1];
  const dir = deps.courierDir ?? defaultCourierDir();
  const files = courierFiles(dir);
  const ask = deps.ask ?? defaultAsk;
  const ctx: AutostartContext = {
    platform: process.platform,
    nodePath: process.execPath,
    binPath: fileURLToPath(new URL("./bin.js", import.meta.url)),
    home: homedir(),
    env: process.env,
    courierDir: dir,
    logPath: files.log,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    ...deps.autostartCtx,
  };
  const needConfig = () => {
    const cfg = readCourierConfig(dir);
    if (!cfg) throw new Error("this machine is not set up for sync yet: collab sync setup <join code>");
    return cfg;
  };
  const target = (): PostOfficeTarget => {
    const db = openReadable(needConfig().dbPath);
    try {
      const t = postOfficeTargetFromDb(db);
      if (!t) throw new Error("no post office is configured in the notes DB; run collab sync setup again");
      return t;
    } finally { closeReadable(db); }
  };
  const stopRunning = async (): Promise<boolean> => {
    const pid = readPid(files.pid);
    if (pid === null || !isAlive(pid)) { rmSync(files.pid, { force: true }); return false; }
    process.kill(pid, "SIGTERM"); // Windows: terminates at once; the bookmarks make that safe
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
    rmSync(files.pid, { force: true });
    return true;
  };

  try {
    switch (cmd) {
      case "setup": {
        const code = pos[2];
        if (!code) throw new Error("setup needs the join code from the post office owner: collab sync setup <join code>");
        let auto: boolean;
        if (opt.autostart === true) auto = true;
        else if (opt["no-autostart"] === true) auto = false;
        else auto = /^y(es)?$/i.test((await ask("Start sync automatically when you log in? [y/N] ")).trim());
        const dbPath = typeof opt.db === "string" ? opt.db : resolveDbPath().path;
        await setup({
          code, dbPath, courierDir: dir, autostart: auto,
          uploadExisting: opt["upload-existing"] === true, includeStaged: opt["include-staged"] === true,
          autostartCtx: ctx, autostartDeps: deps.autostartDeps, out: io.out,
        });
        return { code: 0 };
      }

      case "start": {
        needConfig();
        const pid = readPid(files.pid);
        if (pid !== null && isAlive(pid)) { io.out(`the courier is already running (pid ${pid})`); return { code: 0 }; }
        if (opt.foreground === true) return runCli(["sync", "run"], io, deps);
        mkdirSync(dir, { recursive: true });
        const launcher = deps.launcher ?? { file: process.execPath, args: [...process.execArgv, process.argv[1]] };
        const logFd = openSync(files.log, "a");
        const child = spawn(launcher.file, [...launcher.args, "sync", "run"], {
          detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env: process.env,
        });
        child.unref();
        closeSync(logFd);
        for (let i = 0; i < 50 && readPid(files.pid) === null; i++) await sleep(100);
        io.out(`the courier is running in the background (pid ${child.pid}); log: ${files.log}`);
        io.out(`stop it with: collab sync stop`);
        return { code: 0 };
      }

      case "run": {
        const cfg = needConfig();
        const other = readPid(files.pid);
        if (other !== null && other !== process.pid && isAlive(other)) throw new Error(`a courier is already running (pid ${other}); one per machine`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(files.pid, String(process.pid));
        const say = (line: string) => io.out(`${new Date().toISOString()} ${line}`);
        const courier = new Courier({
          dbPath: cfg.dbPath, ...deps.courierOptions, log: say,
          onStatus: (s: CourierStatus) => { try { writeFileSync(files.status, JSON.stringify({ ...s, pid: process.pid }, null, 2)); } catch { /* status is best effort */ } },
        });
        courier.start();
        say(`courier started for ${cfg.dbPath} -> ${cfg.postOffice}`);
        const stop = async () => {
          await courier.stop();
          if (readPid(files.pid) === process.pid) rmSync(files.pid, { force: true });
          say("courier stopped");
        };
        return { code: 0, courier, stop };
      }

      case "stop": {
        io.out((await stopRunning()) ? "the courier is stopped" : "the courier was not running");
        return { code: 0 };
      }

      case "status": {
        const cfg = readCourierConfig(dir);
        if (!cfg) { io.out("sync is not set up on this machine (collab sync setup <join code>)"); return { code: 0 }; }
        const pid = readPid(files.pid);
        const running = pid !== null && isAlive(pid);
        const st = existsSync(files.status) ? (JSON.parse(readFileSync(files.status, "utf8")) as CourierStatus) : null;
        const db = openReadable(cfg.dbPath);
        let sent = 0, recv = 0, unsent = 0;
        try {
          sent = Number(getSyncValue(db, COURIER_KEYS.sent) ?? 0);
          recv = Number(getSyncValue(db, COURIER_KEYS.recv) ?? 0);
          unsent = readOwnChanges(db, sent).length;
        } finally { closeReadable(db); }
        io.out(`notes DB:     ${cfg.dbPath}`);
        io.out(`post office:  ${cfg.postOffice} (this machine: ${cfg.device})`);
        io.out(`courier:      ${running ? `running (pid ${pid})` : "not running (collab sync start)"}${st ? `, last state: ${st.state}` : ""}`);
        if (st?.state === "revoked") io.out(`              ACCESS REVOKED: ask the post office owner for a new join code`);
        if (st?.lastError) io.out(`last error:   ${st.lastError}`);
        io.out(`bookmarks:    sent up to local version ${sent}; received up to delivery #${recv}`);
        io.out(`not yet sent: ${unsent} local change(s) (private-module changes are counted but never leave)`);
        io.out(`start at login: ${cfg.autostart ? "yes" : "no"}`);
        if (opt.team === true) {
          const r = await requestJson(target(), "GET", "/v1/status");
          io.out(`team (deliveries: ${r.body?.last_seq ?? "?"}):`);
          for (const m of (r.body?.members ?? []) as Array<{ device_id: string; name: string; state: string; behind: number; last_seen_at: string | null }>) {
            io.out(`  ${m.device_id.padEnd(14)}${m.name.padEnd(22)}${(m.state === "behind" ? `behind ${m.behind}` : m.state).padEnd(18)}${m.last_seen_at ?? "-"}`);
          }
        }
        return { code: 0 };
      }

      case "modules":
      case "share":
      case "unshare": {
        let r;
        if (cmd === "modules") r = await requestJson(target(), "GET", "/v1/modules");
        else {
          const slug = pos[2];
          if (!slug) throw new Error(`${cmd} needs a module slug`);
          r = await requestJson(target(), "POST", "/v1/modules", { slug, shared: cmd === "share" });
        }
        if (r.status !== 200) throw new Error(r.body?.error ?? `the post office answered ${r.status}`);
        io.out(`shared modules (for the whole team): ${(r.body.shared as string[]).join(", ") || "(none)"}`);
        return { code: 0 };
      }

      case "autostart": {
        const cfg = needConfig();
        const on = pos[2] === "on" ? true : pos[2] === "off" ? false : null;
        if (on === null) throw new Error("autostart on|off");
        const plan = autostartPlan(ctx);
        if (opt["dry-run"] === true) {
          io.out(`dry run: nothing is registered. ${on ? "autostart on" : "autostart off"} would:`);
          for (const f of plan.files) io.out(`  ${on ? "write" : "delete"} ${f.path}`);
          for (const c of on ? plan.install : [...plan.remove, ...plan.afterRemove]) io.out(`  run "${c.file}" ${c.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
          for (const line of plan.describe) io.out(`  ${line}`);
          return { code: 0 };
        }
        if (on) {
          installAutostart(plan, deps.autostartDeps);
          io.out("start at login: ON");
          for (const line of plan.describe) io.out(`  ${line}`);
        } else {
          const notes = removeAutostart(plan, deps.autostartDeps);
          io.out(`start at login: OFF${notes.length ? ` (notes: ${notes.join("; ")})` : ""}`);
        }
        writeCourierConfig(dir, { ...cfg, autostart: on });
        return { code: 0 };
      }

      case "uninstall": {
        if (opt.yes !== true && !/^y(es)?$/i.test((await ask("Remove sync from this machine (your notes stay)? [y/N] ")).trim())) {
          io.out("nothing removed");
          return { code: 0 };
        }
        await uninstall({ courierDir: dir, autostartCtx: ctx, autostartDeps: deps.autostartDeps, out: io.out, stopCourier: async () => { await stopRunning(); } });
        return { code: 0 };
      }

      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`collab sync: ${(e as Error).message}`);
    return { code: 1 };
  }
}
```

`courier/src/bin.ts` (no marker line: the shebang must be first):

```ts
#!/usr/bin/env node
import { runCli } from "./cli.js";

const r = await runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
if (r.stop) {
  const stop = () => { void r.stop!().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  process.exitCode = r.code;
}
```

`index.ts`: add `export * from "./setup.js"; export * from "./cli.js";`.

- [ ] **Step 4: Run and confirm it passes.** Run: `npm -w @collab-mcp/courier test`. Expected: PASS. Then `npm -w @collab-mcp/courier run build && node courier/dist/bin.js sync` prints the usage (exit code 2).

- [ ] **Step 5: Commit** `feat(courier): collab sync setup/start/stop/status/share/autostart/uninstall (sync v1 plan 3)`

---

### Task 7: The 9 acceptance tests (two machines + the post office, one process)

**Files:**
- Create: `courier/test/acceptance.test.ts`

No new production code is expected. If a test fails, the fix goes into the module at fault (named in the failure), with its own unit test, and is reported as a deviation.

Notes on fidelity: each machine has a WRITER connection (what MCP/REST/scripts use; `addEntryAsync` finds the HTTPS allocator through `sync_state`) and its OWN courier connection; changes are noticed through the real file watch with the real 200 ms debounce. Only the retry (30 s) and reconnect cap (30 s) are shortened to 300 ms so the suite runs in seconds. Test 1's "search finds it" goes through `searchEntries` (what `collab_search` calls). Test 7 runs last because it locks B out.

- [ ] **Step 1: Write the tests.**

```ts
// file: courier/test/acceptance.test.ts
// The spec's 9 acceptance tests ("done" = all pass), automated with two
// simulated machines and a post office in ONE process, using temp dirs.
// A = the main laptop (existing notes; the post office is seeded from it).
// B = the second laptop (joins with an empty notes file, D11).
// Each machine has a WRITER connection (what MCP/REST/scripts use) and its
// own courier, exactly as on a real machine. Tests run in this order and
// share the world; test 7 (revoke) runs last because it locks B out.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  migrateTo, addEntry, addEntryAsync, updateEntry, deleteEntry, initModule, getModule, doctor, searchEntries,
  getSyncValue, postOfficeTargetFromDb, requestJson, newUlid, PostOfficeUnreachableError,
} from '@collab-mcp/core';
import { setModuleShared, revokeMember, seedFromNotesDb } from '@collab-mcp/post-office';
import { tempDir, startOffice, openWriter, closeWriter, until, sleep, type Office } from './world.js';
import { setup } from '../src/setup.js';
import { Courier } from '../src/engine.js';
import { COURIER_KEYS } from '../src/keys.js';

interface Machine { name: string; dbPath: string; courierDir: string; device: string; w: DB; c: Courier }
let t: ReturnType<typeof tempDir>;
let office: Office;
let A: Machine, B: Machine;
let preexistingTeamId = 0, preexistingPrivateId = 0;

const TIMING = { retryMs: 300, maxReconnectMs: 300 }; // the real defaults are 30 s; the debounce stays at 200 ms
function courier(m: Machine): Courier {
  const c = new Courier({ dbPath: m.dbPath, ...TIMING });
  c.start();
  return c;
}
const find = (db: DB, q: string) =>
  searchEntries(db, { query: q, kind: 'any', include_deprecated: false, limit: 20 }).results;
const row = (db: DB, id: number) =>
  db.prepare('SELECT ulid, title, description, needs_merge, deleted_at FROM entries WHERE id = ? ORDER BY ulid LIMIT 1').get(id) as
    | { ulid: string; title: string; description: string | null; needs_merge: number; deleted_at: string | null }
    | undefined;
const count = (db: DB) => (db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
const ctx = { platform: 'linux' as NodeJS.Platform, nodePath: 'node', binPath: 'bin.js', home: '/nowhere', env: {}, courierDir: '/nowhere', logPath: '/nowhere/log' };

before(async () => {
  t = tempDir('collab-acceptance-');
  // A: the main laptop, with notes from before sharing (0006 = today's live level).
  const aPath = join(t.dir, 'a', 'collab.db');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(t.dir, 'a'), { recursive: true });
  const seedDb = new Database(aPath);
  migrateTo(seedDb, '0006', { includeStaged: true });
  initModule(seedDb, { slug: 'team' });
  initModule(seedDb, { slug: 'private' });
  for (let i = 0; i < 30; i++) addEntry(seedDb, { type: 'session-note', title: `old note ${i}`, summary: 's', module: i % 2 ? 'team' : 'private' });
  preexistingTeamId = addEntry(seedDb, { type: 'decision', title: 'Existing ferret policy', summary: 'from before sharing', description: 'v0', module: 'team' }).id;
  preexistingPrivateId = addEntry(seedDb, { type: 'decision', title: 'Existing salary notes', summary: 'private, from before sharing', module: 'private' }).id;
  seedDb.close();

  office = await startOffice(t.dir, seedFromNotesDb(aPath));
  setModuleShared(office.store, 'team', true);

  const join1 = office.code('main laptop');
  await setup({ code: join1.code, dbPath: aPath, courierDir: join(t.dir, 'a-courier'), autostart: false, uploadExisting: true, includeStaged: true, autostartCtx: ctx, out: () => {} });
  const join2 = office.code('second laptop');
  const bPath = join(t.dir, 'b', 'collab.db');
  await setup({ code: join2.code, dbPath: bPath, courierDir: join(t.dir, 'b-courier'), autostart: false, includeStaged: true, autostartCtx: ctx, out: () => {} });

  A = { name: 'A', dbPath: aPath, courierDir: join(t.dir, 'a-courier'), device: join1.device, w: openWriter(aPath), c: null as unknown as Courier };
  B = { name: 'B', dbPath: bPath, courierDir: join(t.dir, 'b-courier'), device: join2.device, w: openWriter(bPath), c: null as unknown as Courier };
  A.c = courier(A);
  B.c = courier(B);
  // D11: the new machine downloads every shared module on first join.
  await until(() => find(B.w, 'ferret').length === 1, 10_000, 'B to receive the existing shared notes');
});

after(async () => {
  for (const m of [A, B]) { await m?.c?.stop(); if (m?.w) closeWriter(m.w); }
  await office?.close();
  t?.cleanup();
});

test('1. a note written on B appears on A within 2 s, and collab_search finds it', async () => {
  const t0 = Date.now();
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Pangolin migration plan', summary: 'written on B', module: 'team' });
  await until(() => find(A.w, 'pangolin').some((r) => r.id === id), 2000, 'A to find the note by search');
  assert.ok(Date.now() - t0 <= 2000, `took ${Date.now() - t0} ms`);
  assert.ok(id > preexistingPrivateId, 'its number came from the post office, after the seed');
});

test('2. B offline while A writes: B catches up on reconnect', async () => {
  await B.c.stop();
  const { id } = await addEntryAsync(A.w, { type: 'gotcha', title: 'Quokka cache gotcha', summary: 'written while B was away', module: 'team' });
  updateEntry(A.w, { id: preexistingTeamId, description: 'v1, edited while B was away' });
  await sleep(500);
  assert.equal(find(B.w, 'quokka').length, 0);
  B.c = courier(B);
  await until(() => find(B.w, 'quokka').some((r) => r.id === id), 5000, 'B to catch up the new note');
  await until(() => row(B.w, preexistingTeamId)?.description === 'v1, edited while B was away', 5000, 'B to catch up the edit');
});

test('3. post office offline: a new note is refused (nothing saved, the message names the post office); offline edits sync once it is back', async () => {
  const quokka = find(B.w, 'quokka')[0].id;
  await office.down();
  const before = count(B.w);
  await assert.rejects(
    addEntryAsync(B.w, { type: 'decision', title: 'Refused note', summary: 's', module: 'team' }),
    (e: unknown) => e instanceof PostOfficeUnreachableError && /post office/.test((e as Error).message) && /Nothing was written/.test((e as Error).message),
  );
  assert.equal(count(B.w), before, 'nothing saved');
  updateEntry(B.w, { id: quokka, description: 'edited on B while the post office was down' });
  await until(() => B.c.status.state === 'offline', 3000, 'B to notice');
  await sleep(700); // a few retries fail meanwhile
  await office.up();
  await until(() => row(A.w, quokka)?.description === 'edited on B while the post office was down', 5000, 'the offline edit to arrive');
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Accepted again', summary: 's', module: 'team' });
  await until(() => !!row(A.w, id), 3000, 'new notes to flow again');
});

test('4. the same note edited on A and B: different paragraphs merge; the same line becomes needs_merge', async () => {
  const { id } = await addEntryAsync(A.w, { type: 'decision', title: 'Merge target', summary: 's', description: 'para one\n\npara two', module: 'team' });
  await until(() => row(B.w, id)?.description === 'para one\n\npara two', 3000);
  await Promise.all([A.c.stop(), B.c.stop()]); // both edit without seeing the other
  updateEntry(A.w, { id, description: 'para one (A)\n\npara two' });
  updateEntry(B.w, { id, description: 'para one\n\npara two (B)' });
  A.c = courier(A);
  B.c = courier(B);
  const merged = 'para one (A)\n\npara two (B)';
  await until(() => row(A.w, id)?.description === merged && row(B.w, id)?.description === merged, 8000, 'the merged text on both');
  assert.equal(row(A.w, id)!.needs_merge, 0);

  await Promise.all([A.c.stop(), B.c.stop()]);
  updateEntry(A.w, { id, description: 'para ONE by A\n\npara two (B)' });
  updateEntry(B.w, { id, description: 'para ONE by B\n\npara two (B)' });
  A.c = courier(A);
  B.c = courier(B);
  await until(() => row(A.w, id)?.needs_merge === 1 && row(B.w, id)?.needs_merge === 1, 8000, 'needs_merge on both');
  assert.ok(getModule(A.w, 'team').needs_merge.some((n) => n.id === id), 'shown on the module card');
  assert.equal(doctor(B.w).checks.find((c) => c.name === 'sync.needs_merge')!.severity, 'warn', 'and in doctor');
  const texts = (A.w.prepare('SELECT description FROM entry_revisions WHERE entry_ulid = ?').all(row(A.w, id)!.ulid) as Array<{ description: string }>).map((r) => r.description);
  assert.ok(texts.includes('para ONE by A\n\npara two (B)') && texts.includes('para ONE by B\n\npara two (B)'), 'nothing silently lost');
});

test('5. a delete on A is gone on B and never comes back after further syncs', async () => {
  const { id } = await addEntryAsync(A.w, { type: 'decision', title: 'Wombat note to delete', summary: 's', module: 'team' });
  await until(() => find(B.w, 'wombat').length === 1, 3000);
  const ulid = row(A.w, id)!.ulid;
  deleteEntry(A.w, id);
  await until(() => find(B.w, 'wombat').length === 0, 3000, 'the delete to reach B');
  assert.ok(row(B.w, id)!.deleted_at);
  assert.throws(() => updateEntry(B.w, { id, title: 'resurrect?' }), /no entry found/);
  const { id: later } = await addEntryAsync(B.w, { type: 'decision', title: 'After the wombat', summary: 's', module: 'team' });
  updateEntry(A.w, { id: preexistingTeamId, description: 'v2, after the delete' });
  await until(() => !!row(A.w, later) && row(B.w, preexistingTeamId)?.description === 'v2, after the delete', 3000, 'further syncs');
  for (const db of [A.w, B.w, office.store]) {
    assert.ok((db.prepare('SELECT deleted_at FROM entries WHERE ulid = ?').get(ulid) as { deleted_at: string | null }).deleted_at, 'still a tombstone');
  }
  assert.equal(find(A.w, 'wombat').length + find(B.w, 'wombat').length, 0);
});

test('6. a private-module note never leaves its machine (checked on the post office store)', async () => {
  const p = await addEntryAsync(A.w, { type: 'decision', title: 'Salary bands', summary: 'private', module: 'private' });
  const loose = await addEntryAsync(A.w, { type: 'decision', title: 'No module at all', summary: 's' });
  const marker = await addEntryAsync(A.w, { type: 'decision', title: 'Marker after the private notes', summary: 's', module: 'team' });
  await until(() => !!row(B.w, marker.id), 3000, "A's courier to push past the private notes");
  for (const id of [p.id, loose.id, preexistingPrivateId]) {
    const ulid = row(A.w, id)!.ulid;
    assert.equal(office.store.prepare('SELECT 1 FROM entries WHERE ulid = ?').get(ulid), undefined, `E-${id} is on the post office`);
    assert.equal((office.store.prepare('SELECT COUNT(*) c FROM po_deliveries WHERE instr(pk, ?) > 0').get(Buffer.from(ulid)) as { c: number }).c, 0);
    assert.equal(row(B.w, id)?.ulid === ulid, false);
  }
  assert.ok(office.store.prepare('SELECT 1 FROM po_allocations WHERE ulid = ?').get(row(A.w, p.id)!.ulid), 'only its ULID went out, to get its number');
});

test('8. the courier is killed between send and acknowledgement: no loss, no duplicate', async () => {
  let armed = true;
  office.hooks.dropChangesAnswer = (device) => device === B.device && armed && !(armed = false);
  const sentBefore = Number(getSyncValue(B.w, COURIER_KEYS.sent));
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Axolotl delivery', summary: 's', module: 'team' });
  await until(() => !armed, 3000, 'the post office to accept the batch and lose the answer');
  await B.c.stop(); // "killed" before it could record the acknowledgement
  office.hooks.dropChangesAnswer = undefined;
  assert.equal(Number(getSyncValue(B.w, COURIER_KEYS.sent)), sentBefore, 'not acknowledged => bookmark unchanged');
  const deliveries = (office.store.prepare('SELECT COUNT(*) c FROM po_deliveries').get() as { c: number }).c;
  B.c = courier(B); // restarts from its bookmark and sends the same changes again
  await until(() => Number(getSyncValue(B.w, COURIER_KEYS.sent)) > sentBefore, 5000, 'the resend to be acknowledged');
  assert.equal((office.store.prepare('SELECT COUNT(*) c FROM po_deliveries').get() as { c: number }).c, deliveries, 'the resend was all duplicates');
  await until(() => !!row(A.w, id), 3000);
  for (const db of [A.w, B.w, office.store]) {
    assert.equal((db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(id) as { c: number }).c, 1, 'exactly one copy');
  }
});

test('9. doctor duplicate_entry_ids stays ok everywhere; the allocator returns the same number for a repeated ULID', async () => {
  for (const db of [A.w, B.w, office.store]) {
    assert.equal(doctor(db).checks.find((c) => c.name === 'data.duplicate_entry_ids')!.severity, 'ok');
  }
  const target = postOfficeTargetFromDb(B.w)!;
  const ulid = newUlid();
  const first = await requestJson(target, 'POST', '/v1/allocate', { ulid });
  const again = await requestJson(target, 'POST', '/v1/allocate', { ulid });
  assert.equal(first.status, 200);
  assert.equal(again.body.id, first.body.id);
});

test('7. a revoked key is refused', async () => {
  revokeMember(office.store, B.device);
  await until(() => B.c.status.state === 'revoked', 3000, 'B to be told');
  assert.match(B.c.status.lastError ?? '', /revoked/);
  await assert.rejects(
    addEntryAsync(B.w, { type: 'decision', title: 'After revoke', summary: 's', module: 'team' }),
    (e: unknown) => e instanceof PostOfficeUnreachableError && /revoked/.test((e as Error).message),
  );
  const fromB = () => office.requests.filter((r) => r.device === B.device).length;
  const n = fromB();
  await sleep(1000);
  assert.equal(fromB(), n, 'no retries or reconnects from B');
  assert.equal(B.c.pendingTimers(), 0, 'no retry or reconnect pending');
  assert.equal((await requestJson(postOfficeTargetFromDb(A.w)!, 'GET', '/v1/status')).status, 200, 'A is unaffected');
});
```

- [ ] **Step 2: Run.** Run: `npm -w @collab-mcp/courier test`. Expected: all 9 pass. Run it three times in a row to catch timing flakiness; a flaky test is a bug to root-cause, never a retry.

- [ ] **Step 3: Commit** `test(courier): the 9 sync v1 acceptance tests, two machines + post office in one process (sync v1 plan 3)`

---

### Task 8: Final verification

- [ ] **Step 1:** `npm -w @collab-mcp/core test`, `npm -w @collab-mcp/post-office test`, `npm -w @collab-mcp/courier test`: all pass; record the counts.
- [ ] **Step 2:** `npm -w @collab-mcp/core run build && npx tsc --noEmit -p mcp && npx tsc --noEmit -p server && npx tsc --noEmit -p post-office && npx tsc --noEmit -p courier`: no errors.
- [ ] **Step 3:** `git status` shows no `vendor/`, `dist/`, `*.pem`, `*.db` or join code. Push.

---

## Spec check (done before building)

| Spec item | Where |
|---|---|
| Components 2: setup with one plain command, asks `[y/N]`, `--autostart/--no-autostart` | Task 6 |
| Yes => OS login entry (Task Scheduler / launchd / systemd user), name + location printed | Tasks 5, 6 |
| No (default) => nothing registered; `start/stop/status` | Task 6 |
| `autostart on|off`, `uninstall` removes everything | Tasks 1, 5, 6 |
| Catches up from its bookmark when it starts | Tasks 3, 4; acceptance 2, 8 |
| Watch DB + WAL, ~200 ms debounce, reads `crsql_changes` since its last-sent db_version | Tasks 3, 4 |
| Filter: primary module shared; entries/refs/entry_modules/entry_revisions mapped to their entry | Task 3; acceptance 6 |
| Allocation requests (ULID only) for every new note | Plan 2 allocator; acceptance 6 |
| Send with the device key; 30 s retry; persisted bookmark; post office ignores duplicates | Tasks 3, 4; acceptance 3, 8 |
| Doorbell (SSE): fetch after bookmark, apply, re-index FTS, advance; reconnect within 30 s | Task 4; acceptance 1, 2 |
| Never blocks local work | separate process; acceptance 2, 3 (edits while offline) |
| D11 new machine starts empty, downloads shared modules on first join | Task 6 (refuses non-empty); acceptance `before` |
| Failure table: post office down / other laptop asleep / courier crash / same note on both / revoked / impostor / writer without extension | acceptance 3, 2, 8, 4, 7; Plan 2 Task 4 (pin); Plan 1 |
| Testing 1-9 | Task 7 |

Gaps found on review and fixed in this plan: (1) a module shared AFTER notes were written would never send them: backfill. (2) A note moved into a shared module would arrive as a husk (only the changed column is newer than the bookmark): sent whole. (3) Writing the bookmark on every push would wake the watch forever: written only when it changed. (4) A refused setup must not consume the DB: the join code is redeemed first, and a created file is removed on failure. (5) `schtasks /SC ONLOGON` needs admin: XML with a per-user logon trigger. (6) A spawned `sync run` must find the same courier folder in tests: `COLLAB_COURIER_DIR`. (7) Programs that opened the DB before `enableSync` would fail their next write: setup tells the user to restart them. (8) The "no retries after revoke" check must count refused requests too: the `onRequest` hook sees every request with its claimed device.

## Decisions where the spec is silent (recorded)

1. `uninstall` turns sharing OFF in the notes DB (`disableSync`): plain tables, key deleted, local numbering again; notes stay. Leaving it shared would leave a DB whose every new note is refused.
2. The courier folder is per user (`%LOCALAPPDATA%\collab\courier`, `~/Library/Application Support/collab/courier`, `$XDG_STATE_HOME/collab/courier`); `COLLAB_COURIER_DIR` overrides.
3. Setup refuses a non-empty DB unless `--upload-existing` (the DB the post office was seeded from). Importing another machine's notes is out of scope (spec "Not in v1").
4. The Windows task runs `sync start` (which spawns the hidden courier), not `sync run`, so no console window stays open.
5. Reconnect back-off starts at 1 s and doubles to the 30 s cap; retry after a failed push/pull is a flat 30 s.
6. `stop` on Windows terminates the process (no graceful signal there); safe by design (bookmarks).

## Out of scope for Plan 3

- Go-live: releasing 0007, running `collab-post-office init` on the main laptop, setup on both laptops. Not part of this run.
- A web page for team status; task sync; importing a non-empty second notes file.
