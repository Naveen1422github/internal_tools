// RnR S2 (R4, R5, R7): the classifier judges one batch per laptop transaction and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, supersede, initModule, upsertModule, setAllocator, readOwnChanges, decodeChange, applyChanges,
  migrate, migrateTo, enableSync, isCrsqliteLoaded, rootRevId,
  newUlid, encodeChange, COPIED_TO_PREFIX, type RawChange,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { budget } from './perf.js'; // strict: COLLAB_PERF=1 npx tsx --test --test-concurrency=1 test/<file>.test.ts
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
    setOfficeRole(w.store, null, 'd-own', 'Office admin'); // S2: acceptChanges judges the setup too
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
    const held = await pendingNote(w, 'pending');
    const num = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET id = 4242 WHERE ulid = ?`).run(held));
    assert.deepEqual(num.map((c) => c.cid), ['id']);
    assert.ok(allowed(classify(w.store, 'd-rd', num)), 'assignPendingNumber was judged at allocate (R7)');
  } finally { w.done(); }
});

test("forged revision owner: a held revision's entry_ulid is the office's, and moving it is refused", async () => {
  const w = await world();
  try {
    const t = await w.held('team', 'd-own');
    acceptChanges(w.store, 'd-own', (await cells(w.la.db, () => updateEntry(w.la.db, { ulid: t, title: 'team, edited' }))).map(enc));
    const e = await w.held('e note', 'd-own', null);
    const rev = rootRevId(t);
    assert.ok(w.store.prepare(`SELECT 1 FROM entry_revisions WHERE rev_id = ? AND entry_ulid = ?`).get(rev, t), 'the office holds the revision under the team note');
    // Only the text, with no entry_ulid cell: judged on the team note (the office's owner), not the E note.
    const text = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entry_revisions SET title = 'rewritten' WHERE rev_id = ?`).run(rev));
    assert.deepEqual(refused(classify(w.store, 'd-rd', text)).map((r) => [r.key, r.ulid]), [['note.edit.any', t]]);
    // The forged entry_ulid moves team history to an E note: refused outright, the Owner too.
    const mv = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entry_revisions SET entry_ulid = ?, title = 'moved' WHERE rev_id = ?`).run(e, rev));
    assert.ok(mv.some((c) => c.cid === 'entry_ulid' && c.val === e));
    for (const who of ['d-rd', 'd-own']) {
      assert.deepEqual(refused(classify(w.store, who, mv)).map((r) => [r.key, r.reason, r.ulid]), [[null, "A note's history can't move to another note", t]], who);
    }
  } finally { w.done(); }
});

test('a note written before 0009 is not judged, and moving it into a team project is refused', async () => {
  const w = await world();
  const old = new Database(w.la.path.replace(/collab\.db$/, 'old.db'));
  try {
    migrateTo(old, '0008_revision_author');
    enableSync(old);
    const r = await addEntryAsync(old, { type: 'decision', title: 'pre 0009', summary: 's', module: 'm' });
    migrate(old);
    const all = readOwnChanges(old, 0);
    assert.ok(!all.some((c) => decodeChange(c).cid === 'project_ulid'), 'no project cell anywhere');
    acceptChanges(w.store, 'd-own', all);
    assert.ok(allowed(classify(w.store, 'd-x', await cells(old, () => updateEntry(old, { ulid: r.ulid, title: 'pre 0009, edited' })))));
    const mv = await cells(old, () => old.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(w.A, r.ulid));
    assert.deepEqual(refused(classify(w.store, 'd-own', mv)).map((x) => x.key), [null]);
  } finally {
    try { if (isCrsqliteLoaded(old)) old.prepare('SELECT crsql_finalize()').get(); old.close(); } catch { /* closed */ }
    w.done();
  }
});

test('a held note whose project cell is still arriving is judged as a creation when that cell comes', async () => {
  const w = await world();
  try {
    let u = '';
    const all = await cells(w.la.db, async () => {
      const x = await addEntryAsync(w.la.db, { type: 'decision', title: 'split', summary: 's', module: 'm' });
      u = x.ulid;
      w.la.db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(w.A, u);
    });
    // The project cell is sent once, at its latest version (a later laptop transaction).
    const cut = all.findIndex((c) => c.table === 'entries' && c.cid === 'project_ulid');
    assert.ok(cut > 0 && all.slice(0, cut).some((c) => c.cid === 'series'));
    const projectGroup = groupKey(all[cut]);
    acceptChanges(w.store, 'd-rd', all.slice(0, cut).map(enc));
    const rest = all.slice(cut);
    const v = classify(w.store, 'd-rd', rest);
    assert.equal(v.creations.get(u), projectGroup);
    assert.equal(v.groups.get(projectGroup)?.key, 'note.create');
    assert.ok(allowed(classify(w.store, 'd-con', rest)));
    assert.ok(allowed(classify(w.store, 'd-rd', all.slice(0, cut))), "its first half alone: project unknown, held as '?'");
  } finally { w.done(); }
});

/** A note the office holds with no number yet (id NULL), as a pending note is. */
async function pendingNote(w: Awaited<ReturnType<typeof world>>, title: string): Promise<string> {
  let u = '';
  const c = await cells(w.la.db, async () => {
    u = await note(w.la.db, title, w.A);
    w.la.db.prepare(`UPDATE entries SET id = NULL WHERE ulid = ?`).run(u);
  });
  acceptChanges(w.store, 'd-own', c.map(enc));
  assert.equal((w.store.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(u) as { id: number | null }).id, null);
  return u;
}
const HARD = 'Notes are never hard-deleted: archive it instead';
const TWICE = 'This change was sent twice with different values: sync again';
const NUMBER = "A note's number is given by the post office";
const UNREADABLE = "This change's key can't be read: sync again";

test('fix 1: a hard delete of a held note is refused; a re-insert keeps its owner (edit, not create)', async () => {
  const w = await world();
  try {
    for (const project of [w.A, null]) {
      const u = await w.held(`deleted ${project}`, 'd-own', project);
      const del = await cells(w.la.db, () => w.la.db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(u));
      assert.ok(del.some((c) => c.table === 'entries' && c.cid === '-1' && c.cl % 2 === 0), 'a row tombstone');
      assert.deepEqual(refused(classify(w.store, 'd-own', del)).map((r) => [r.key, r.reason, r.ulid]), [[null, HARD, u]], `project ${project}: the Owner too`);
    }
    // A tombstone the office already holds (from before S2), then the laptop re-inserts the row.
    const u = await w.held('tombstoned', 'd-own');
    // Applied directly: S2's acceptChanges refuses the hard delete (only an office before S2 holds one).
    const tomb = await cells(w.la.db, () => w.la.db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(u));
    w.store.transaction(() => applyChanges(w.store, tomb))();
    assert.equal(w.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(u), undefined, 'the office has no row now');
    const back = await cells(w.la.db, () => w.la.db.prepare(
      `INSERT INTO entries (ulid, type, title, summary, module, series, project_ulid) VALUES (?, 'decision', 'back', 'b', 'm', 'TM', ?)`).run(u, w.A));
    assert.ok(back.some((c) => c.cid === '-1' && c.cl % 2 === 1), 'a re-insert (odd cl)');
    const v = classify(w.store, 'd-con', back);
    assert.ok(!v.creations.has(u), 'not a creation');
    assert.deepEqual(refused(v).map((r) => r.key), ['note.edit.any'], "d-own's note, whoever re-inserts it");
    assert.ok(allowed(classify(w.store, 'd-own', back)), 'its owner: edit own');
  } finally { w.done(); }
});

test('fix 2: two cells for one (table, pk, cid) with different values refuse every group holding them', async () => {
  const w = await world();
  try {
    const made = await cells(w.la.db, () => note(w.la.db, 'twice', w.A));
    const p = made.find((c) => c.table === 'entries' && c.cid === 'project_ulid')!;
    assert.equal(p.val, w.A);
    const forged: RawChange = { ...p, val: null, col_version: p.col_version - 1, db_version: p.db_version + 50 };
    const batch = [...made, forged]; // the low-version NULL last: "last cell wins" would say no project
    const v = classify(w.store, 'd-rd', batch);
    for (const c of [p, forged]) assert.deepEqual([v.groups.get(groupKey(c))?.key, v.groups.get(groupKey(c))?.reason], [null, TWICE]);
    // The same cell sent twice with the same value is no conflict.
    assert.ok(allowed(classify(w.store, 'd-own', [...made, { ...p, db_version: p.db_version + 50 }])));
    // entry_revisions.entry_ulid the same way.
    const t = await w.held('team', 'd-own'), e = await w.held('e', 'd-own', null);
    const ed = await cells(w.la.db, () => updateEntry(w.la.db, { ulid: t, title: 'team 2' }));
    const r = ed.find((c) => c.table === 'entry_revisions' && c.cid === 'entry_ulid' && c.val === t)!;
    const rv = classify(w.store, 'd-own', [...ed, { ...r, val: e, col_version: r.col_version - 1, db_version: r.db_version + 50 }]);
    assert.deepEqual([rv.groups.get(groupKey(r))?.key, rv.groups.get(groupKey(r))?.reason], [null, TWICE]);
  } finally { w.done(); }
});

test("fix 3: only a pending note's first number passes unjudged; other id or series changes are refused", async () => {
  const w = await world();
  try {
    const numbered = await w.held('numbered', 'd-own');
    assert.notEqual((w.store.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(numbered) as { id: number | null }).id, null);
    const renum = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET id = 999 WHERE ulid = ?`).run(numbered));
    assert.deepEqual(refused(classify(w.store, 'd-own', renum)).map((r) => [r.key, r.reason]), [[null, NUMBER]]);
    const reser = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET series = 'XX' WHERE ulid = ?`).run(numbered));
    assert.deepEqual(refused(classify(w.store, 'd-own', reser)).map((r) => [r.key, r.reason]), [[null, NUMBER]]);
    const pend = await pendingNote(w, 'pending');
    assert.ok(allowed(classify(w.store, 'd-rd', await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET id = 7 WHERE ulid = ?`).run(pend)))));
    const pend2 = await pendingNote(w, 'pending 2');
    const text = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET id = 'seven' WHERE ulid = ?`).run(pend2));
    assert.deepEqual(refused(classify(w.store, 'd-own', text)).map((r) => r.reason), [NUMBER], 'a number that is not an integer');
  } finally { w.done(); }
});

test('fix 4: supersede and archive carry only their side cells; resolve still carries the text', async () => {
  const w = await world();
  try {
    w.role('Superseder', ['note.view', 'note.supersede', 'note.archive', 'merge.resolve'], 'd-rd');
    const old = await w.held('old', 'd-own'), by = await w.held('by', 'd-own');
    const s = await cells(w.la.db, () => w.la.db.transaction(() => {
      supersede(w.la.db, { ids: [{ ulid: old }], by: { ulid: by } });
      w.la.db.prepare(`UPDATE entries SET title = 'smuggled' WHERE ulid = ?`).run(old);
    })());
    assert.deepEqual(refused(classify(w.store, 'd-rd', s)).map((r) => r.key), ['note.edit.any'], 'the title is an edit');
    const a = await w.held('archived', 'd-own');
    const arch = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET deprecated = 1, summary = 'smuggled' WHERE ulid = ?`).run(a));
    assert.deepEqual(refused(classify(w.store, 'd-rd', arch)).map((r) => r.key), ['note.edit.any']);
    const del = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(a));
    assert.ok(allowed(classify(w.store, 'd-rd', del)), 'deleted_at alone is archive');
    let m = '';
    const c = await cells(w.la.db, async () => { m = await note(w.la.db, 'merge', w.A); w.la.db.prepare(`UPDATE entries SET needs_merge = 1 WHERE ulid = ?`).run(m); });
    acceptChanges(w.store, 'd-own', c.map(enc));
    const res = await cells(w.la.db, () => w.la.db.prepare(`UPDATE entries SET needs_merge = 0, title = 'merged text' WHERE ulid = ?`).run(m));
    assert.ok(allowed(classify(w.store, 'd-rd', res)), 'resolveWithText: the text rides on merge.resolve');
  } finally { w.done(); }
});

test("fix 5: a cell whose pk can't be decoded is refused, in any table", async () => {
  const w = await world();
  try {
    const mod = await cells(w.la.db, () => initModule(w.la.db, { slug: 'mm', name: 'M' }));
    const intPk = (w.store.prepare(`SELECT crsql_pack_columns(5) pk`).get() as { pk: Buffer }).pk;
    setOfficeRole(w.store, null, 'd-x', 'Office admin');
    for (const [label, pk] of [['int', intPk], ['garbage', Buffer.from([1, 3])]] as const) {
      const bad = { ...mod[0], pk, db_version: mod[0].db_version + 50 };
      const v = classify(w.store, 'd-x', [...mod, bad]);
      assert.deepEqual([v.groups.get(groupKey(bad))?.key, v.groups.get(groupKey(bad))?.reason], [null, UNREADABLE], label);
      assert.equal(v.groups.get(groupKey(mod[0])), null, 'the good module row is still accepted');
      const ent = classify(w.store, 'd-x', [{ ...bad, table: 'entries', cid: 'title' }]);
      assert.deepEqual(refused(ent).map((r) => r.reason), [UNREADABLE], `${label} entries pk`);
    }
  } finally { w.done(); }
});

test('fix 6: a held note whose project cell is still arriving keeps its recorded owner', async () => {
  const w = await world();
  try {
    let u = '';
    const all = await cells(w.la.db, async () => {
      u = (await addEntryAsync(w.la.db, { type: 'decision', title: 'split', summary: 's', module: 'm' })).ulid;
      w.la.db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(w.A, u);
      updateEntry(w.la.db, { ulid: u, title: 'split, edited' });
    });
    const cut = all.findIndex((c) => c.table === 'entries' && c.cid === 'project_ulid');
    acceptChanges(w.store, 'd-own', all.slice(0, cut).map(enc));
    w.store.prepare(`INSERT INTO po_note_owners (ulid, device_id) VALUES (?, 'd-own')`).run(u);
    const v = classify(w.store, 'd-con', all.slice(cut));
    assert.equal(v.groups.get(v.creations.get(u)!), null, 'Contributor may create');
    const later = refused(v);
    assert.ok(later.length >= 1 && later.every((r) => r.key === 'note.edit.any'), "a later group is an edit of d-own's note");
  } finally { w.done(); }
});

test('classify 2000 cells within the Task 1 budget', async () => {
  // R-2: the classifier's own < 5 ms per 2000 cells, median of 5, each on a fresh
  // batch (as S1's stamping harness). It runs on every batch, so it is measured
  // warm: the first calls are the JIT's, not the steady state.
  const RUNS = 5, WARM = 10;
  const w = await world();
  try {
    const old: string[] = [];
    for (let i = 0; i < 40; i++) old.push(await w.held(`perf old ${i}`, 'd-con'));
    const ms: number[] = [];
    for (let k = 0; k < WARM + RUNS; k++) {
      // Edits of held notes (two each; their new revisions ride on the batch's hints) and new notes.
      const batch = await cells(w.la.db, async () => {
        for (const u of old) { updateEntry(w.la.db, { ulid: u, title: `${u} ${k}a` }); updateEntry(w.la.db, { ulid: u, title: `${u} ${k}b` }); }
        for (let i = 0; i < 55; i++) await note(w.la.db, `perf new ${k}.${i}`, w.A);
      });
      assert.ok(batch.length >= 2000, `round ${k} has ${batch.length} cells`);
      const slice = batch.slice(0, 2000);
      const t0 = performance.now();
      const v = classify(w.store, 'd-con', slice);
      ms.push(performance.now() - t0);
      assert.ok(v.groups.size > 50 && v.creations.size > 0, 'it did real work');
      assert.ok(allowed(v), 'Contributor: own edits and creations');
    }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    const cold = ms.slice(3, 3 + RUNS), warm = ms.slice(WARM);
    console.log(`2000 cells x ${RUNS}: R4 classify median ${med(warm).toFixed(2)} ms after ${WARM} warm-ups (runs ${warm.map((x) => x.toFixed(2)).join(', ')}); after 3: ${med(cold).toFixed(2)} ms`);
    assert.ok(med(warm) < budget(5), `classify took ${med(warm).toFixed(2)} ms (limit ${budget(5)})`);
  } finally { w.done(); }
});
