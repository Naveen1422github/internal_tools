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
