// file: core/test/copy.test.ts
// Stage B2 (spec P8): notes move between worlds only by copying, on purpose.
// planCopy lists (reads only); applyCopy writes and reports exactly what changed.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { createProject, markProjectLeft } from '../src/projects.js';
import { setSyncValue } from '../src/sync/state.js';
import { SYNC_KEYS } from '../src/sync/http-allocator.js';
import { setAllocator } from '../src/sync/allocator.js';
import { readOwnChanges } from '../src/sync/changes.js';
import { sendContext, sendVerdictOf, SHARED_KEY, type NotePlace } from '../src/sync/send-filter.js';
import { planCopy, applyCopy, copyPlanLines, copyResultLines, COPIED_TO_PREFIX } from '../src/ops/copy.js';
import { getEntryByRef } from '../src/ops/get.js';
import { editEntry } from '../src/ops/edit.js';

const note = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01K${String(++n).padStart(23, '0')}`, id });
const teamRow = (db: any, code: string, fp = 'fp') =>
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', ?)`).run(`01JPR0JECT${code.padEnd(16, '0')}`, `team ${code}`, code, fp);
const row = (db: any, series: string, id: number) => db.prepare(`SELECT * FROM entries WHERE series = ? AND id = ?`).get(series, id) as any;
const refsOf = (db: any, ulid: string) =>
  db.prepare(`SELECT ref_type, ref_value, target_ulid FROM refs WHERE entry_ulid = ? ORDER BY ref_type, ref_value`).all(ulid) as any[];
const modulesOf = (db: any, ulid: string) =>
  db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(ulid) as any[];

function asAuthor<T>(name: string, fn: () => T): T {
  const saved = process.env.COLLAB_AUTHOR;
  process.env.COLLAB_AUTHOR = name;
  try { return fn(); } finally { if (saved === undefined) delete process.env.COLLAB_AUTHOR; else process.env.COLLAB_AUTHOR = saved; }
}

function world(shared = false) {
  const t = freshDb({ shared });
  migrate(t.db);
  for (const m of ['m', 'x']) initModule(t.db, { slug: m });
  createProject(t.db, { name: 'Navi', code: 'NV' });
  return t;
}

test('module -> solo project: live E notes of the module only, in number order, same content, new ulids', async () => {
  const t = world();
  try {
    asAuthor('rinku', () => addEntry(t.db, note('one', { module: 'm', description: 'body one, see E-2' })));      // E-1
    asAuthor('naveen', () => addEntry(t.db, note('two', { module: 'x', modules: ['m'], type: 'gotcha', status: 'draft' }))); // E-2
    addEntry(t.db, note('three', { module: 'x' }));                                                                 // E-3
    const four = addEntry(t.db, note('four', { module: 'm' }));                                                     // E-4
    t.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(four.ulid);
    createProject(t.db, { name: 'supporthub', code: 'SH' });
    addEntry(t.db, note('sh in m', { module: 'm', project: 'SH' }));                                                // SH-1
    t.db.prepare(`UPDATE entries SET created_at = '2026-01-02 03:04:05' WHERE series = 'E' AND id = 1`).run();

    const plan = planCopy(t.db, { from: 'm', to: 'NV' });
    assert.equal(plan.source.kind, 'module');
    assert.deepEqual(plan.items.map((i) => i.ref), ['E-00001', 'E-00002']);
    assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM entries WHERE series = 'NV'`).get().n, 0, 'planning writes nothing');

    const r = await applyCopy(t.db, plan);
    assert.deepEqual(r.copied.map((c) => [c.from, c.to]), [['E-00001', 'NV-1'], ['E-00002', 'NV-2']]);
    const e1 = row(t.db, 'E', 1), nv1 = row(t.db, 'NV', 1), e2 = row(t.db, 'E', 2), nv2 = row(t.db, 'NV', 2);
    assert.notEqual(nv1.ulid, e1.ulid);
    for (const c of ['type', 'kind', 'title', 'summary', 'description', 'status', 'agent', 'module', 'category', 'author', 'created_at', 'deprecated']) {
      assert.deepEqual(nv1[c], e1[c], `NV-1.${c}`);
      assert.deepEqual(nv2[c], e2[c], `NV-2.${c}`);
    }
    assert.equal(nv1.description, 'body one, see E-2', 'body mentions are not rewritten');
    assert.equal(nv1.project_ulid, plan.target.ulid);
    assert.deepEqual(modulesOf(t.db, nv2.ulid), modulesOf(t.db, e2.ulid));
  } finally { t.cleanup(); }
});

test('links inside the set point at the copies; links outside stay; originals change only by copied_to', async () => {
  const t = world();
  try {
    const e1 = addEntry(t.db, note('one', { module: 'm' }));                          // E-1
    const e2 = addEntry(t.db, note('two', { module: 'm' }));                          // E-2
    for (let i = 3; i <= 9; i++) addEntry(t.db, note(`n${i}`, { module: 'x' }));      // E-3..E-9
    t.db.prepare(`INSERT INTO refs (entry_ulid, entry_id, ref_type, ref_value) VALUES (?, 1, 'entry', 'E-2'), (?, 1, 'entry', 'E-9'), (?, 1, 'file', 'a.ts')`)
      .run(e1.ulid, e1.ulid, e1.ulid);
    t.db.prepare(`UPDATE entries SET superseded_by = 1, superseded_by_ulid = ? WHERE ulid = ?`).run(e1.ulid, e2.ulid);
    const snap = (u: string) => ({ row: t.db.prepare(`SELECT * FROM entries WHERE ulid = ?`).get(u), refs: refsOf(t.db, u), mods: modulesOf(t.db, u) });
    const before1 = snap(e1.ulid), before2 = snap(e2.ulid);

    const r = await applyCopy(t.db, planCopy(t.db, { from: 'm', to: 'NV' }));
    const nv1 = row(t.db, 'NV', 1), nv2 = row(t.db, 'NV', 2);
    assert.deepEqual(refsOf(t.db, nv1.ulid), [
      { ref_type: 'entry', ref_value: 'E-9', target_ulid: row(t.db, 'E', 9).ulid },
      { ref_type: 'entry', ref_value: 'NV-2', target_ulid: nv2.ulid },
      { ref_type: 'file', ref_value: 'a.ts', target_ulid: null },
    ]);
    assert.equal(nv2.superseded_by_ulid, nv1.ulid);
    assert.equal(nv2.superseded_by, null, 'a bare number means E: never on a copy');
    assert.equal(r.links_repointed, 2);
    assert.equal(r.copied_to_added, 2);

    for (const [u, before, copy] of [[e1.ulid, before1, nv1], [e2.ulid, before2, nv2]] as const) {
      const after = snap(u);
      assert.deepEqual(after.row, before.row, 'the original row is untouched');
      assert.deepEqual(after.mods, before.mods);
      const added = after.refs.filter((x: any) => !before.refs.some((b: any) => b.ref_value === x.ref_value));
      assert.deepEqual(added, [{ ref_type: 'entry', ref_value: `${COPIED_TO_PREFIX}${copy.ulid}`, target_ulid: copy.ulid }]);
      assert.equal(after.refs.length, before.refs.length + 1);
    }
    assert.ok(!refsOf(t.db, nv1.ulid).some((x: any) => x.ref_value.startsWith(COPIED_TO_PREFIX)), "the original's copied_to links are not copied");
  } finally { t.cleanup(); }
});

test('team -> solo with --author me on a shared notebook: no allocator call, numbered locally', async () => {
  const t = world(true);
  let calls = 0;
  setAllocator({ allocate: async () => { calls++; throw new Error('office down'); } });
  try {
    setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
    teamRow(t.db, 'SH');
    asAuthor('naveen', () => addEntry(t.db, note('mine 1', { project: 'SH', assigned: assigned(1) })));
    asAuthor('rinku', () => addEntry(t.db, note('hers', { project: 'SH', assigned: assigned(2) })));
    asAuthor('naveen', () => addEntry(t.db, note('mine pending', { project: 'SH' })));
    createProject(t.db, { name: 'mine', code: 'P1' });
    const plan = asAuthor('naveen', () => planCopy(t.db, { from: 'SH', to: 'P1', author: 'me' }));
    assert.equal(plan.filters.author, 'naveen');
    assert.deepEqual(plan.items.map((i) => i.title), ['mine 1', 'mine pending'], 'numbered first, pending last');
    const r = await asAuthor('naveen', () => applyCopy(t.db, plan));
    assert.deepEqual(r.copied.map((c) => c.to), ['P1-1', 'P1-2']);
    assert.equal(calls, 0, 'a solo save never asks the office');
    assert.equal(r.copied.every((c) => !c.pending), true);
  } finally { setAllocator(null); t.cleanup(); }
});

test('--since filters by created_at; a bad date names the accepted form', () => {
  const t = world();
  try {
    addEntry(t.db, note('old', { module: 'm' }));
    addEntry(t.db, note('new', { module: 'm' }));
    t.db.prepare(`UPDATE entries SET created_at = '2025-12-31 23:59:59' WHERE title = 'old'`).run();
    assert.deepEqual(planCopy(t.db, { from: 'm', to: 'NV', since: '2026-01-01' }).items.map((i) => i.title), ['new']);
    assert.throws(() => planCopy(t.db, { from: 'm', to: 'NV', since: 'last week' }), /YYYY-MM-DD/);
  } finally { t.cleanup(); }
});

test('running the same copy twice skips what is already copied; a deleted copy is listed again', async () => {
  const t = world();
  try {
    addEntry(t.db, note('one', { module: 'm' }));
    await applyCopy(t.db, planCopy(t.db, { from: 'm', to: 'NV' }));
    const again = planCopy(t.db, { from: 'm', to: 'NV' });
    assert.equal(again.items.length, 0);
    assert.deepEqual(again.skipped.map((s) => s.reason), ['already copied to NV-1']);
    await assert.rejects(applyCopy(t.db, again), /nothing to copy/);
    t.db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE series = 'NV'`).run();
    assert.equal(planCopy(t.db, { from: 'm', to: 'NV' }).items.length, 1);
  } finally { t.cleanup(); }
});

test('refusals: same project, left target, unknown target, no project, ambiguous source, unknown source', () => {
  const t = world();
  try {
    teamRow(t.db, 'SH');
    initModule(t.db, { slug: 'nv' });
    assert.throws(() => planCopy(t.db, { from: 'project:NV', to: 'NV' }), /same project/);
    markProjectLeft(t.db, 'SH');
    assert.throws(() => planCopy(t.db, { from: 'm', to: 'SH' }), /left/);
    assert.throws(() => planCopy(t.db, { from: 'm', to: 'ZZ' }), /no project "ZZ".*Known: NV, SH/);
    assert.throws(() => planCopy(t.db, { from: 'm', to: 'none' }), /into a project/);
    assert.throws(() => planCopy(t.db, { from: 'nv', to: 'SH' }), /project:NV.*module:nv/);
    assert.throws(() => planCopy(t.db, { from: 'nothing-here', to: 'NV' }), /no project or module "nothing-here"/);
    assert.equal(planCopy(t.db, { from: 'module:nv', to: 'NV' }).source.kind, 'module');
  } finally { t.cleanup(); }
});

test('the notes changed since the list was shown: nothing is copied', async () => {
  const t = world();
  try {
    addEntry(t.db, note('one', { module: 'm' }));
    const plan = planCopy(t.db, { from: 'm', to: 'NV' });
    addEntry(t.db, note('two', { module: 'm' }));
    await assert.rejects(applyCopy(t.db, plan), /changed since the list was shown/);
    assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM entries WHERE series = 'NV'`).get().n, 0);
  } finally { t.cleanup(); }
});

test('team target: numbered by the office; office down -> pending, asked once', async () => {
  const t = world(true);
  try {
    setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
    teamRow(t.db, 'SH');
    addEntry(t.db, note('one', { module: 'm', assigned: assigned(1) }));
    addEntry(t.db, note('two', { module: 'm', assigned: assigned(2) }));
    let next = 4;
    const seen: string[] = [];
    setAllocator({ allocate: async (_u: string, series: string) => { seen.push(series); return ++next; } });
    const r = await applyCopy(t.db, planCopy(t.db, { from: 'm', to: 'SH' }));
    assert.deepEqual(r.copied.map((c) => c.to), ['SH-5', 'SH-6']);
    assert.deepEqual(seen, ['SH', 'SH']);

    createProject(t.db, { name: 'other', code: 'OT' });
    addEntry(t.db, note('three', { project: 'OT' }));
    addEntry(t.db, note('four', { project: 'OT' }));
    let calls = 0;
    setAllocator({ allocate: async () => { calls++; throw new Error('office down'); } });
    const p = await applyCopy(t.db, planCopy(t.db, { from: 'OT', to: 'SH' }));
    assert.deepEqual(p.copied.map((c) => c.pending), [true, true]);
    assert.equal(calls, 1, 'after the first failure the rest go pending without asking');
    assert.match(p.pending_reason ?? '', /office down/);
  } finally { setAllocator(null); t.cleanup(); }
});

test('send rule 0b: a copied_to link of a team note is never sent; its other refs are', async () => {
  const t = world(true);
  try {
    setSyncValue(t.db, SYNC_KEYS.fingerprint, 'fp');
    setSyncValue(t.db, SHARED_KEY, JSON.stringify([]));
    teamRow(t.db, 'SH');
    const sh = addEntry(t.db, note('team', { project: 'SH', assigned: assigned(1), refs: [{ ref_type: 'file', ref_value: 'a.ts' }] }));
    createProject(t.db, { name: 'mine', code: 'P1' });
    await applyCopy(t.db, planCopy(t.db, { from: 'SH', to: 'P1' }));
    const ctx = sendContext(t.db);
    const memo = new Map<string, NotePlace>();
    const seen: Record<string, string> = {};
    for (const w of readOwnChanges(t.db, 0)) {
      if (w.table !== 'refs') continue;
      const cells = (t.db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).all(Buffer.from(w.pk, 'base64')) as any[]).map((c) => String(c.cell));
      if (cells[0] !== sh.ulid) continue;
      seen[cells[2]] = sendVerdictOf(t.db, w, ctx, memo).verdict;
    }
    const copiedTo = Object.keys(seen).find((k) => k.startsWith(COPIED_TO_PREFIX))!;
    assert.ok(copiedTo, 'the copied_to change exists');
    assert.equal(seen[copiedTo], 'skip');
    assert.equal(seen['a.ts'], 'send');
  } finally { t.cleanup(); }
});

test('the list and the result read the same whatever prints them', async () => {
  const t = world();
  try {
    asAuthor('naveen', () => addEntry(t.db, note('one', { module: 'm' })));
    t.db.prepare(`UPDATE entries SET created_at = '2026-03-04 05:06:07'`).run();
    const plan = planCopy(t.db, { from: 'm', to: 'NV' });
    assert.deepEqual(copyPlanLines(plan), [
      'Copy 1 note from module m (E notes) into NV (Navi, solo):',
      '  E-00001    decision      one  (naveen, 2026-03-04)',
      'Each copy is a new note numbered by NV; the original is not changed, apart from a copied_to link to its copy. Mentions like E-729 inside the text are not rewritten.',
    ]);
    const r = await applyCopy(t.db, plan);
    assert.deepEqual(copyResultLines(r), [
      'Copied 1 note from module m (E notes) into NV (Navi, solo):',
      '  E-00001 -> NV-1',
      '0 links inside the copied notes now point at the copies; each original got a copied_to link to its copy.',
    ]);
    const again = planCopy(t.db, { from: 'm', to: 'NV' });
    assert.deepEqual(copyPlanLines(again), [
      'Copy 0 notes from module m (E notes) into NV (Navi, solo):',
      '  (nothing to copy)',
      'Skipped 1:',
      '  E-00001    one: already copied to NV-1',
    ]);
  } finally { t.cleanup(); }
});

test('editing an original (refs written back without targets) keeps its copied_to link and the skip', async () => {
  const t = world();
  try {
    addEntry(t.db, note('one', { module: 'm', refs: [{ ref_type: 'file', ref_value: 'a.ts' }] }));
    await applyCopy(t.db, planCopy(t.db, { from: 'm', to: 'NV' }));
    const e1 = getEntryByRef(t.db, { series: 'E', id: 1 })!;
    editEntry(t.db, { id: 1, type: 'decision', title: 'one, edited', summary: 's', module: 'm',
      refs: e1.refs.map((r) => ({ ref_type: r.ref_type, ref_value: r.ref_value })) });
    const after = getEntryByRef(t.db, { series: 'E', id: 1 })!;
    const link = after.refs.find((r) => r.copied_to)!;
    assert.equal(link.target?.series, 'NV');
    assert.equal(link.target?.id, 1);
    assert.deepEqual(planCopy(t.db, { from: 'm', to: 'NV' }).skipped.map((s) => s.reason), ['already copied to NV-1']);
  } finally { t.cleanup(); }
});

// UI parity Task 10: "copy this note to another project" is collab copy with one note as the source.
test('note:<ref> copies exactly that note, by number or ULID; an unknown note is named; same project refused', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    createProject(t.db, { name: 'Alpha', code: 'AL' });
    createProject(t.db, { name: 'Beta', code: 'BE' });
    const a1 = addEntry(t.db, note('a1', { project: 'AL' }));
    addEntry(t.db, note('a2', { project: 'AL' }));
    const e = addEntry(t.db, note('loose'));
    const byRef = planCopy(t.db, { from: 'note:AL-1', to: 'BE' });
    assert.deepEqual([byRef.source.kind, byRef.source.label, byRef.items.map((i) => i.title)], ['note', 'note AL-1', ['a1']]);
    assert.equal(byRef.source.project_ulid, byRef.items.length ? (t.db.prepare(`SELECT project_ulid p FROM entries WHERE ulid = ?`).get(a1.ulid) as any).p : null);
    const loose = planCopy(t.db, { from: `note:${e.ulid}`, to: 'BE' });
    assert.deepEqual([loose.items.map((i) => i.title), loose.source.project_ulid], [['loose'], undefined], 'an E note with no module');
    const r = await applyCopy(t.db, byRef);
    assert.deepEqual(r.copied.map((c) => [c.from, c.to]), [['AL-1', 'BE-1']]);
    assert.equal(copyResultLines(r)[0], 'Copied 1 note from note AL-1 into BE (Beta, solo):');
    assert.equal(planCopy(t.db, { from: 'note:AL-1', to: 'BE' }).skipped[0].reason, 'already copied to BE-1');
    assert.throws(() => planCopy(t.db, { from: 'note:AL-9', to: 'BE' }), /no note "AL-9" in this notebook/);
    assert.throws(() => planCopy(t.db, { from: 'note:AL-1', to: 'AL' }), /same project \(AL\)/);
  } finally { t.cleanup(); }
});
