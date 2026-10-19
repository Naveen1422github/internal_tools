// RnR S3 (R6, S3-10, Review Focus 6): refused changes on the web. The routes call
// the same core functions as `collab refused list|copy|delete`, with core's words.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from './helpers/server.mjs';

let srv: any;
before(async () => {
  srv = await startTestServer();
  const { createProject } = await import('@collab-mcp/core');
  createProject(srv.db, { name: 'Solo Box', code: 'SO' });
  createProject(srv.db, { name: 'Team Box', code: 'TB' });
  srv.db.prepare(`UPDATE projects SET mode = 'team', team = 'fp' WHERE code = 'TB'`).run();
});
after(() => srv.close());

const NEVER = '01JZZZZZZZZZZZZZZZZZZZZZZZ'; // a well-formed id no row has

/** A note in SO and a refusal of it, attributed to the team project TB. */
async function seed(kind: 'new' | 'edit', title = 'Kept title') {
  const { addEntry, recordRefusal } = await import('@collab-mcp/core');
  const { id } = addEntry(srv.db, { type: 'decision', title, summary: 'kept summary', project: 'SO' });
  const note = srv.db.prepare(`SELECT ulid FROM entries WHERE series = 'SO' AND id = ?`).get(id).ulid as string;
  const tb = srv.db.prepare(`SELECT ulid FROM projects WHERE code = 'TB'`).get().ulid as string;
  const refusal = recordRefusal(srv.db, {
    noteUlid: note, projectUlid: tb, kind, key: 'note.edit', reason: 'You need "Edit notes" (note.edit) in TB to do this', cells: [],
  });
  return { refusal, note, ref: `SO-${id}` };
}
const post = (path: string, body: unknown) => fetch(`${srv.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body) });
const listIds = async () => ((await (await fetch(`${srv.baseUrl}/api/refused`)).json()) as any).results.map((r: any) => r.id);

test('GET /api/refused lists a refusal with its project code and note label, and only solo projects to copy into', async () => {
  const { refusal, ref } = await seed('edit');
  const res = await fetch(`${srv.baseUrl}/api/refused`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  const row = body.results.find((r: any) => r.id === refusal);
  assert.ok(row, JSON.stringify(body));
  assert.deepEqual(Object.keys(row).sort(), ['at', 'id', 'key', 'kind', 'note', 'project_code', 'reason']);
  assert.equal(row.project_code, 'TB');
  assert.equal(row.note, ref);
  assert.equal(row.kind, 'edit');
  assert.equal(row.key, 'note.edit');
  assert.equal(row.reason, 'You need "Edit notes" (note.edit) in TB to do this');
  assert.equal(typeof row.at, 'string');
  const codes = body.solo_projects.map((p: any) => p.code);
  assert.ok(codes.includes('SO'), JSON.stringify(body.solo_projects));
  assert.ok(!codes.includes('TB'), 'a team project is never a copy target');
  assert.deepEqual(body.solo_projects.find((p: any) => p.code === 'SO'), { code: 'SO', name: 'Solo Box' });
});

test('a refusal with no note and no project lists "-" for both, like the CLI', async () => {
  const { recordRefusal, discardRefused } = await import('@collab-mcp/core');
  const id = recordRefusal(srv.db, { noteUlid: null, projectUlid: null, kind: 'edit', key: null, reason: 'gone', cells: [] });
  const body: any = await (await fetch(`${srv.baseUrl}/api/refused`)).json();
  const row = body.results.find((r: any) => r.id === id);
  assert.equal(row.note, '-');
  assert.equal(row.project_code, '-');
  assert.equal(row.key, null);
  discardRefused(srv.db, id);
});

test('POST /api/refused/copy into a solo project returns the new ref and removes the row', async () => {
  const { refusal } = await seed('edit', 'Copy me');
  const res = await post('/api/refused/copy', { id: refusal, to: 'so' });
  const body: any = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.ref, /^SO-\d+$/);
  const n = Number(body.ref.slice(3));
  assert.equal(srv.db.prepare(`SELECT title FROM entries WHERE series = 'SO' AND id = ?`).get(n).title, 'Copy me');
  assert.ok(!(await listIds()).includes(refusal));
});

test('POST /api/refused/copy into a team project is 400 with core\'s sentence and keeps the refusal', async () => {
  const { refusal } = await seed('edit');
  const res = await post('/api/refused/copy', { id: refusal, to: 'TB' });
  const body: any = await res.json();
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /^TB is a team project\. Copy this note into a solo project instead/);
  assert.ok((await listIds()).includes(refusal));
});

test('POST /api/refused/copy into an unknown project is 400 with core\'s message', async () => {
  const { refusal } = await seed('edit');
  const res = await post('/api/refused/copy', { id: refusal, to: 'NOPE' });
  const body: any = await res.json();
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /^no project "NOPE" in this notebook\. Known: /);
  assert.ok((await listIds()).includes(refusal));
});

test('an unknown id is 404 with core\'s message, for copy and for delete', async () => {
  for (const id of [NEVER, 'not-an-id']) {
    const c = await post('/api/refused/copy', { id, to: 'SO' });
    const cb: any = await c.json();
    assert.equal(c.status, 404, JSON.stringify(cb));
    assert.equal(cb.error, `no refused change "${id}" on this laptop.`);
    const d = await post('/api/refused/delete', { id });
    const db: any = await d.json();
    assert.equal(d.status, 404, JSON.stringify(db));
    assert.equal(db.error, `no refused change "${id}" on this laptop.`);
  }
});

test('a missing id or target is 400 with a plain sentence', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['/api/refused/copy', { to: 'SO' }, 'Choose a refused change.'],
    ['/api/refused/copy', { id: NEVER }, 'Choose a solo project.'],
    ['/api/refused/copy', { id: NEVER, to: '  ' }, 'Choose a solo project.'],
    ['/api/refused/delete', {}, 'Choose a refused change.'],
    ['/api/refused/delete', { id: 7 }, 'Choose a refused change.'],
  ];
  for (const [path, body, error] of cases) {
    const res = await post(path, body);
    assert.equal(res.status, 400, path + ' ' + JSON.stringify(body));
    assert.deepEqual(await res.json(), { error });
  }
});

test('POST /api/refused/delete of a refused new note removes the row and the local note', async () => {
  const { refusal, note } = await seed('new', 'Throw away');
  const res = await post('/api/refused/delete', { id: refusal });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(!(await listIds()).includes(refusal));
  assert.equal(srv.db.prepare(`SELECT count(*) n FROM entries WHERE ulid = ?`).get(note).n, 0);
});
