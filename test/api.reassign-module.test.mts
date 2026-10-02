import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

let srv, e1, e2;
before(async () => {
  srv = await startTestServer();
  srv.db.prepare("INSERT INTO modules (slug, name) VALUES ('target', 'Target')").run();
  e1 = await seedEntry(srv.db, { title: 'orphan 1', module: 'ghost' });
  e2 = await seedEntry(srv.db, { title: 'orphan 2', module: 'ghost' });
});
after(() => srv.close());

async function post(path, body) {
  return fetch(srv.baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('reassign-module repoints entries to an existing module', async () => {
  const res = await post('/api/collab/entry/reassign-module', { ids: [e1, e2], module: 'target' });
  assert.strictEqual(res.status, 200);
  const body: any = await res.json();
  assert.strictEqual(body.updated, 2);
  for (const id of [e1, e2]) {
    const row: any = srv.db.prepare('SELECT module FROM entries WHERE id = ?').get(id);
    assert.strictEqual(row.module, 'target');
    const jm: any = srv.db.prepare("SELECT module FROM entry_modules WHERE entry_ulid = (SELECT ulid FROM entries WHERE id = ?) AND module = 'target'").get(id);
    assert.ok(jm, 'entry_modules row exists for target');
  }
});

test('reassign-module rejects unknown target module', async () => {
  const res = await post('/api/collab/entry/reassign-module', { ids: [e1], module: 'does-not-exist' });
  assert.strictEqual(res.status, 400);
});

// Regression: entry already a SECONDARY member of the target must end up with
// exactly one is_primary=1 row for the target (the ON CONFLICT upsert path).
test('reassign-module promotes an existing secondary membership to primary', async () => {
  const e3 = await seedEntry(srv.db, { title: 'already member', module: 'ghost' });
  // e3 is also a secondary member of 'target' before reassign.
  srv.db.prepare("INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES ((SELECT ulid FROM entries WHERE id = ?), ?, 'target', 0)").run(e3, e3);

  const res = await post('/api/collab/entry/reassign-module', { ids: [e3], module: 'target' });
  assert.strictEqual(res.status, 200);

  const primaries: any = srv.db
    .prepare("SELECT module FROM entry_modules WHERE entry_ulid = (SELECT ulid FROM entries WHERE id = ?) AND is_primary = 1").all(e3);
  assert.strictEqual(primaries.length, 1, 'exactly one primary row');
  assert.strictEqual(primaries[0].module, 'target', 'primary is the target module');
});
