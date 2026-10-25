// file: core/test/e-project.test.ts
// E as a virtual project with a fixed ulid (never a row in `projects`).
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { initModule } from '../src/ops/module.js';
import { bindModule, boundProjectFor } from '../src/ops/bind.js';
import { addEntry } from '../src/ops/add.js';
import { findProject, listProjects, createProject } from '../src/projects.js';
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

test('e-project: listed, but never a row in projects', () => {
  const { db, cleanup } = world();
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
