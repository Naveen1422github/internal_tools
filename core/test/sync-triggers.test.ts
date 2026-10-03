// file: core/test/sync-triggers.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, ship, ownChanges, dbVersion } from './helpers/sync.js';
import { updateEntry } from '../src/ops/update.js';
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

test('applying a remote change runs no local bookkeeping trigger (updated_at stays as received)', async () => {
  const a = freshDb({ shared: true }), b = freshDb({ shared: true });
  try {
    setAllocator({ allocate: async () => 101 });
    const { id } = await addEntryAsync(a.db, { type: 'decision', title: 'x', summary: 's', module: 'm' });
    a.db.prepare(`UPDATE entries SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`).run(id);
    ship(a.db, b.db);
    const v = dbVersion(a.db);
    updateEntry(a.db, { id, title: 'y' });
    // Only the title change (a later batch may carry updated_at; the trigger must not fire meanwhile).
    const rows = a.db.prepare(`SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes WHERE db_version > ? AND "table" = 'entries' AND cid = 'title'`).all(v) as any[];
    assert.equal(rows.length, 1);
    const before = (b.db.prepare(`SELECT updated_at u FROM entries WHERE id = ?`).get(id) as { u: string }).u;
    b.db.prepare(`INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rows[0].table, rows[0].pk, rows[0].cid, rows[0].val, rows[0].col_version, rows[0].db_version, rows[0].site_id, rows[0].cl, rows[0].seq);
    const after = b.db.prepare(`SELECT title, updated_at u FROM entries WHERE id = ?`).get(id) as { title: string; u: string };
    assert.equal(after.title, 'y');
    assert.equal(before, '2000-01-01 00:00:00');
    assert.equal(after.u, before, 'B did not stamp its own updated_at while applying');
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
