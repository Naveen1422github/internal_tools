import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { rollup, archive } from '../src/ops/rollup.js';
import { hasUlidPrimaryKey, liveEntry, ftsJoin } from '../src/schema.js';
import { ownerOf, deleteRef, replaceLinks } from '../src/entry-write.js';
import { migrate, migrateTo } from '../src/db.js';

testAtEachLevel('addEntry writes ulid, author and ulid-keyed links', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's', module: 'm1' }).id;
  const b = addEntry(db, { type: 'gotcha', title: 'b', summary: 's', modules: ['m1', 'm2'],
    refs: [{ ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'file', ref_value: 'f.ts' }] }).id;
  assert.equal(b, a + 1);
  const rowA = db.prepare(`SELECT ulid, author FROM entries WHERE id = ?`).get(a) as any;
  const rowB = db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(b) as any;
  assert.match(rowA.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const link = db.prepare(`SELECT entry_ulid, target_ulid FROM refs WHERE ref_type = 'entry'`).get() as any;
  assert.deepEqual(link, { entry_ulid: rowB.ulid, target_ulid: rowA.ulid });
  const mods = db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(rowB.ulid);
  assert.deepEqual(mods, [{ module: 'm1', is_primary: 1 }, { module: 'm2', is_primary: 0 }]);
  assertFtsIntact(db);
});

test('new entries continue the E-number sequence after 0006', () => {
  const { db, cleanup } = dbAt('0005');
  try {
    const ids = [1, 2, 3].map((i) => addEntry(db, { type: 'handoff', title: `t${i}`, summary: 's' }).id);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(ids[2]); // number 3 was used, then deleted
    migrate(db, { includeStaged: true });                       // 0005 -> 0006
    assert.ok(hasUlidPrimaryKey(db));
    assert.equal(addEntry(db, { type: 'handoff', title: 'after', summary: 's' }).id, ids[2] + 1);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

test('counter self-heals and never falls behind max(id)', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const first = addEntry(db, { type: 'handoff', title: 'x', summary: 's' }).id;
    db.prepare(`DELETE FROM local_counters`).run();                       // lost counter row
    assert.equal(addEntry(db, { type: 'handoff', title: 'y', summary: 's' }).id, first + 1);
    db.prepare(`UPDATE entries SET id = 500 WHERE id = ?`).run(first + 1); // a label moved ahead of the counter
    assert.equal(addEntry(db, { type: 'handoff', title: 'z', summary: 's' }).id, 501);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

testAtEachLevel('rollup inserts a numbered rollup linked to its originals by ulid', (db) => {
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-009', 't')`).run();
  const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's', task_id: 'T-009' }).id;
  const res = rollup(db, { task_id: 'T-009', dry_run: false } as any);
  const rid = res.created_entries[0].id;
  assert.equal(rid, a + 1);
  const aUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(a) as any).ulid;
  const rUlid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(rid) as any).ulid;
  const link = db.prepare(`SELECT target_ulid FROM refs WHERE entry_ulid = ? AND ref_type = 'entry'`).get(rUlid) as any;
  assert.equal(link.target_ulid, aUlid);
  assert.equal((db.prepare(`SELECT deprecated FROM entries WHERE id = ?`).get(a) as any).deprecated, 1);
  assertFtsIntact(db);
});

testAtEachLevel('archive inserts a numbered breadcrumb', (db) => {
  const a = addEntry(db, { type: 'handoff', title: 'old', summary: 's', module: 'm1' }).id;
  db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(a);
  const res = archive(db, { older_than: '30d', dry_run: false } as any);
  assert.equal(res.created_entries.length, 1);
  assert.equal(res.created_entries[0].id, a + 1);
  assertFtsIntact(db);
});

// ------------------------------------------------------------
// ownerOf: the E-number -> entry rule every write-by-number uses (F3)
// ------------------------------------------------------------
const U1 = '00000000000000000000000001';
const U2 = '00000000000000000000000002';

test('ownerOf: two rows sharing an E-number -> lowest live ulid wins [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    // Insert the HIGHER ulid first so insertion order can't fake the result.
    db.prepare(`INSERT INTO entries (ulid, id, title, summary) VALUES (?, 7, 'second', 's')`).run(U2);
    db.prepare(`INSERT INTO entries (ulid, id, title, summary) VALUES (?, 7, 'first', 's')`).run(U1);
    assert.deepEqual(ownerOf(db, 7), { id: 7, ulid: U1 });
    db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(U1);
    assert.deepEqual(ownerOf(db, 7), { id: 7, ulid: U2 }, 'a tombstoned row is never the owner');
    db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(U2);
    assert.equal(ownerOf(db, 7), null, 'all rows tombstoned -> no owner');
    assertFtsIntact(db);
  } finally { cleanup(); }
});

testAtEachLevel('ownerOf returns {id, ulid}, and null for a missing number', (db) => {
  const id = addEntry(db, { type: 'handoff', title: 'x', summary: 's' }).id;
  const ulid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(id) as any).ulid;
  assert.deepEqual(ownerOf(db, id), { id, ulid });
  assert.equal(ownerOf(db, id + 99), null);
  assertFtsIntact(db);
});

function dbPre0005(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0004-'));
  const db = new Database(join(dir, 'collab.db'));
  migrateTo(db, '0004');
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('pre-0005: ownerOf returns {id, ulid: null}; deleteRef/replaceLinks key on entry_id', () => {
  const { db, cleanup } = dbPre0005();
  try {
    const id = addEntry(db, { type: 'handoff', title: 'x', summary: 's', module: 'm1',
      refs: [{ ref_type: 'file', ref_value: 'a.ts' }, { ref_type: 'file', ref_value: 'b.ts' }] }).id;
    const owner = ownerOf(db, id);
    assert.deepEqual(owner, { id, ulid: null });
    assert.equal(ownerOf(db, id + 99), null);
    assert.equal(deleteRef(db, owner!, { ref_type: 'file', ref_value: 'a.ts' }), 1);
    replaceLinks(db, owner!, ['m2'], 'm2', [{ ref_type: 'file', ref_value: 'c.ts' }]);
    assert.deepEqual(db.prepare(`SELECT ref_value FROM refs WHERE entry_id = ?`).all(id), [{ ref_value: 'c.ts' }]);
    assert.deepEqual(db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_id = ?`).all(id),
      [{ module: 'm2', is_primary: 1 }]);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

// ------------------------------------------------------------
// deleteRef / replaceLinks
// ------------------------------------------------------------
testAtEachLevel('deleteRef removes one ref of the owner', (db) => {
  const id = addEntry(db, { type: 'handoff', title: 'x', summary: 's',
    refs: [{ ref_type: 'file', ref_value: 'a.ts' }, { ref_type: 'file', ref_value: 'b.ts' }] }).id;
  const other = addEntry(db, { type: 'handoff', title: 'y', summary: 's',
    refs: [{ ref_type: 'file', ref_value: 'a.ts' }] }).id;
  const owner = ownerOf(db, id)!;
  assert.equal(deleteRef(db, owner, { ref_type: 'file', ref_value: 'a.ts' }), 1);
  assert.equal(deleteRef(db, owner, { ref_type: 'file', ref_value: 'a.ts' }), 0);
  assert.deepEqual(db.prepare(`SELECT ref_value FROM refs WHERE entry_id = ?`).all(id), [{ ref_value: 'b.ts' }]);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM refs WHERE entry_id = ?`).get(other) as any).n, 1,
    "another entry's identical ref is untouched");
  assertFtsIntact(db);
});

testAtEachLevel('replaceLinks swaps all refs and modules of the owner', (db) => {
  const target = addEntry(db, { type: 'decision', title: 't', summary: 's' }).id;
  const id = addEntry(db, { type: 'handoff', title: 'x', summary: 's', modules: ['m1', 'm2'],
    refs: [{ ref_type: 'file', ref_value: 'a.ts' }] }).id;
  const owner = ownerOf(db, id)!;
  replaceLinks(db, owner, ['m3', 'm2'], 'm3', [
    { ref_type: 'file', ref_value: 'z.ts' }, { ref_type: 'entry', ref_value: `E-${target}` }]);
  const ulid = owner.ulid!;
  assert.deepEqual(
    db.prepare(`SELECT ref_type, ref_value, target_ulid FROM refs WHERE entry_ulid = ? ORDER BY ref_type`).all(ulid),
    [{ ref_type: 'entry', ref_value: `E-${target}`, target_ulid: ownerOf(db, target)!.ulid },
     { ref_type: 'file', ref_value: 'z.ts', target_ulid: null }]);
  assert.deepEqual(
    db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(ulid),
    [{ module: 'm2', is_primary: 0 }, { module: 'm3', is_primary: 1 }]);
  assertFtsIntact(db);
});

test('0005: deleteRef and replaceLinks key on entry_id (the 0005 PK), not the trigger-filled entry_ulid (F3)', () => {
  const { db, cleanup } = dbAt('0005');
  try {
    const id = addEntry(db, { type: 'handoff', title: 'x', summary: 's', module: 'm1',
      refs: [{ ref_type: 'file', ref_value: 'a.ts' }, { ref_type: 'file', ref_value: 'b.ts' }] }).id;
    const owner = ownerOf(db, id)!;
    // A row written by a path that bypassed the trigger (script, REST) has no entry_ulid.
    db.prepare(`UPDATE refs SET entry_ulid = NULL WHERE entry_id = ?`).run(id);
    db.prepare(`UPDATE entry_modules SET entry_ulid = NULL WHERE entry_id = ?`).run(id);
    assert.equal(deleteRef(db, owner, { ref_type: 'file', ref_value: 'a.ts' }), 1);
    replaceLinks(db, owner, ['m2'], 'm2', [{ ref_type: 'file', ref_value: 'c.ts' }]);
    assert.deepEqual(db.prepare(`SELECT ref_value FROM refs WHERE entry_id = ?`).all(id), [{ ref_value: 'c.ts' }]);
    assert.deepEqual(db.prepare(`SELECT module FROM entry_modules WHERE entry_id = ?`).all(id), [{ module: 'm2' }]);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

// ------------------------------------------------------------
// schema.ts helpers
// ------------------------------------------------------------
testAtEachLevel('hasUlidPrimaryKey, liveEntry and ftsJoin match the schema level', (db, level) => {
  assert.equal(hasUlidPrimaryKey(db), level === '0006');
  const keep = addEntry(db, { type: 'handoff', title: 'alpha keep', summary: 's' }).id;
  const gone = addEntry(db, { type: 'handoff', title: 'alpha gone', summary: 's' }).id;
  if (level === '0006') db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE id = ?`).run(gone);
  const hits = db.prepare(
    `SELECT e.id FROM entries_fts ${ftsJoin(db)} WHERE entries_fts MATCH 'alpha' AND ${liveEntry(db)} ORDER BY e.id`,
  ).all().map((r: any) => r.id);
  assert.deepEqual(hits, level === '0006' ? [keep] : [keep, gone]);
  assertFtsIntact(db);
});
