import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';

// J17 (piece 2 stage A): a note can be read by its ULID, and "superseded by"
// is printed from superseded_by_ulid (the note's current number), not the stored integer.
let srv, bId, bUlid;
const ulidOf = (id) => srv.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id).ulid;
before(async () => {
  srv = await startTestServer({ level: '0006' });
  await seedEntry(srv.db, { title: 'filler' });
  bId = await seedEntry(srv.db, { title: 'note B' });
  bUlid = ulidOf(bId);
});
after(() => srv.close());

test('GET /api/collab/entry?ulid= returns the note', async () => {
  const res = await fetch(`${srv.baseUrl}/api/collab/entry?ulid=${bUlid}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ulid, bUlid);
  assert.equal(body.id, bId);
  assert.equal(body.title, 'note B');
});

test('an unknown ULID is 404', async () => {
  const res = await fetch(`${srv.baseUrl}/api/collab/entry?ulid=01ARZ3NDEKTSV4RRFFQ69G5FAV`);
  assert.equal(res.status, 404);
});

test('neither id nor ulid is 400; a malformed ulid is 400', async () => {
  assert.equal((await fetch(`${srv.baseUrl}/api/collab/entry`)).status, 400);
  assert.equal((await fetch(`${srv.baseUrl}/api/collab/entry?ulid=not-a-ulid`)).status, 400);
});

test('an exported note superseded by B prints B\'s current number', async () => {
  const { supersede, exportEntries } = await import('@collab-mcp/core');
  const oldId = await seedEntry(srv.db, { title: 'old note' });
  supersede(srv.db, { ids: [oldId], by: bId });
  // B gets a new number (as a renumbering would); the stored integer still says bId.
  srv.db.prepare('UPDATE entries SET id = 4242 WHERE ulid = ?').run(bUlid);
  const md = exportEntries(srv.db, { format: 'markdown', include_deprecated: true }).body;
  const line = md.split('\n').find((l) => l.includes('superseded by'));
  assert.ok(line, md);
  assert.match(line, /superseded by: E-04242/);
  srv.db.prepare('UPDATE entries SET id = ? WHERE ulid = ?').run(bId, bUlid);
});
