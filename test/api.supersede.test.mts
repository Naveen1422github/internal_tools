import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv, oldId, newId;
before(async () => {
  srv = await startTestServer();
  oldId = await seedEntry(srv.db, { title: 'old' });
  newId = await seedEntry(srv.db, { title: 'new' });
});
after(() => srv.close());

async function post(path, body) {
  return fetch(srv.baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('supersede marks old entry deprecated and sets superseded_by', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [oldId], by: newId });
  assert.strictEqual(res.status, 200);
  const row: any = srv.db.prepare('SELECT superseded_by, deprecated FROM entries WHERE id = ?').get(oldId);
  assert.strictEqual(row.superseded_by, newId);
  assert.strictEqual(row.deprecated, 1);
});

test('supersede rejects by-in-ids', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [newId], by: newId });
  assert.strictEqual(res.status, 400);
});

test('supersede rejects missing by', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [oldId], by: 999999 });
  assert.strictEqual(res.status, 400);
});
