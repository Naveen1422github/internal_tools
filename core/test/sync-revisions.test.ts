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
