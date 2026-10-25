// file: core/test/e-project.test.ts
// E as a virtual project with a fixed ulid (never a row in `projects`).
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { initModule } from '../src/ops/module.js';
import { bindModule, boundProjectFor } from '../src/ops/bind.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { planCopy } from '../src/ops/copy.js';
import { setAllocator } from '../src/sync/allocator.js';
import { projectListRows } from '../src/ops/project.js';
import { findProject, listProjects, createProject, promoteProject, markProjectLeft, renameProject } from '../src/projects.js';
import { setSyncValue } from '../src/sync/state.js';
import { E_PROJECT_ULID, eProject, writeProjectUlid, neverSend, NEVER_SEND_KEY } from '../src/e-project.js';

function world() {
  const t = freshDb();
  migrate(t.db);
  initModule(t.db, { slug: 'infra' });
  return t;
}

test('e-project: found by code and by ulid', () => {
  const { db, cleanup } = world();
  assert.equal(findProject(db, 'E')?.code, 'E');
  assert.equal(findProject(db, 'e')?.code, 'E');
  assert.equal(findProject(db, E_PROJECT_ULID)?.code, 'E');
  cleanup();
});

test('e-project: solo until adopted, then team', () => {
  const { db, cleanup } = world();
  assert.equal(eProject(db).mode, 'solo');
  setSyncValue(db, 'e_project', '1');
  assert.equal(eProject(db).mode, 'team');
  cleanup();
});

test('e-project: listed once adopted, but never a row in projects', () => {
  const { db, cleanup } = world();
  setSyncValue(db, 'e_project', '1');
  assert.ok(listProjects(db).some((p) => p.code === 'E'));
  assert.equal((db.prepare(`SELECT count(*) AS n FROM projects WHERE code = 'E'`).get() as { n: number }).n, 0);
  cleanup();
});

test('e-project: a module binds to E and reads back as E', () => {
  const { db, cleanup } = world();
  const c = bindModule(db, 'infra', 'E');
  assert.equal(c.to, 'E');
  assert.equal(boundProjectFor(db, 'infra')?.code, 'E');
  assert.equal((db.prepare(`SELECT project_ulid FROM project_modules WHERE module = 'infra'`).get() as { project_ulid: string }).project_ulid, E_PROJECT_ULID);
  cleanup();
});

test('e-project: writeProjectUlid is null for E and null, the ulid otherwise', () => {
  const { db, cleanup } = world();
  assert.equal(writeProjectUlid(eProject(db)), null);
  assert.equal(writeProjectUlid(null), null);
  const p = createProject(db, { name: 'Side', code: 'SD' });
  assert.equal(writeProjectUlid(p), p.ulid);
  cleanup();
});

test('e-project: a note written into E is a normal E note', () => {
  const { db, cleanup } = world();
  bindModule(db, 'infra', 'E');
  const r = addEntry(db, { type: 'decision', title: 't', summary: 's', module: 'infra' });
  const row = db.prepare(`SELECT series, project_ulid, id FROM entries WHERE ulid = ?`).get(r.ulid) as { series: string; project_ulid: string | null; id: number };
  assert.equal(row.series, 'E');
  assert.equal(row.project_ulid, null);
  assert.equal(r.series, 'E');
  const r2 = addEntry(db, { type: 'decision', title: 't2', summary: 's', project: 'E' });
  assert.equal(r2.id, row.id + 1);
  cleanup();
});

test('e-project: neverSend reads the list and survives junk', () => {
  const { db, cleanup } = world();
  assert.equal(neverSend(db).size, 0);
  setSyncValue(db, NEVER_SEND_KEY, JSON.stringify(['a', 'b']));
  assert.deepEqual([...neverSend(db)], ['a', 'b']);
  setSyncValue(db, NEVER_SEND_KEY, 'not json');
  assert.equal(neverSend(db).size, 0);
  cleanup();
});

const rowOf = (db: any, ulid: string) => db.prepare(`SELECT series, id, project_ulid FROM entries WHERE ulid = ?`).get(ulid) as { series: string; id: number | null; project_ulid: string | null };

test('e-project: joined but unadopted, a note into E takes the office path like no project (never a local number)', async () => {
  const { db, cleanup } = world();
  try {
    setSyncValue(db, 'enabled', '1');
    bindModule(db, 'infra', 'E');
    const asked: string[] = [];
    setAllocator({ allocate: async (_u: string, series: string) => { asked.push(series); return 4100 + asked.length; } });
    const viaBound = await addEntryAsync(db, { type: 'decision', title: 'a', summary: 's', module: 'infra' });
    const viaName = await addEntryAsync(db, { type: 'decision', title: 'b', summary: 's', project: 'E' });
    assert.deepEqual(asked, ['E', 'E']);
    assert.equal(viaBound.id, 4101);
    assert.equal(viaName.id, 4102);
    assert.deepEqual(rowOf(db, viaName.ulid), { series: 'E', id: 4102, project_ulid: null });
    // office down: pending, not a local number
    setAllocator({ allocate: async () => { throw new Error('ECONNREFUSED'); } });
    const down = await addEntryAsync(db, { type: 'decision', title: 'c', summary: 's', project: 'E' });
    assert.equal(down.pending, true);
    assert.equal(rowOf(db, down.ulid).id, null);
  } finally { setAllocator(null); cleanup(); }
});

test('e-project: never-joined notebook still numbers E locally', async () => {
  const { db, cleanup } = world();
  const r = await addEntryAsync(db, { type: 'decision', title: 'a', summary: 's', project: 'E' });
  assert.equal(typeof r.id, 'number');
  assert.equal(rowOf(db, r.ulid).project_ulid, null);
  cleanup();
});

test('e-project: copy into E stays refused (no local E number can be made that way)', async () => {
  const { db, cleanup } = world();
  createProject(db, { name: 'Side', code: 'SD' });
  addEntry(db, { type: 'decision', title: 'x', summary: 's', project: 'SD' });
  setSyncValue(db, 'enabled', '1');
  assert.throws(() => planCopy(db, { from: 'SD', to: 'E' }), /E series is only for notes without a project/);
  assert.throws(() => planCopy(db, { from: 'SD', to: E_PROJECT_ULID }), /E series is only for notes without a project/);
  cleanup();
});

test('e-project: promote, leave and rename refuse E', async () => {
  const { db, cleanup } = world();
  await assert.rejects(promoteProject(db, 'E'), /E \(emp1st\) is the shared series/);
  assert.throws(() => markProjectLeft(db, 'E'), /E \(emp1st\) is the shared series/);
  await assert.rejects(renameProject(db, 'E', 'Other'), /E \(emp1st\) is the shared series/);
  setSyncValue(db, 'e_project', '1');
  await assert.rejects(renameProject(db, 'E', 'Other'), /E \(emp1st\) is the shared series/);
  cleanup();
});

test('e-project: listed only once adopted, as E / emp1st (never "solo"), with its pending notes', () => {
  const { db, cleanup } = world();
  assert.equal(listProjects(db).some((p) => p.code === 'E'), false);
  assert.equal(findProject(db, 'E')?.code, 'E');
  setSyncValue(db, 'e_project', '1');
  setSyncValue(db, 'enabled', '1');
  const e = listProjects(db).find((p) => p.code === 'E')!;
  assert.equal(e.name, 'emp1st');
  assert.notEqual(e.mode, 'solo');
  const r = addEntry(db, { type: 'decision', title: 'p', summary: 's', pendingUlid: '01HZZZZZZZZZZZZZZZZZZZZZZZ' });
  assert.equal(r.pending, true);
  assert.equal(projectListRows(db, null).find((x) => x.code === 'E')!.pending, 1);
  cleanup();
});
