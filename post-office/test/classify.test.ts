// RnR S2 (R4, R5, R7): the classifier judges one batch per laptop transaction and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, supersede, initModule, upsertModule, setAllocator, readOwnChanges, decodeChange,
  newUlid, encodeChange, COPIED_TO_PREFIX, type RawChange,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges } from '../src/deliveries.js';
import { registerProject, type Store } from '../src/store.js';
import { setProjectMember, setOfficeRole } from '../src/access.js';
import { classify, groupKey, type Verdict, type Refusal } from '../src/classify.js';

type DB = Database.Database;
const member = (s: Store, id: string) =>
  s.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
const top = (db: DB) => (db.prepare(`SELECT COALESCE(MAX(db_version), 0) v FROM crsql_changes`).get() as { v: number }).v;
/** The laptop cells `fn` produces (one or more laptop transactions). */
async function cells(db: DB, fn: () => unknown): Promise<RawChange[]> {
  const t = top(db);
  await fn();
  return readOwnChanges(db, t).map(decodeChange);
}
let n = 0;
/** A note on the laptop; `projectUlid` is set as a laptop does it (a later column change). */
async function note(db: DB, title: string, projectUlid: string | null, module = 'm'): Promise<string> {
  const r = await addEntryAsync(db, { type: 'decision', title, summary: `${title} s`, description: `${title} body`, module, refs: [{ ref_type: 'file', ref_value: `${title}.ts` }] });
  if (projectUlid) db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(projectUlid, r.ulid);
  return r.ulid;
}
const refused = (v: Verdict): Refusal[] => [...v.groups.values()].filter((r): r is Refusal => r !== null);
const allowed = (v: Verdict) => refused(v).length === 0;
const need = (label: string, key: string, where = 'TM') => `You need "${label}" (${key}) in ${where} to do this`;

/** Office with team project TM (Owner d-own), d-con = Contributor, d-rd = Reader, d-x = no project role. */
async function world() {
  const { store, cleanup } = tempStore();
  const la = laptop();
  setAllocator({ allocate: async () => ++n });
  for (const d of ['d-own', 'd-con', 'd-rd', 'd-x']) member(store, d);
  const A = registerProject(store, { ulid: newUlid(), name: 'Team', code: 'TM' }, 'd-own').ulid;
  setProjectMember(store, null, A, 'd-con', 'Contributor');
  setProjectMember(store, null, A, 'd-rd', 'Reader');
  /** A note the office holds, created by `by`. */
  const held = async (title: string, by: string, project: string | null = A, module = 'm') => {
    let u = '';
    acceptChanges(store, by, (await cells(la.db, async () => { u = await note(la.db, title, project, module); })).map(enc));
    return u;
  };
  const role = (name: string, keys: string[], device: string) => {
    store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys) VALUES (?, ?, ?, ?)`).run(newUlid(), A, name, JSON.stringify(keys));
    setProjectMember(store, null, A, device, name);
  };
  return { store, la, A, held, role, done: () => { setAllocator(null); la.cleanup(); cleanup(); } };
}
const enc = (r: RawChange) => encodeChange(r);

test('Contributor: create, edit own -> allowed; edit any, supersede, archive, resolve -> refused naming the key', async () => {
  const w = await world();
  try {
    let u = '';
    const create = await cells(w.la.db, async () => { u = await note(w.la.db, 'new by con', w.A); });
    const v = classify(w.store, 'd-con', create);
    assert.ok(allowed(v), 'Contributor holds note.create');
    assert.ok(w.la.db.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(u));
    assert.ok(v.creations.has(u), 'the creating group is named');
    const g = groupKey(create.find((c) => c.table === 'entries' && c.cid === 'title')!);
    assert.equal(v.creations.get(u), g);
    // Reader: the same creation is refused.
    const rv = classify(w.store, 'd-rd', create);
    const rc = rv.groups.get(g)!;
    assert.deepEqual([rc.key, rc.reason, rc.ulid], ['note.create', need('Create notes', 'note.create'), u]);

    const own = await w.held('own', 'd-con');
    const theirs = await w.held('theirs', 'd-own');
    assert.ok(allowed(classify(w.store, 'd-con', await cells(w.la.db, () => updateEntry(w.la.db, { ulid: own, title: 'own, edited' })))), 'edit own');

    const editAny = await cells(w.la.db, () => updateEntry(w.la.db, { ulid: theirs, title: 'theirs, edited' }));
    const ea = refused(classify(w.store, 'd-con', editAny));
    assert.deepEqual(ea.map((r) => [r.key, r.reason, r.ulid]), [['note.edit.any', need('Edit any note', 'note.edit.any'), theirs]]);
    assert.equal(ea[0].site_id, editAny[0].site_id.toString('hex'));
    assert.equal(ea[0].db_version, editAny[0].db_version);
    assert.equal(groupKey(editAny[0]), `${ea[0].site_id}:${ea[0].db_version}`);

    const by = await w.held('replacement', 'd-con');
    const s = await cells(w.la.db, () => supersede(w.la.db, { ids: [{ ulid: own }], by: { ulid: by } }));
    assert.deepEqual(refused(classify(w.store, 'd-con', s)).map((r) => r.key), ['note.supersede']);

    const own2 = await w.held('own 2', 'd-con');
    const arch = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET deprecated = 1 WHERE ulid = ?`).run(own2));
    assert.deepEqual(refused(classify(w.store, 'd-con', arch)).map((r) => [r.key, r.reason]), [['note.archive', need('Archive notes', 'note.archive')]]);
    const del = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(own2));
    assert.deepEqual(refused(classify(w.store, 'd-con', del)).map((r) => r.key), ['note.archive']);

    let own3 = '';
    const c3 = await cells(w.la.db, async () => {
      own3 = await note(w.la.db, 'own 3', w.A);
      w.la.db.prepare(`UPDATE entries SET needs_merge = 1 WHERE ulid = ?`).run(own3);
    });
    acceptChanges(w.store, 'd-con', c3.map(enc));
    const res = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET needs_merge = 0 WHERE ulid = ?`).run(own3));
    assert.deepEqual(refused(classify(w.store, 'd-con', res)).map((r) => [r.key, r.reason]), [['merge.resolve', need('Resolve conflicts', 'merge.resolve')]]);
    assert.ok(allowed(classify(w.store, 'd-own', res)), 'the Owner may resolve');
  } finally { w.done(); }
});

test("forged author: author cell = N on R's edit to N's note is still edit.any", async () => {
  const w = await world();
  try {
    const theirs = await w.held('theirs', 'd-own');
    const forged = await cells(w.la.db, () => w.la.db.transaction(() => {
      w.la.db.prepare(`UPDATE entries SET author = 'd-own', title = 'forged' WHERE ulid = ?`).run(theirs);
    })());
    assert.ok(forged.some((c) => c.cid === 'author'), 'the batch carries an author cell');
    assert.deepEqual(refused(classify(w.store, 'd-con', forged)).map((r) => r.key), ['note.edit.any']);
    // A forged author naming the sender doesn't make it theirs either.
    const self = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET author = 'd-con' WHERE ulid = ?`).run(theirs));
    assert.deepEqual(refused(classify(w.store, 'd-con', self)).map((r) => r.key), ['note.edit.any']);
  } finally { w.done(); }
});

test('supersede side cells ride on note.supersede (role = Reader + note.supersede)', async () => {
  const w = await world();
  try {
    w.role('Superseder', ['note.view', 'note.supersede'], 'd-rd');
    const old = await w.held('old', 'd-own'), by = await w.held('new', 'd-own');
    // Backdated so the updated_at trigger cell shows (it has one-second resolution).
    acceptChanges(w.store, 'd-own', (await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET updated_at = '2000-01-01' WHERE ulid = ?`).run(old))).map(enc));
    const s = await cells(w.la.db, () => supersede(w.la.db, { ids: [{ ulid: old }], by: { ulid: by } }));
    const cids = new Set(s.map((c) => c.cid));
    for (const c of ['superseded_by', 'superseded_by_ulid', 'deprecated', 'updated_at']) assert.ok(cids.has(c), `the supersede carries ${c}`);
    assert.equal(new Set(s.map(groupKey)).size, 1, 'one laptop transaction');
    assert.ok(allowed(classify(w.store, 'd-rd', s)), 'deprecated and updated_at need no archive or edit key');
    // Control: the same role may not archive.
    const other = await w.held('other', 'd-own');
    const arch = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET deprecated = 1 WHERE ulid = ?`).run(other));
    assert.deepEqual(refused(classify(w.store, 'd-rd', arch)).map((r) => r.key), ['note.archive']);
  } finally { w.done(); }
});

test('one refused cell refuses its whole group; another group in the batch is allowed', async () => {
  const w = await world();
  try {
    const own = await w.held('own', 'd-con'), theirs = await w.held('theirs', 'd-own');
    const batch = await cells(w.la.db, () => {
      w.la.db.prepare(`UPDATE entries SET title = 'ok alone' WHERE ulid = ?`).run(own);
      w.la.db.transaction(() => {
        w.la.db.prepare(`UPDATE entries SET summary = 'mine, fine' WHERE ulid = ?`).run(own);
        w.la.db.prepare(`UPDATE entries SET summary = 'theirs, not fine' WHERE ulid = ?`).run(theirs);
      })();
    });
    const v = classify(w.store, 'd-con', batch);
    assert.equal(v.groupOf.length, batch.length);
    batch.forEach((c, i) => assert.equal(v.groupOf[i], groupKey(c)));
    assert.equal(v.groups.size, 2);
    const [g1, g2] = [...new Set(batch.map(groupKey))];
    assert.equal(v.groups.get(g1), null, 'the lone edit of the own note is accepted');
    const r = v.groups.get(g2)!;
    assert.ok(r, 'the mixed transaction is refused');
    assert.deepEqual([r.key, r.ulid, r.reason], ['note.edit.any', theirs, need('Edit any note', 'note.edit.any')]);
    const mixed = batch.filter((c) => groupKey(c) === g2).map((c) => c.pk.toString('hex'));
    assert.ok(new Set(mixed).size === 2, 'the refused group holds cells of both notes');
  } finally { w.done(); }
});

test('project_ulid change on an existing team note -> structural refusal, key null', async () => {
  const w = await world();
  try {
    const B = registerProject(w.store, { ulid: newUlid(), name: 'Other', code: 'OT' }, 'd-own').ulid;
    const STRUCT = "A note can't move between projects: copy it instead";
    for (const to of [B, null]) {
      const u = await w.held(`moving to ${to}`, 'd-own');
      const mv = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(to, u));
      assert.deepEqual(refused(classify(w.store, 'd-own', mv)).map((r) => [r.key, r.reason, r.ulid]), [[null, STRUCT, u]], `to ${to}: the Owner too`);
    }
    // An E note moved into a team project is a move too.
    const e = await w.held('e note', 'd-own', null);
    const into = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(w.A, e));
    assert.deepEqual(refused(classify(w.store, 'd-own', into)).map((r) => r.key), [null]);
    // A new note's own project cell (created this batch) is not a move.
    const fresh = await cells(w.la.db, () => note(w.la.db, 'fresh', w.A));
    assert.ok(new Set(fresh.map(groupKey)).size >= 2, 'creation and project cell are separate transactions');
    assert.ok(allowed(classify(w.store, 'd-own', fresh)));
  } finally { w.done(); }
});

test('E note and legacy shared-module note cells are never judged', async () => {
  const w = await world();
  try {
    w.store.prepare(`INSERT INTO po_shared_modules (slug) VALUES ('shared')`).run();
    const e = await w.held('e note', 'd-own', null);
    const sh = await w.held('shared note', 'd-own', null, 'shared');
    const solo = newUlid(); // a solo project the office doesn't know
    const batch = await cells(w.la.db, async () => {
      updateEntry(w.la.db, { ulid: e, title: 'e, edited' });
      w.la.db.prepare(`UPDATE entries SET deprecated = 1 WHERE ulid = ?`).run(e);
      updateEntry(w.la.db, { ulid: sh, description: 'shared, edited' });
      await note(w.la.db, 'new e note', null);
      const s = await note(w.la.db, 'solo note', solo);
      updateEntry(w.la.db, { ulid: s, title: 'solo, edited' });
    });
    const v = classify(w.store, 'd-x', batch);
    assert.ok(v.groups.size >= 6);
    assert.ok(allowed(v), 'd-x has no role anywhere and nothing is refused');
  } finally { w.done(); }
});

test('modules insert needs module.create, update needs module.edit (office keys)', async () => {
  const w = await world();
  try {
    setOfficeRole(w.store, null, 'd-x', 'Office member');
    const ins = await cells(w.la.db, () => initModule(w.la.db, { slug: 'newmod', name: 'New' }));
    assert.ok(ins.every((c) => c.table === 'modules'));
    assert.deepEqual(refused(classify(w.store, 'd-x', ins)).map((r) => [r.key, r.reason, r.ulid]),
      [['module.create', need('Create modules', 'module.create', 'this office'), null]]);
    acceptChanges(w.store, 'd-own', ins.map(enc));
    const up = await cells(w.la.db, () => upsertModule(w.la.db, { slug: 'newmod', summary: 'changed' }));
    assert.ok(up.length > 0);
    assert.deepEqual(refused(classify(w.store, 'd-x', up)).map((r) => r.key), ['module.edit']);
    setOfficeRole(w.store, null, 'd-x', 'Office admin');
    assert.ok(allowed(classify(w.store, 'd-x', up)));
    const ins2 = await cells(w.la.db, () => initModule(w.la.db, { slug: 'another', name: 'A' }));
    assert.ok(allowed(classify(w.store, 'd-x', ins2)));
  } finally { w.done(); }
});

test('a ulid in po_refused_notes is refused whatever the role', async () => {
  const w = await world();
  try {
    let u = '';
    const create = await cells(w.la.db, async () => { u = await note(w.la.db, 'once refused', w.A); });
    w.store.prepare(`INSERT INTO po_refused_notes (ulid, device_id, key) VALUES (?, 'd-rd', 'note.create')`).run(u);
    const v = classify(w.store, 'd-own', create);
    const r = refused(v);
    assert.equal(r.length, v.groups.size, 'every group of that note');
    for (const x of r) assert.deepEqual([x.key, x.ulid, x.reason], [null, u, 'this note was refused when it was created']);
  } finally { w.done(); }
});

test('R7 in one batch: a later group of a note whose creation is refused is refused too', async () => {
  const w = await world();
  try {
    let u = '';
    const batch = await cells(w.la.db, async () => {
      u = await note(w.la.db, 'reader note', w.A);
      updateEntry(w.la.db, { ulid: u, title: 'reader note, edited' });
    });
    const v = classify(w.store, 'd-rd', batch);
    const created = v.creations.get(u)!;
    assert.equal(v.groups.get(created)?.key, 'note.create');
    const later = [...v.groups.keys()].filter((g) => g !== created);
    assert.ok(later.length >= 2, 'the project cell and the edit are later groups');
    for (const g of later) assert.deepEqual([v.groups.get(g)?.key, v.groups.get(g)?.reason], [null, 'this note was refused when it was created']);
    // A later group of a note created and allowed in this batch is the sender's own.
    const cv = classify(w.store, 'd-con', batch);
    assert.ok(allowed(cv), 'Contributor: create, then edit own');
  } finally { w.done(); }
});

test('copied_to ref on a source team note is note.copy.out (R-3)', async () => {
  const w = await world();
  try {
    const src = await w.held('source', 'd-own');
    const copy = newUlid();
    const ref = await cells(w.la.db, () => w.la.db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value, target_ulid) VALUES (?, 'entry', ?, ?)`).run(src, COPIED_TO_PREFIX + copy, copy));
    assert.ok(ref.length >= 1 && ref.every((c) => c.table === 'refs'));
    assert.deepEqual(refused(classify(w.store, 'd-con', ref)).map((r) => [r.key, r.reason]), [['note.copy.out', need('Copy notes out', 'note.copy.out')]]);
    w.role('Copier', ['note.view', 'note.copy.out'], 'd-rd');
    assert.ok(allowed(classify(w.store, 'd-rd', ref)), 'copy.out alone is enough: not an edit');
    // Any other ref on someone else's note is an edit.
    const plain = await cells(w.la.db, () => w.la.db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value) VALUES (?, 'file', 'x.ts')`).run(src));
    assert.deepEqual(refused(classify(w.store, 'd-rd', plain)).map((r) => r.key), ['note.edit.any']);
  } finally { w.done(); }
});

test("not judged: children of a note the office doesn't hold, and a lone number assignment", async () => {
  const w = await world();
  try {
    let u = '';
    const all = await cells(w.la.db, async () => { u = await note(w.la.db, 'unseen', w.A); updateEntry(w.la.db, { ulid: u, title: 'unseen 2' }); });
    const children = all.filter((c) => c.table !== 'entries');
    assert.ok(children.some((c) => c.table === 'refs') && children.some((c) => c.table === 'entry_revisions'));
    const v = classify(w.store, 'd-x', children);
    assert.ok(allowed(v), "S1 holds them as '?'");
    assert.equal(v.creations.size, 0);
    const held = await w.held('pending', 'd-own');
    const num = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET id = 4242 WHERE ulid = ?`).run(held));
    assert.deepEqual(num.map((c) => c.cid), ['id']);
    assert.ok(allowed(classify(w.store, 'd-rd', num)), 'assignPendingNumber was judged at allocate (R7)');
  } finally { w.done(); }
});

test('classify 2000 cells within the Task 1 budget', async () => {
  // R-2: the classifier's own < 5 ms per 2000 cells, median of 5. It runs on every
  // batch, so it is measured warm (the JIT's first calls are not the steady state).
  const RUNS = 5, WARM = 10;
  const w = await world();
  try {
    const old: string[] = [];
    for (let i = 0; i < 40; i++) old.push(await w.held(`perf old ${i}`, 'd-con'));
    const batch = (await cells(w.la.db, async () => {
      for (const u of old) { updateEntry(w.la.db, { ulid: u, title: `${u} a` }); updateEntry(w.la.db, { ulid: u, title: `${u} b` }); }
      for (let i = 0; i < 40; i++) await note(w.la.db, `perf new ${i}`, w.A);
    })).slice(0, 2000);
    assert.equal(batch.length, 2000);
    const ms: number[] = [];
    let v: Verdict | undefined;
    for (let k = 0; k < WARM + RUNS; k++) {
      const t0 = performance.now();
      v = classify(w.store, 'd-con', batch);
      if (k >= WARM) ms.push(performance.now() - t0);
    }
    assert.ok(v!.groups.size > 50 && v!.creations.size > 0, 'it did real work');
    assert.ok(allowed(v!), 'Contributor: own edits and creations');
    const median = [...ms].sort((x, y) => x - y)[2];
    console.log(`2000 cells x ${RUNS}: R4 classify median ${median.toFixed(2)} ms (runs ${ms.map((x) => x.toFixed(2)).join(', ')})`);
    assert.ok(median < 5, `classify took ${median.toFixed(2)} ms`);
  } finally { w.done(); }
});
