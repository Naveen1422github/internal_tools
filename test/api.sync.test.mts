// file: test/api.sync.test.mts
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv: any;
before(async () => { srv = await startTestServer({ level: '0006' }); });
after(() => srv.close());

const get = async (p: string) => { const r = await fetch(srv.baseUrl + p); return { status: r.status, body: await r.json() }; };
const post = async (p: string, b: unknown) => { const r = await fetch(srv.baseUrl + p, { method: 'POST', body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('status on an unshared notebook is { enabled: false }', async () => {
  const r = await get('/api/sync/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: false });
});

test('needs-merge lists a flagged SESSION-NOTE (search filters do not hide it)', async () => {
  const id = await seedEntry(srv.db, { type: 'session-note', category: 'Activity', title: 'flagged log', module: 'm' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await get('/api/sync/needs-merge');
  assert.ok(r.body.results.some((x: any) => x.id === id && x.title === 'flagged log'));
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('versions of a note that is not flagged -> 404', async () => {
  const id = await seedEntry(srv.db, { title: 'calm' });
  assert.equal((await get(`/api/sync/versions?id=${id}`)).status, 404);
});

test('resolve with stale versions -> 409 versions-changed; bad body -> 400', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await post('/api/sync/resolve', { id, expectedHeads: ['stale'], choice: 'keep-current' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'versions-changed' });
  assert.equal((await post('/api/sync/resolve', { id })).status, 400);
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('upsert of a flagged note is refused with the merge link (V9)', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged2' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const r = await post('/api/collab/entry/upsert', { id, type: 'decision', title: 'x', summary: 'y' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /needs a merge first: open \/merge\//);
  srv.db.prepare('UPDATE entries SET needs_merge = 0 WHERE id = ?').run(id);
});

test('explain without an AI key -> 503 ai-unavailable', async () => {
  const id = await seedEntry(srv.db, { title: 'flagged3' });
  srv.db.prepare('UPDATE entries SET needs_merge = 1 WHERE id = ?').run(id);
  const saved = [process.env.GROQ_API_KEY, process.env.GROK_API_KEY];
  delete process.env.GROQ_API_KEY; delete process.env.GROK_API_KEY;
  const r = await post('/api/sync/explain', { id });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'ai-unavailable' });
  [process.env.GROQ_API_KEY, process.env.GROK_API_KEY] = saved as any;
});
