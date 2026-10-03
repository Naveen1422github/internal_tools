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

test('sharing on: sync-only paths refuse to mint numbers locally', async () => {
  const { db, cleanup } = sharedDb();
  try {
    assert.throws(() => addEntry(db, { type: 'decision', title: 't', summary: 's' }), SyncAllocationRequiredError);
    // An empty task has nothing to roll up: rollup returns an empty result (it does not throw).
    assert.deepEqual(rollup(db, { task_id: 'T-999' } as any).created_entries, []);
    // With a real handoff in the task, rollup must refuse to mint a local number.
    let n = 9100;
    setAllocator({ allocate: async () => n++ });
    await addEntryAsync(db, { type: 'handoff', title: 'h', summary: 's', task_id: 'T-999' });
    assert.throws(() => rollup(db, { task_id: 'T-999' } as any), SyncAllocationRequiredError);
  } finally { setAllocator(null); db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

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
    const checks = doctor(db).checks;
    assert.equal(checks.find((x) => x.name === 'sync.extension')!.severity, 'ok');
    // sync_state and cr-sqlite's own objects are not "extra".
    for (const n of ['schema.tables', 'schema.indexes', 'schema.triggers']) {
      const c = checks.find((x) => x.name === n)!;
      assert.equal(c.severity, 'ok', `${n}: ${c.detail} ${JSON.stringify(c.items)}`);
    }
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});
