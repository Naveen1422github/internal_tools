import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv;
before(async () => {
  srv = await startTestServer();
  await seedEntry(srv.db, { category: 'Reference', type: 'decision', module: 'alpha' });
  await seedEntry(srv.db, { category: 'Activity', type: 'changelog', module: 'alpha' });
  await seedEntry(srv.db, { category: 'Reference', type: 'gotcha', deprecated: 1 }); // excluded
});
after(() => srv.close());

test('stats returns non-deprecated totals grouped by category and type', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/stats');
  assert.strictEqual(res.status, 200);
  const body: any = await res.json();
  assert.strictEqual(body.total, 2); // deprecated one excluded
  assert.strictEqual(body.by_category.Reference, 1);
  assert.strictEqual(body.by_category.Activity, 1);
  assert.strictEqual(body.by_type.decision, 1);
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.top_modules.some((m: any) => m.module === 'alpha' && m.count === 2));
});
