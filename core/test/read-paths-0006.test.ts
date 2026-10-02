import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { deleteEntry } from '../src/ops/delete.js';
import { searchEntries } from '../src/ops/search.js';
import { listRecent } from '../src/ops/list-recent.js';
import { getEntry } from '../src/ops/get.js';
import { getModule } from '../src/ops/module.js';
import { getTask } from '../src/ops/task.js';
import { exportEntries } from '../src/ops/export.js';
import { rollup, archive } from '../src/ops/rollup.js';
import { newUlid } from '../src/ulid.js';

const search = (db: any, query: string, extra: object = {}) =>
  searchEntries(db, { query, kind: 'any', include_deprecated: false, limit: 50, ...extra } as any).results.map((r: any) => r.id);

testAtEachLevel('readers find an entry by text, module and task, with its links', (db) => {
  db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`).run();
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-002', 't')`).run();
  const a = addEntry(db, { type: 'decision', title: 'quokka decision', summary: 's', module: 'm1', task_id: 'T-002',
    refs: [{ ref_type: 'file', ref_value: 'q.ts' }] }).id;
  assert.deepEqual(search(db, 'quokka'), [a]);
  assert.deepEqual(search(db, 'quokka', { module: 'm1' }), [a]);
  assert.deepEqual(getModule(db, 'm1').recent_decisions.map((r: any) => r.id), [a]);
  assert.deepEqual(getTask(db, 'T-002').recent_entries.map((r: any) => r.id), [a]);
  const full = getEntry(db, a)!;
  assert.deepEqual(full.refs, [{ ref_type: 'file', ref_value: 'q.ts' }]);
  assert.deepEqual(full.modules, ['m1']);
  const exported = exportEntries(db, { format: 'json' } as any) as any;
  const row = JSON.stringify(exported);
  assert.ok(row.includes('q.ts') && row.includes('quokka decision'));
  assertFtsIntact(db);
});

test('a tombstoned entry disappears from every list but stays readable by number', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`INSERT INTO modules (slug, name) VALUES ('m1', 'M1')`).run();
    db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-003', 't')`).run();
    const keep = addEntry(db, { type: 'decision', title: 'wombat keep', summary: 's', module: 'm1', task_id: 'T-003' }).id;
    const gone = addEntry(db, { type: 'decision', title: 'wombat gone', summary: 's', module: 'm1', task_id: 'T-003' }).id;
    // A live entry linking to `gone`: links must still resolve after the tombstone.
    const linker = addEntry(db, { type: 'session-note', title: 'linker', summary: 's',
      refs: [{ ref_type: 'entry', ref_value: String(gone) }] }).id;
    deleteEntry(db, gone);

    assert.deepEqual(search(db, 'wombat'), [keep], 'FTS search');
    assert.ok(!listRecent(db, { kind: 'any', since: '1d' } as any).results.some((r: any) => r.id === gone), 'list_recent');
    assert.ok(!getModule(db, 'm1').recent_decisions.some((r: any) => r.id === gone), 'module card');
    assert.ok(!getTask(db, 'T-003').recent_entries.some((r: any) => r.id === gone), 'task card');
    assert.ok(!JSON.stringify(exportEntries(db, { format: 'json' } as any)).includes('wombat gone'), 'export');
    const dry = rollup(db, { task_id: 'T-003', dry_run: true } as any);
    assert.ok(!dry.groups.some((g: any) => g.entry_ids.includes(gone)), 'rollup selection');
    db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00', type = 'handoff', category = 'Activity'`).run();
    const adry = archive(db, { older_than: '30d', dry_run: true } as any);
    assert.ok(!adry.groups.some((g: any) => g.entry_ids.includes(gone)), 'archive selection');
    assert.ok(adry.groups.some((g: any) => g.entry_ids.includes(keep)), 'archive still selects the live entry');

    const full = getEntry(db, gone)!;                    // D5b: still readable by number
    assert.ok(full && (full as any).deleted_at, 'getEntry returns the tombstone with deleted_at');
    assert.ok(getEntry(db, linker)!.refs.some((r) => r.ref_type === 'entry' && r.ref_value === String(gone)),
      'a link to the tombstone still resolves');
    db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);
  } finally { cleanup(); }
});

// Ruling 1: at 0006 entries_fts has an INDEXED ulid column; search must scope
// MATCH to the text columns so ulid tokens are never matched or ranked.
testAtEachLevel('search never matches ulid tokens', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'platypus', summary: 's' }).id;
  addEntry(db, { type: 'decision', title: 'echidna', summary: 's' });
  const ulid = (db.prepare(`SELECT ulid FROM entries WHERE id = ?`).get(a) as any).ulid as string;
  assert.deepEqual(search(db, '01'), [], 'ulid-like prefix 01* returns nothing');
  assert.deepEqual(search(db, ulid), [], 'a full ulid returns nothing');
  assert.deepEqual(search(db, 'platypus'), [a]);
  // User query containing FTS column-filter syntax stays literal: it neither
  // throws nor escapes the text-column scope (AND finds nothing, the OR recall
  // fallback finds platypus by its title).
  assert.deepEqual(search(db, 'ulid: platypus'), [a]);
  assert.deepEqual(search(db, `ulid : ${ulid}`), [], 'cannot reach the ulid column via user syntax');
  assert.deepEqual(search(db, 'platypus OR ulid'), [a], 'OR recall fallback still works');
  assertFtsIntact(db);
});

testAtEachLevel('search ranks with a score and auto-expands the description', (db) => {
  const a = addEntry(db, { type: 'decision', title: 'kiwi kiwi', summary: 's', description: 'body-a' }).id;
  const b = addEntry(db, { type: 'decision', title: 'kiwi', summary: 's', description: 'body-b kiwi-less padding words here' }).id;
  const r = searchEntries(db, { query: 'kiwi', kind: 'any', include_deprecated: false, limit: 50 } as any);
  assert.deepEqual(r.results.map((x) => x.id).sort(), [a, b].sort());
  assert.ok(r.results.every((x) => typeof x.score === 'number'), 'bm25 score present');
  assert.ok(r.auto_expanded);
  assert.equal(r.results.find((x) => x.id === a)!.description, 'body-a');
  assert.ok(r.results.every((x) => !('ulid' in x)), 'result shape unchanged (no ulid key)');
  // limit is honoured
  assert.equal(searchEntries(db, { query: 'kiwi', kind: 'any', include_deprecated: false, limit: 1 } as any).results.length, 1);
  assertFtsIntact(db);
});

// F3: at 0006, rollup deprecates originals by the owner's ulid, not by id.
test('F3: rollup by task deprecates only the owner of a shared E-number [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-009', 't'), ('T-008', 't')`).run();
    const [lo, hi] = [newUlid(), newUlid()].sort();
    const ins = db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, task_id) VALUES (?, 500, 'decision', 'signal', ?, 's', ?)`);
    ins.run(hi, 'sibling', 'T-008');
    ins.run(lo, 'owner', 'T-009');
    const res = rollup(db, { task_id: 'T-009' } as any);
    assert.equal(res.deprecated_count, 1);
    const dep = (u: string) => (db.prepare(`SELECT deprecated FROM entries WHERE ulid = ?`).get(u) as any).deprecated;
    assert.equal(dep(lo), 1, 'owner deprecated');
    assert.equal(dep(hi), 0, 'sibling untouched');
    assertFtsIntact(db);
  } finally { cleanup(); }
});

testAtEachLevel('rollup and archive deprecate their originals', (db) => {
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('T-010', 't')`).run();
  const a = addEntry(db, { type: 'session-note', title: 'x', summary: 's', task_id: 'T-010' }).id;
  const r = rollup(db, { task_id: 'T-010' } as any);
  assert.equal(r.deprecated_count, 1);
  assert.equal(getEntry(db, a)!.deprecated, 1);

  const b = addEntry(db, { type: 'handoff', title: 'old', summary: 's', module: 'mm' }).id;
  db.prepare(`UPDATE entries SET created_at = '2020-01-01 00:00:00', category = 'Activity' WHERE id = ?`).run(b);
  const ar = archive(db, { older_than: '30d', dry_run: false } as any);
  assert.equal(ar.deprecated_count, 1);
  assert.equal(getEntry(db, b)!.deprecated, 1);
  assertFtsIntact(db);
});
