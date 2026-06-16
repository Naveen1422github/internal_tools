import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from './helpers/server.mjs';

let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

async function post(path, body) {
  return fetch(srv.baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('upsert creates a new entry and returns its id', async () => {
  const res = await post('/api/collab/entry/upsert', {
    type: 'decision', title: 'New decision', summary: 'A summary',
  });
  assert.strictEqual(res.status, 200);
  const body: any = await res.json();
  assert.strictEqual(body.ok, true);
  assert.ok(Number.isInteger(body.id), 'returns numeric id');
  const row: any = srv.db.prepare('SELECT title, kind, category FROM entries WHERE rowid = ?').get(body.id);
  assert.strictEqual(row.title, 'New decision');
  assert.strictEqual(row.kind, 'signal');        // derived from type
  assert.strictEqual(row.category, 'Reference');  // decision -> Reference
});

test('upsert updates an existing entry in place', async () => {
  const create: any = await (await post('/api/collab/entry/upsert', {
    type: 'gotcha', title: 'Original', summary: 'orig',
  })).json();
  const res = await post('/api/collab/entry/upsert', {
    id: create.id, type: 'gotcha', title: 'Edited', summary: 'edited',
  });
  assert.strictEqual(res.status, 200);
  const row: any = srv.db.prepare('SELECT title, summary FROM entries WHERE rowid = ?').get(create.id);
  assert.strictEqual(row.title, 'Edited');
  assert.strictEqual(row.summary, 'edited');
});

test('upsert rejects missing summary', async () => {
  const res = await post('/api/collab/entry/upsert', { type: 'decision', title: 'No summary' });
  assert.strictEqual(res.status, 400);
});

test('upsert rejects summary over 200 chars', async () => {
  const res = await post('/api/collab/entry/upsert', {
    type: 'decision', title: 'Too long', summary: 'x'.repeat(201),
  });
  assert.strictEqual(res.status, 400);
});

test('upsert rejects invalid type', async () => {
  const res = await post('/api/collab/entry/upsert', {
    type: 'not-a-type', title: 'Bad', summary: 'bad',
  });
  assert.strictEqual(res.status, 400);
});

test('upsert rejects rollup (system-generated)', async () => {
  const res = await post('/api/collab/entry/upsert', {
    type: 'rollup', title: 'Nope', summary: 'nope',
  });
  assert.strictEqual(res.status, 400);
});
