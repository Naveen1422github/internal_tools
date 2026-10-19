// file: core/test/can.test.ts
// RnR S2 Task 7 (R8, role layer): the laptop refuses what the person's role in a
// team project doesn't allow, before any write or network call. The office stays
// the real enforcer; this is UX and guards the AI.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb, ship, dbVersion } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { updateEntry, updateEntryRefs, resolveNeedsMerge } from '../src/ops/update.js';
import { editEntry, reassignModule } from '../src/ops/edit.js';
import { supersede } from '../src/ops/supersede.js';
import { archive } from '../src/ops/rollup.js';
import { deleteEntry } from '../src/ops/delete.js';
import { resolveWithText, currentHeads } from '../src/ops/merge.js';
import { planCopy, applyCopy } from '../src/ops/copy.js';
import { initModule } from '../src/ops/module.js';
import { createProject, renameProject, findProject } from '../src/projects.js';
import { writeAccessCache } from '../src/access/cache.js';
import { STARTER_PROJECT_ROLES } from '../src/access/catalog.js';
import { setAllocator } from '../src/sync/allocator.js';
import {
  can, assertCan, isOwnNote, setDefaultActor, getDefaultActor, AccessDeniedError,
} from '../src/access/can.js';

const TM = '01JPR0JECTTM00000000000000';
// Strict timing: COLLAB_PERF=1 npx tsx --test --test-concurrency=1 test/can.test.ts (R-21)
const STRICT = process.env.COLLAB_PERF === '1';
const teamRow = (db: any, code = 'TM', ulid = TM) =>
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', 'fp')`).run(ulid, `team ${code}`, code);
const roleKeys = (name: string) => STARTER_PROJECT_ROLES.find((r) => r.name === name)!.keys;
const setRole = (db: any, role: string, keys = roleKeys(role)) =>
  writeAccessCache(db, { office: null, projects: [{ ulid: TM, code: 'TM', role, keys, ai: {} }], replays: [] });
const note = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'decision' as const, title, summary: 's', ...extra });
let n = 0;
const assigned = (id: number) => ({ ulid: `01K${String(++n).padStart(23, '0')}`, id });

/** A refusal naming `key` in TM, with the office's wording. */
const denied = (key: string) => (e: unknown) =>
  e instanceof AccessDeniedError && e.name === 'AccessDeniedError' && e.key === key
  && e.message.includes(`(${key}) in TM to do this`) && /^You need "[^"]+" /.test(e.message);

/** Count reads of access_cache: wraps prepare so every statement on it is counted when run. */
function spyAccessReads(db: any): { reads: () => number } {
  let reads = 0;
  const orig = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = orig(sql);
    if (!/access_cache/.test(sql)) return st;
    for (const m of ['get', 'all', 'iterate', 'run'] as const) {
      const f = st[m].bind(st);
      st[m] = (...a: unknown[]) => { reads++; return f(...a); };
    }
    return st;
  };
  return { reads: () => reads };
}

test('solo and E: allowed with zero access_cache reads', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    const so = createProject(t.db, { name: 'mine', code: 'SO' });
    teamRow(t.db);
    setRole(t.db, 'Reader'); // a Reader row exists, but it only applies to TM
    const spy = spyAccessReads(t.db);
    for (const k of ['note.create', 'note.edit.any', 'note.archive', 'project.edit', 'project.delete']) {
      assert.deepEqual(can(t.db, null, k), { ok: true });
      assert.deepEqual(can(t.db, so.ulid, k), { ok: true });
    }
    const e = addEntry(t.db, note('e note'));
    const s = addEntry(t.db, note('solo note', { project: 'SO' }));
    updateEntry(t.db, { ulid: e.ulid, title: 'e2' });
    updateEntry(t.db, { ulid: s.ulid, title: 's2' });
    deleteEntry(t.db, s.id!, 'SO');
    await renameProject(t.db, 'SO', 'mine renamed');
    assert.equal(spy.reads(), 0, 'no access_cache read for a solo project or an E note');
    // The same spy does see a team check (the spy works).
    assert.equal(can(t.db, TM, 'note.create').ok, false);
    assert.ok(spy.reads() > 0);
  } finally { t.cleanup(); }
});

test('Reader: create/edit/supersede/archive/delete/resolve/copy-out/rename each throw naming the key, nothing written', async () => {
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    teamRow(t.db);
    createProject(t.db, { name: 'mine', code: 'SO' });
    initModule(t.db, { slug: 'mod' });
    initModule(t.db, { slug: 'other' });
    // Notes made while there is no cache row (S2-4: allowed).
    const a = addEntry(t.db, note('a', { project: 'TM', module: 'mod', assigned: assigned(1) }));
    const b = addEntry(t.db, note('b', { project: 'TM', module: 'mod', assigned: assigned(2) }));
    const h = addEntry(t.db, { type: 'handoff', title: 'old work', summary: 's', module: 'mod', project: 'TM', assigned: assigned(3) });
    t.db.prepare(`UPDATE entries SET needs_merge = 1 WHERE ulid = ?`).run(b.ulid);
    const solo = addEntry(t.db, note('solo', { project: 'SO', module: 'mod' }));
    const copyOut = planCopy(t.db, { from: 'project:TM', to: 'SO' });
    const copyIn = planCopy(t.db, { from: 'project:SO', to: 'TM' });
    assert.equal(solo.series, 'SO');

    setRole(t.db, 'Reader');
    const v0 = dbVersion(t.db);
    const count0 = (t.db.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c;

    assert.throws(() => addEntry(t.db, note('new', { project: 'TM' })), denied('note.create'));
    await assert.rejects(addEntryAsync(t.db, note('new', { project: 'TM' })), denied('note.create'));
    assert.throws(() => updateEntry(t.db, { ulid: a.ulid, title: 'x' }), denied('note.edit.own'));
    assert.throws(() => updateEntryRefs(t.db, { series: 'TM', id: 1, add: [{ ref_type: 'url', ref_value: 'http://x' }] }), denied('note.edit.own'));
    assert.throws(() => editEntry(t.db, { series: 'TM', id: 1, type: 'decision', title: 'x', summary: 's' }), denied('note.edit.own'));
    assert.throws(() => reassignModule(t.db, [{ series: 'TM', id: 1 }], 'other'), denied('note.edit.own'));
    assert.throws(() => supersede(t.db, { ids: [{ series: 'TM', id: 1 }], by: { series: 'TM', id: 3 } }), denied('note.supersede'));
    assert.throws(() => archive(t.db, { older_than: '2999-01-01', dry_run: false }), denied('note.archive'));
    assert.deepEqual(archive(t.db, { older_than: '2999-01-01' }).dry_run, true, 'a dry run writes nothing: not gated');
    assert.throws(() => deleteEntry(t.db, 1, 'TM'), denied('note.archive'));
    const heads = currentHeads(t.db, b.ulid);
    assert.throws(() => resolveNeedsMerge(t.db, 2, heads, 'TM'), denied('merge.resolve'));
    assert.throws(() => resolveWithText(t.db, { id: 2, series: 'TM', expectedHeads: heads, title: 't', summary: 's', description: null }), denied('merge.resolve'));
    await assert.rejects(applyCopy(t.db, copyOut), denied('note.copy.out'));
    await assert.rejects(applyCopy(t.db, copyIn), denied('note.create'));
    await assert.rejects(renameProject(t.db, 'TM', 'renamed'), denied('project.edit'));

    assert.equal(dbVersion(t.db), v0, 'no synced cell was written');
    assert.equal((t.db.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c, count0);
    assert.equal(findProject(t.db, 'TM')!.name, 'team TM');
    void h;

    // An Editor may do all of these (the same calls go through).
    setRole(t.db, 'Editor');
    updateEntry(t.db, { ulid: a.ulid, title: 'edited' });
    supersede(t.db, { ids: [{ series: 'TM', id: 1 }], by: { series: 'TM', id: 3 } });
    resolveNeedsMerge(t.db, 2, heads, 'TM');
    assert.ok(dbVersion(t.db) > v0);
    // project.edit is Owner-only.
    await assert.rejects(renameProject(t.db, 'TM', 'renamed'), denied('project.edit'));
    setRole(t.db, 'Owner');
    // Past the laptop check, a team rename goes to the office (UI parity D1): none is set up here.
    await assert.rejects(renameProject(t.db, 'TM', 'renamed'), /share this notebook first/);
  } finally { t.cleanup(); }
});

test('Contributor edits own note -> ok; another device\'s note -> note.edit.any refusal', () => {
  const me = freshDb({ shared: true });
  const other = freshDb({ shared: true });
  try {
    migrate(me.db); migrate(other.db);
    teamRow(me.db); teamRow(other.db);
    const theirs = addEntry(other.db, note('theirs', { project: 'TM', assigned: assigned(1) }));
    ship(other.db, me.db);
    const mine = addEntry(me.db, note('mine', { project: 'TM', assigned: assigned(2) }));
    assert.equal(isOwnNote(me.db, mine.ulid), true);
    assert.equal(isOwnNote(me.db, theirs.ulid), false, 'its created_at cell came from another site (S2-6)');
    assert.equal(isOwnNote(other.db, theirs.ulid), true);

    setRole(me.db, 'Contributor');
    updateEntry(me.db, { ulid: mine.ulid, title: 'mine edited' });
    assert.throws(() => updateEntry(me.db, { ulid: theirs.ulid, title: 'nope' }), denied('note.edit.any'));
    assert.throws(() => deleteEntry(me.db, 1, 'TM'), denied('note.archive'));
    // A note-less DB without sync: everything is own.
    const plain = freshDb();
    try {
      migrate(plain.db);
      const p = addEntry(plain.db, note('p'));
      assert.equal(isOwnNote(plain.db, p.ulid), true);
    } finally { plain.cleanup(); }
  } finally { me.cleanup(); other.cleanup(); }
});

test('no cache row for a team project -> allowed; an inactive key -> refused', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    teamRow(t.db);
    assert.deepEqual(can(t.db, TM, 'note.create'), { ok: true }, 'S2-4: not cached yet');
    assert.doesNotThrow(() => assertCan(t.db, TM, 'note.edit.any'));
    addEntry(t.db, note('x', { project: 'TM' }));
    setRole(t.db, 'Owner');
    assert.deepEqual(can(t.db, TM, 'note.create'), { ok: true });
    for (const k of ['project.make_solo', 'project.delete', 'task.create']) {
      const r = can(t.db, TM, k);
      assert.equal(r.ok, false, `${k} is inactive (S2-2): it guards nothing yet`);
      assert.match((r as { reason: string }).reason, new RegExp(`\\(${k.replace('.', '\\.')}\\) in TM to do this`));
    }
  } finally { t.cleanup(); }
});

test('addEntryAsync: allocate 403 -> AccessDeniedError, nothing saved; other failures still save pending', async () => {
  const t = freshDb();
  try {
    migrate(t.db);
    teamRow(t.db); // no cache row: the laptop lets it through, the office refuses
    const count = () => (t.db.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c;
    setAllocator({
      allocate: async () => {
        throw Object.assign(new Error('the post office answered 403: You need "Create notes" (note.create) in TM to do this'),
          { retriable: false, refused: true, key: 'note.create', reason: 'You need "Create notes" (note.create) in TM to do this' });
      },
    });
    await assert.rejects(addEntryAsync(t.db, note('refused', { project: 'TM' })), denied('note.create'));
    assert.equal(count(), 0, 'S2-5: nothing saved');
    setAllocator({ allocate: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await addEntryAsync(t.db, note('down', { project: 'TM' }));
    assert.equal(r.pending, true);
    assert.equal(count(), 1);
  } finally { setAllocator(null); t.cleanup(); }
});

test('MCP actor is "ai" and still gets the role check', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    teamRow(t.db);
    setRole(t.db, 'Reader');
    setDefaultActor('ai');
    assert.equal(getDefaultActor(), 'ai');
    assert.equal(can(t.db, TM, 'note.create').ok, false);
    assert.equal(can(t.db, TM, 'note.create', 'human').ok, false);
    assert.equal(can(t.db, TM, 'note.view', 'ai').ok, true);
    assert.throws(() => assertCan(t.db, TM, 'note.create'), denied('note.create'));
    assert.throws(() => addEntry(t.db, note('ai note', { project: 'TM' })), denied('note.create'));
  } finally { setDefaultActor('human'); t.cleanup(); }
});

test('can() p99 < 1 ms over 10k calls', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    teamRow(t.db);
    setRole(t.db, 'Contributor');
    for (let i = 0; i < 500; i++) can(t.db, TM, 'note.edit.any'); // warm-up
    const ms: number[] = [];
    const keys = ['note.create', 'note.edit.any', 'merge.resolve', 'project.make_solo'];
    for (let i = 0; i < 10_000; i++) {
      const t0 = process.hrtime.bigint();
      can(t.db, TM, keys[i % keys.length]);
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ms.sort((x, y) => x - y);
    const p99 = ms[Math.floor(ms.length * 0.99)];
    const p50 = ms[5000];
    console.log(`can() p99 = ${p99.toFixed(4)} ms, p50 = ${p50.toFixed(4)} ms`);
    // R-21: the exact gate only in strict mode. In the parallel suite every
    // autocommit read's file lock slows ~8x under CPU contention (p99 5-6 ms
    // seen), so the smoke there is p50 < 3 ms (3x), a gross-regression check.
    if (STRICT) assert.ok(p99 < 1, `p99 ${p99} ms`);
    else assert.ok(p50 < 3, `p50 ${p50} ms (p99 ${p99} ms; strict: COLLAB_PERF=1)`);
  } finally { t.cleanup(); }
});

// R-31: module writes are office keys, judged on the laptop from the office row of
// access_cache, and only for a shared module (an unshared module row is never sent).
test('module writes: an Office member is refused module.edit / module.create on a shared module; unshared or admin passes', async () => {
  const { STARTER_OFFICE_ROLES } = await import('../src/access/catalog.js');
  const { upsertModule } = await import('../src/ops/module.js');
  const { setModuleHub } = await import('../src/ops/hub.js');
  const { setSyncValue } = await import('../src/sync/state.js');
  const officeRole = (db: any, name: 'Office admin' | 'Office member') =>
    writeAccessCache(db, { office: { role: name, keys: STARTER_OFFICE_ROLES.find((r) => r.name === name)!.keys }, projects: [], replays: [] });
  const officeDenied = (key: string) => (e: unknown) =>
    e instanceof AccessDeniedError && e.key === key && e.projectUlid === null && e.message === `You need "${key === 'module.edit' ? 'Edit modules' : 'Create modules'}" (${key}) in this office to do this`;
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    initModule(t.db, { slug: 'shared', name: 'Shared' });
    initModule(t.db, { slug: 'mine', name: 'Mine' });
    const e = addEntry(t.db, note('hub', { module: 'shared', assigned: assigned(900) }));
    // No cache row yet (S2-4): allowed.
    setSyncValue(t.db, 'shared_modules', JSON.stringify(['shared', 'shared-new']));
    upsertModule(t.db, { slug: 'shared', name: 'Shared 1' });
    assert.ok(can(t.db, null, 'module.edit').ok, 'no office row: the office decides');

    officeRole(t.db, 'Office member');
    assert.deepEqual(can(t.db, null, 'module.edit'), { ok: false, reason: 'You need "Edit modules" (module.edit) in this office to do this' });
    assert.throws(() => upsertModule(t.db, { slug: 'shared', name: 'Shared 2' }), officeDenied('module.edit'));
    assert.throws(() => upsertModule(t.db, { slug: 'shared-new', name: 'New' }), officeDenied('module.create'));
    assert.throws(() => initModule(t.db, { slug: 'shared-new' }), officeDenied('module.create'));
    assert.throws(() => setModuleHub(t.db, { slug: 'shared', id: e.id as number }), officeDenied('module.edit'));
    assert.throws(() => setModuleHub(t.db, { slug: 'shared', id: null }), officeDenied('module.edit'));
    const row = (slug: string) => t.db.prepare(`SELECT name, hub FROM modules WHERE slug = ?`).get(slug) as { name: string; hub: string | null } | undefined;
    assert.deepEqual(row('shared'), { name: 'Shared 1', hub: null }, 'nothing written');
    assert.equal(row('shared-new'), undefined);
    // initModule of a slug that exists is a no-op: nothing to judge.
    assert.deepEqual(initModule(t.db, { slug: 'shared' }), { slug: 'shared' });
    // An unshared module is never sent: no check.
    upsertModule(t.db, { slug: 'mine', name: 'Mine 2' });
    upsertModule(t.db, { slug: 'brand-new', name: 'Local only' });
    assert.equal(row('mine')!.name, 'Mine 2');

    officeRole(t.db, 'Office admin');
    upsertModule(t.db, { slug: 'shared', name: 'Shared 3' });
    upsertModule(t.db, { slug: 'shared-new', name: 'New' });
    setModuleHub(t.db, { slug: 'shared', id: e.id as number });
    assert.equal(row('shared')!.name, 'Shared 3');
    assert.equal(row('shared')!.hub, e.ulid);
  } finally { t.cleanup(); }
});

test("R-32: closing a task resolves only the handoffs the person may edit; another member's stays active, nothing refused", async () => {
  const { createTask, transitionTask } = await import('../src/ops/task.js');
  const me = freshDb({ shared: true }), other = freshDb({ shared: true });
  try {
    migrate(me.db); migrate(other.db);
    teamRow(me.db); teamRow(other.db);
    const { id: task } = createTask(me.db, { title: 'the task' });
    const theirs = addEntry(other.db, { type: 'handoff', title: 'their handoff', summary: 's', project: 'TM', task_id: task, assigned: assigned(1) });
    ship(other.db, me.db);
    const mine = addEntry(me.db, { type: 'handoff', title: 'my handoff', summary: 's', project: 'TM', task_id: task, assigned: assigned(2) });
    const e = addEntry(me.db, { type: 'review', title: 'an E review', summary: 's', task_id: task, assigned: assigned(3) });
    setRole(me.db, 'Contributor');
    for (const to of ['in-progress', 'review'] as const) transitionTask(me.db, task, to);
    const v = dbVersion(me.db);
    assert.deepEqual(transitionTask(me.db, task, 'done'), { id: task, status: 'done' }, 'the transition never fails');
    const status = (u: string) => (me.db.prepare(`SELECT status FROM entries WHERE ulid = ?`).get(u) as { status: string }).status;
    assert.equal(status(mine.ulid), 'resolved');
    assert.equal(status(e.ulid), 'resolved', 'not in a team project: no check');
    assert.equal(status(theirs.ulid), 'active', 'note.edit.any is not a Contributor key: left alone');
    const touched = me.db.prepare(`SELECT COUNT(*) n FROM crsql_changes WHERE "table" = 'entries' AND pk = crsql_pack_columns(?) AND db_version > ?`).get(theirs.ulid, v) as { n: number };
    assert.equal(touched.n, 0, 'no change to send, so nothing for the office to refuse');
    // An Owner closing it resolves both.
    transitionTask(me.db, task, 'pending');
    setRole(me.db, 'Owner');
    for (const to of ['in-progress', 'review', 'done'] as const) transitionTask(me.db, task, to);
    assert.equal(status(theirs.ulid), 'resolved');
  } finally { me.cleanup(); other.cleanup(); }
});

// R-35: deleting a module is a modules delete cell the office judges as module.edit
// (shared slug): the laptop refuses it up front instead of a silent revert.
test('deleteModule: an Office member is refused module.edit on a shared module; unshared or admin passes', async () => {
  const { STARTER_OFFICE_ROLES } = await import('../src/access/catalog.js');
  const { deleteModule } = await import('../src/ops/module.js');
  const { setSyncValue } = await import('../src/sync/state.js');
  const officeRole = (db: any, name: 'Office admin' | 'Office member') =>
    writeAccessCache(db, { office: { role: name, keys: STARTER_OFFICE_ROLES.find((r) => r.name === name)!.keys }, projects: [], replays: [] });
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    for (const slug of ['shared', 'mine', 'busy']) initModule(t.db, { slug, name: slug });
    addEntry(t.db, note('busy note', { module: 'busy', assigned: assigned(901) }));
    setSyncValue(t.db, 'shared_modules', JSON.stringify(['shared', 'busy', 'gone']));
    const exists = (slug: string) => !!t.db.prepare(`SELECT 1 FROM modules WHERE slug = ?`).get(slug);
    officeRole(t.db, 'Office member');
    assert.throws(() => deleteModule(t.db, 'shared'), (e: unknown) =>
      e instanceof AccessDeniedError && e.key === 'module.edit' && e.projectUlid === null
      && e.message === 'You need "Edit modules" (module.edit) in this office to do this');
    assert.ok(exists('shared'), 'nothing deleted');
    // Nothing would be written: no refusal (still in use, or no such module).
    assert.deepEqual(deleteModule(t.db, 'busy'), { deleted: false, entry_count: 1, task_count: 0 });
    assert.deepEqual(deleteModule(t.db, 'gone'), { deleted: true });
    // An unshared module is never sent: no check.
    assert.deepEqual(deleteModule(t.db, 'mine'), { deleted: true });
    officeRole(t.db, 'Office admin');
    assert.deepEqual(deleteModule(t.db, 'shared'), { deleted: true });
    assert.ok(!exists('shared'));
  } finally { t.cleanup(); }
});
