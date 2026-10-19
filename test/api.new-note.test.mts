// UI parity Task 9: the New note form. The web names a project when it creates
// a note, and asks first where the note would land (addEntryAsync's own rule).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from './helpers/server.mjs';

let srv: any;
let core: any;
before(async () => {
  srv = await startTestServer();
  core = await import('@collab-mcp/core');
  core.createProject(srv.db, { name: 'Navi', code: 'NV' });
  core.initModule(srv.db, { slug: 'billing' });
  core.bindModule(srv.db, 'billing', 'NV');
});
after(() => srv.close());

const get = async (route: string) => { const r = await fetch(`${srv.baseUrl}${route}`); return { status: r.status, body: await r.json() }; };
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${srv.baseUrl}${route}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const note = { type: 'decision', title: 'Pick the queue', summary: 'We use SQS.', description: 'Because.' };

test('destination: bound module -> its project; named; none; unknown -> 404', async () => {
  const bound = await get('/api/collab/note-destination?module=billing');
  assert.deepEqual([bound.status, bound.body.why, bound.body.project.code], [200, 'bound', 'NV']);
  assert.equal(bound.body.line, 'It goes into NV (Navi) because module billing is bound to NV. It stays on this laptop.');
  assert.equal((await get('/api/collab/note-destination?project=none')).body.why, 'none');
  const nf = await get('/api/collab/note-destination?project=ZZ');
  assert.equal(nf.status, 404);
  assert.match(nf.body.error, /^no project "ZZ" in this notebook/);
});

test('create with a project: the note lands there and is numbered by it; "none" is an E note; bad input is a 400', async () => {
  const r = await post('/api/collab/entry/upsert', { ...note, project: 'NV' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.series, 'NV');
  const e = await post('/api/collab/entry/upsert', { ...note, module: 'billing', project: 'none' });
  assert.equal(e.body.series, 'E', 'an explicit "none" beats the binding');
  const auto = await post('/api/collab/entry/upsert', { ...note, module: 'billing' });
  assert.equal(auto.body.series, 'NV', 'no project named: the binding decides, as before');
  const unknown = await post('/api/collab/entry/upsert', { ...note, project: 'ZZ' });
  assert.equal(unknown.status, 404);
  const blank = await post('/api/collab/entry/upsert', { ...note, project: '' });
  assert.deepEqual([blank.status, blank.body], [400, { error: 'project must be a project code, or "none".' }]);
  const edit = await post('/api/collab/entry/upsert', { ...note, id: 'NV-1', project: 'none' });
  assert.equal(edit.status, 400);
});

// UI parity Task 10: notes show their project, and can be filtered by it.
test('search filters by project (a code, or none); the note read names its project', async () => {
  const nv = await post('/api/collab/entry/upsert', { ...note, title: 'only in NV', project: 'NV' });
  const e = await post('/api/collab/entry/upsert', { ...note, title: 'only in E', project: 'none' });
  const inNv = await get('/api/collab/search?project=NV');
  assert.ok(inNv.body.results.length > 0);
  assert.ok(inNv.body.results.every((r: any) => r.series === 'NV' && r.project_ulid));
  const inE = await get('/api/collab/search?project=none');
  assert.ok(inE.body.results.some((r: any) => r.title === 'only in E'));
  assert.ok(inE.body.results.every((r: any) => r.series === 'E' && r.project_ulid === null));
  assert.deepEqual((await get('/api/collab/search?project=ZZ')).body.results, []);
  const one = await get(`/api/collab/entry?id=NV-${nv.body.id}`);
  assert.deepEqual(one.body.project, { code: 'NV', name: 'Navi', mode: 'solo', left: false });
  assert.equal((await get(`/api/collab/entry?id=${e.body.id}`)).body.project, null);
  // Saving back what a read returned (the drawer's edit) still works: its project object is ignored.
  const back = await post('/api/collab/entry/upsert', { ...one.body, id: `NV-${nv.body.id}`, title: 'edited' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
});
