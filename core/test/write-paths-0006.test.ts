import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { updateEntry, updateEntryRefs } from '../src/ops/update.js';
import { supersede } from '../src/ops/supersede.js';
import { deleteEntry } from '../src/ops/delete.js';
import { backfillUlids } from '../src/backfill.js';
import { newUlid } from '../src/ulid.js';

const ulidOf = (db: any, id: number) => (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid;

testAtEachLevel('updateEntryRefs adds and removes by ulid', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  const b = addEntry(db, { type: 'decision', title: 'b', summary: 's' }).id;
  const r1 = updateEntryRefs(db, { id: b, add: [{ ref_type: 'entry', ref_value: String(a) }] });
  assert.equal(r1.added.length, 1);
  const link = db.prepare(`SELECT entry_ulid, target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
  assert.deepEqual(link, { entry_ulid: ulidOf(db, b), target_ulid: ulidOf(db, a) });
  const r2 = updateEntryRefs(db, { id: b, remove: [{ ref_type: 'entry', ref_value: String(a) }] });
  assert.equal(r2.removed.length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM refs`).get() as any).c, 0);
  assertFtsIntact(db);
});

testAtEachLevel('supersede sets superseded_by_ulid', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  const b = addEntry(db, { type: 'decision', title: 'b', summary: 's' }).id;
  supersede(db, { ids: [a], by: b });
  const row = db.prepare(`SELECT superseded_by, superseded_by_ulid, deprecated FROM entries WHERE id = ?`).get(a) as any;
  assert.deepEqual(row, { superseded_by: b, superseded_by_ulid: ulidOf(db, b), deprecated: 1 });
  assertFtsIntact(db);
});

testAtEachLevel('deleteEntry: tombstone at 0006, hard delete before', (db, level) => {
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', refs: [{ ref_type: 'file', ref_value: 'f' }] }).id;
  const res = deleteEntry(db, a);
  if (level === '0006') {
    assert.equal(res.tombstoned, true);
    const row = db.prepare(`SELECT deleted_at FROM entries WHERE id = ?`).get(a) as any;
    assert.ok(row.deleted_at, 'row kept, deleted_at set');
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM refs`).get() as any).c, 1, 'refs kept for sync');
    assert.throws(() => deleteEntry(db, a), /no entry found/);
  } else {
    assert.equal(res.tombstoned, false);
    assert.equal(db.prepare(`SELECT 1 FROM entries WHERE id = ?`).get(a), undefined);
  }
  assertFtsIntact(db);
});

test('updateEntry refuses a tombstoned entry', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's' }).id;
    deleteEntry(db, a);
    assert.throws(() => updateEntry(db, { id: a, title: 'x' }), /no entry found/);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

test('backfill never stamps author after 0006 (E-685 #7)', () => {
  // Force a non-null author so the unfixed backfill would really stamp one
  // (resolveAuthor can return null on a sandboxed host, making this vacuous).
  const prev = process.env.COLLAB_AUTHOR;
  process.env.COLLAB_AUTHOR = 'machine-that-started-next';
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, author) VALUES (?, 900, 'handoff', 'signal', 'synced', 's', NULL)`).run(newUlid());
    backfillUlids(db);
    assert.equal((db.prepare(`SELECT author FROM entries WHERE id = 900`).get() as any).author, null);
    assertFtsIntact(db);
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.COLLAB_AUTHOR; else process.env.COLLAB_AUTHOR = prev;
  }
});

testAtEachLevel('backfill resolves a link once its target appears', (db) => {
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', refs: [{ ref_type: 'entry', ref_value: 'E-777' }] }).id;
  assert.equal(backfillUlids(db).unresolvedEntryRefs.length, 1);
  const lateUlid = newUlid();
  db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, 777, 'handoff', 'signal', 'late', 's')`).run(lateUlid);
  const report = backfillUlids(db);
  assert.equal(report.unresolvedEntryRefs.length, 0);
  const link = db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ?`).get(ulidOf(db, a)) as any;
  assert.equal(link.target_ulid, lateUlid);
  assertFtsIntact(db);
});

testAtEachLevel('backfill reports an unresolved link with its entry_ulid', (db) => {
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', refs: [{ ref_type: 'entry', ref_value: 'E-778' }] }).id;
  assert.deepEqual(backfillUlids(db).unresolvedEntryRefs, [{ entry_id: a, entry_ulid: ulidOf(db, a), ref_value: 'E-778' }]);
  assertFtsIntact(db);
});

// ------------------------------------------------------------
// F3: E-numbers are non-unique at 0006. Writes by number act on the owner
// (lowest live ulid) only.
// ------------------------------------------------------------

/** Two rows sharing E-number 500, returned as [owner, sibling] (explicitly sorted, not relying on newUlid order). */
function twinsAt500(db: any): [string, string] {
  const [lo, hi] = [newUlid(), newUlid()].sort();
  const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, 500, 'decision', 'signal', ?, 's')`);
  ins.run(hi, 'sibling');
  ins.run(lo, 'owner');
  return [lo, hi];
}

test('F3: update/supersede/delete by a shared E-number touch only the owner [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const [owner, sibling] = twinsAt500(db);
    const snap = () => db.prepare(`SELECT title, superseded_by, superseded_by_ulid, deprecated, deleted_at FROM entries WHERE ulid = ?`).get(sibling);
    const before = snap();
    const row = (u: string) => db.prepare(`SELECT title, superseded_by, superseded_by_ulid, deprecated, deleted_at FROM entries WHERE ulid = ?`).get(u) as any;

    updateEntry(db, { id: 500, title: 'edited' });
    assert.equal(row(owner).title, 'edited');
    assert.deepEqual(snap(), before, 'update left the sibling alone');

    const by = addEntry(db, { type: 'decision', title: 'by', summary: 's' }).id;
    supersede(db, { ids: [500], by });
    assert.equal(row(owner).superseded_by_ulid, ulidOf(db, by));
    assert.equal(row(owner).deprecated, 1);
    assert.deepEqual(snap(), before, 'supersede left the sibling alone');

    // 'by' by a shared number resolves to the owner's ulid too.
    const other = addEntry(db, { type: 'decision', title: 'other', summary: 's' }).id;
    supersede(db, { ids: [other], by: 500 });
    assert.equal((db.prepare(`SELECT superseded_by_ulid u FROM entries WHERE id = ?`).get(other) as any).u, owner);

    assert.deepEqual(deleteEntry(db, 500), { id: 500, tombstoned: true });
    assert.ok(row(owner).deleted_at);
    assert.deepEqual(snap(), before, 'delete left the sibling alone');

    // Documented behaviour: a tombstone is never an owner, so the sibling now
    // owns E-500 and the next delete-by-number tombstones it.
    deleteEntry(db, 500);
    assert.ok(row(sibling).deleted_at);
    assert.throws(() => deleteEntry(db, 500), /no entry found/);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

// ------------------------------------------------------------
// 0006 triggers not otherwise exercised at 0006 (Task 2 review).
// ------------------------------------------------------------

test('trg_refs_fill_target_ulid fills an E-prefixed link [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
    const b = addEntry(db, { type: 'decision', title: 'b', summary: 's' }).id;
    updateEntryRefs(db, { id: b, add: [{ ref_type: 'entry', ref_value: `E-${String(a).padStart(5, '0')}` }, { ref_type: 'entry', ref_value: `#${a}` }] });
    const rows = db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ?`).all(ulidOf(db, b)) as any[];
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.target_ulid, ulidOf(db, a));
    assertFtsIntact(db);
  } finally { cleanup(); }
});

test('trg_entries_fill_superseded_ulid repairs a legacy writer [0006]', () => {
  // supersede() now writes superseded_by_ulid itself, so the trigger's WHEN
  // (twin unchanged) never fires from our code. A raw legacy-style UPDATE is
  // the only path that exercises it.
  const { db, cleanup } = dbAt('0006');
  try {
    const [owner] = twinsAt500(db);
    const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
    db.prepare(`UPDATE entries SET superseded_by = 500 WHERE ulid = ?`).run(ulidOf(db, a));
    assert.equal((db.prepare(`SELECT superseded_by_ulid u FROM entries WHERE id = ?`).get(a) as any).u, owner, 'lowest ulid wins');
    assertFtsIntact(db);
  } finally { cleanup(); }
});

test('a hard DELETE at 0006 cascades by ulid to refs, entry_modules and FTS', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const [owner, sibling] = twinsAt500(db);
    // Give both twins links; the cascade must only take the deleted row's.
    for (const u of [owner, sibling]) {
      db.prepare(`INSERT INTO refs (entry_ulid, entry_id, ref_type, ref_value) VALUES (?, 500, 'file', 'f.ts')`).run(u);
      db.prepare(`INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, 500, 'm1', 1)`).run(u);
    }
    const a = addEntry(db, { type: 'handoff', title: 'gone', summary: 's', modules: ['m1', 'm2'], refs: [{ ref_type: 'file', ref_value: 'x.ts' }] }).id;
    const aUlid = ulidOf(db, a);
    const count = (sql: string, u: string) => (db.prepare(sql).get(u) as any).c;
    const refs = `SELECT COUNT(*) c FROM refs WHERE entry_ulid = ?`;
    const mods = `SELECT COUNT(*) c FROM entry_modules WHERE entry_ulid = ?`;
    const fts = `SELECT COUNT(*) c FROM entries_fts WHERE ulid = ?`;
    assert.equal(count(refs, aUlid), 1);
    assert.equal(count(mods, aUlid), 2);
    assert.equal(count(fts, aUlid), 1);

    db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(aUlid);
    db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(owner);
    for (const u of [aUlid, owner]) {
      assert.equal(count(refs, u), 0);
      assert.equal(count(mods, u), 0);
      assert.equal(count(fts, u), 0);
    }
    assert.equal(count(refs, sibling), 1, 'sibling sharing E-500 keeps its refs');
    assert.equal(count(mods, sibling), 1, 'sibling keeps its module row');
    assert.equal(count(fts, sibling), 1, 'sibling keeps its FTS row');
    assertFtsIntact(db);
  } finally { cleanup(); }
});
