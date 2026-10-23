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

// A rollup note (type 'rollup' needs rollup_of_task: a table-level CHECK) must
// cross the wire. cr-sqlite merges each cell as INSERT .. ON CONFLICT DO UPDATE,
// and SQLite checks the INSERT candidate (pk + that one cell) before the conflict
// is seen: the 'rollup' cell failed whatever the order (office HTTP 400
// "constraint failed", 2026-10-23 backfill of E-261).
test('applyChanges merges a rollup note, both ways, and still refuses a row left invalid', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 261 });
    const { id } = await addEntryAsync(a.db, { type: 'decision', title: 'Archive: m', summary: 's', module: 'm' });
    const u = (a.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    a.db.prepare(`UPDATE entries SET type = 'rollup', rollup_of_task = 'module:m' WHERE ulid = ?`).run(u);
    const row = (db: typeof a.db) => db.prepare('SELECT type, rollup_of_task FROM entries WHERE ulid = ?').get(u);
    b.db.transaction(() => applyChanges(b.db, readOwnChanges(a.db, 0).map(decodeChange)))();
    assert.deepEqual(row(b.db), { type: 'rollup', rollup_of_task: 'module:m' });

    // Back off rollup: here the rollup_of_task = NULL cell is the one that fails first.
    const v = Number((a.db.prepare('SELECT crsql_db_version() v').get() as { v: number }).v);
    a.db.prepare(`UPDATE entries SET type = 'decision', rollup_of_task = NULL WHERE ulid = ?`).run(u);
    b.db.transaction(() => applyChanges(b.db, readOwnChanges(a.db, v).map(decodeChange)))();
    assert.deepEqual(row(b.db), { type: 'decision', rollup_of_task: null });

    // A 'rollup' cell with no rollup_of_task anywhere still fails, and leaves nothing behind.
    const c = freshDb({ shared: true });
    try {
      const lone = readOwnChanges(a.db, 0).map(decodeChange).filter((r) => r.table !== 'entries' || r.cid !== 'rollup_of_task')
        .map((r) => (r.table === 'entries' && r.cid === 'type' ? { ...r, val: 'rollup' } : r));
      assert.throws(() => c.db.transaction(() => applyChanges(c.db, lone))(), /CHECK constraint failed/);
      assert.equal((c.db.prepare('SELECT COUNT(*) n FROM entries').get() as { n: number }).n, 0);
      assert.equal(c.db.pragma('ignore_check_constraints', { simple: true }), 0);
    } finally { c.cleanup(); }
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); }
});
