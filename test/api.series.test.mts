// Stage B1: REST routes read SH-12 style references; bare numbers mean the E series.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv, eId, shUlid, eUlid;
before(async () => {
  srv = await startTestServer();
  const { createProject, addEntry } = await import('@collab-mcp/core');
  createProject(srv.db, { name: 'supporthub', code: 'SH' });
  addEntry(srv.db, { type: 'decision', title: 'SH one', summary: 's', project: 'SH' });   // SH-1, created first
  eId = await seedEntry(srv.db, { title: 'E one' });                                         // E-1
  shUlid = srv.db.prepare(`SELECT ulid FROM entries WHERE series = 'SH' AND id = 1`).get().ulid;
  eUlid = srv.db.prepare(`SELECT ulid FROM entries WHERE series = 'E' AND id = ?`).get(eId).ulid;
});
after(() => srv.close());

const get = (q) => fetch(`${srv.baseUrl}/api/collab/entry?${q}`);
const post = (path, body) => fetch(srv.baseUrl + path, { method: 'POST', body: JSON.stringify(body) });

test('GET entry: ?id=SH-1 is the project note, ?id=1 the E note, ?id=SH1 a 400 naming the forms', async () => {
  assert.equal(eId, 1);
  const sh = await get('id=SH-1');
  assert.equal(sh.status, 200);
  const shBody = await sh.json();
  assert.equal(shBody.title, 'SH one');
  assert.equal(shBody.series, 'SH');
  const e = await (await get('id=1')).json();
  assert.equal(e.title, 'E one');
  assert.equal(e.series, 'E');
  const bad = await get('id=SH1');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /SH-12/);
});

test('search payloads carry the series', async () => {
  const r = await (await fetch(`${srv.baseUrl}/api/collab/search?q=one&kind=any`)).json();
  const got = r.results.map((x) => `${x.series}-${x.id}`).sort();
  assert.deepEqual(got, ['E-1', 'SH-1']);
});

test('supersede with string refs: SH-1 replaced by E-1, written by ULID', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: ['SH-1'], by: 1 });
  assert.equal(res.status, 200, await res.clone().text());
  const row = srv.db.prepare(`SELECT superseded_by_ulid u, deprecated d FROM entries WHERE ulid = ?`).get(shUlid);
  assert.equal(row.u, eUlid);
  assert.equal(row.d, 1);
  assert.equal(srv.db.prepare(`SELECT deprecated d FROM entries WHERE ulid = ?`).get(eUlid).d, 0);
  const bad = await post('/api/collab/entry/supersede', { ids: ['SH-1'], by: 'nope' });
  assert.equal(bad.status, 400);
});

test('edit and delete by string ref reach the project note only', async () => {
  const up = await post('/api/collab/entry/upsert', { id: 'SH-1', type: 'decision', title: 'SH one edited', summary: 's' });
  assert.equal(up.status, 200, await up.clone().text());
  assert.equal(srv.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(shUlid).title, 'SH one edited');
  assert.equal(srv.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(eUlid).title, 'E one');
  const del = await post('/api/collab/entry/delete', { id: 'SH-1' });
  assert.equal(del.status, 200, await del.clone().text());
  assert.ok(srv.db.prepare(`SELECT deleted_at FROM entries WHERE ulid = ?`).get(shUlid).deleted_at);
  assert.equal(srv.db.prepare(`SELECT deleted_at FROM entries WHERE ulid = ?`).get(eUlid).deleted_at, null);
});
