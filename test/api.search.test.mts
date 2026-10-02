import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv;
before(async () => {
  srv = await startTestServer();
  await seedEntry(srv.db, { category: 'Reference', type: 'decision', title: 'Ref one' });
  await seedEntry(srv.db, { category: 'Activity', type: 'changelog', title: 'Act one' });
});
after(() => srv.close());

test('search filters by category', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/search?category=Reference');
  assert.strictEqual(res.status, 200);
  const { results }: any = await res.json();
  assert.ok(results.length >= 1);
  assert.ok(results.every((r: any) => r.category === 'Reference'));
});

test('search since=9999-01-01 returns nothing', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/search?since=9999-01-01');
  const { results }: any = await res.json();
  assert.strictEqual(results.length, 0);
});
