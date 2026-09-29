import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { deleteEntry } from '../src/ops/delete.js';
import { doctor } from '../src/ops/doctor.js';
import { newUlid } from '../src/ulid.js';

const check = (db: any, name: string) => doctor(db).checks.find((c) => c.name === name)!;

testAtEachLevel('a fresh DB is healthy at every level', (db) => {
  const r = doctor(db);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.severity !== 'ok')));
  for (const n of ['schema.tables', 'schema.indexes', 'schema.triggers', 'fts.integrity']) {
    assert.equal(check(db, n).severity, 'ok', n);
  }
});

// Regression for the 144 false positives: CAST('E-214' AS INTEGER) = 0.
testAtEachLevel('E- and # links to existing entries are not orphans', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'a', summary: 's' }).id;
  addEntry(db, { type: 'decision', title: 'b', summary: 's', refs: [
    { ref_type: 'entry', ref_value: `E-${a}` }, { ref_type: 'entry', ref_value: `#${a}` },
    { ref_type: 'entry', ref_value: `E-${String(a).padStart(5, '0')}` }] });
  assert.equal(check(db, 'data.orphan_refs.entry').severity, 'ok');
  addEntry(db, { type: 'decision', title: 'c', summary: 's', refs: [{ ref_type: 'entry', ref_value: 'E-99999' }] });
  const c = check(db, 'data.orphan_refs.entry');
  assert.equal(c.severity, 'warn');
  assert.match(String(c.items![0]), /-> E-99999/);
  assertFtsIntact(db);
});

testAtEachLevel('entries_without_module uses the level-correct query (F18)', (db) => {
  assert.equal(check(db, 'data.entries_without_module').severity, 'ok');
  db.prepare(`DELETE FROM entry_modules`).run();
  addEntry(db, { type: 'decision', title: 'x', summary: 's' });
  db.prepare(`DELETE FROM entry_modules`).run();
  const c = check(db, 'data.entries_without_module');
  assert.equal(c.severity, 'warn');
  assert.ok(c.items!.length >= 1);
  assertFtsIntact(db);
});

test('duplicate E-numbers and tombstones are reported at 0006', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    const a = addEntry(db, { type: 'handoff', title: 'a', summary: 's' }).id;
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary) VALUES (?, ?, 'handoff', 'signal', 'dup', 's')`).run(newUlid(), a);
    assert.equal(check(db, 'data.duplicate_entry_ids').severity, 'warn');
    deleteEntry(db, a);
    assert.match(check(db, 'data.tombstones').detail, /1 tombstoned/);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

test('0006-only checks are absent at 0005', () => {
  const { db, cleanup } = dbAt('0005');
  try {
    const names = doctor(db).checks.map((c) => c.name);
    assert.ok(!names.includes('data.duplicate_entry_ids'));
    assert.ok(!names.includes('data.tombstones'));
  } finally { cleanup(); }
});

test('a corrupted FTS index is an error at 0006', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    addEntry(db, { type: 'decision', title: 'corrupt me', summary: 's' });
    // Drop the index leaf data while the content table keeps the rows: real
    // index corruption, invisible to row counts. Needs unsafe mode to touch shadow tables.
    db.unsafeMode(true);
    db.prepare(`DELETE FROM entries_fts_data WHERE id > 10`).run();
    db.unsafeMode(false);
    const c = check(db, 'fts.integrity');
    assert.equal(c.severity, 'error');
  } finally { cleanup(); }
});
