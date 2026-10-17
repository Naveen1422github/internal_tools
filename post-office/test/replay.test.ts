// RnR R14: a device newly given note.view receives that project's past changes once.
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid, requestJson, decodeChange } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import { office } from './office.js';
import { fetchReplay } from '../src/deliveries.js';
import { registerProject, type Store } from '../src/store.js';
import { setProjectMember } from '../src/access.js';

function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
}
/** A delivery row stamped for `proj` (null = no project, '?' = held); the val tags it so tests can tell rows apart. */
function row(store: Store, proj: string | null, val: string, origin = 'd-a'): number {
  return Number(store.prepare(
    `INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, project_ulid)
     VALUES (?, 'entries', X'0101', 'title', ?, 1, (SELECT COALESCE(MAX(seq),0)+1 FROM po_deliveries), X'00112233445566778899aabbccddeeff', 1, 0, ?)`,
  ).run(origin, val, proj).lastInsertRowid);
}
const vals = (r: { changes: any[] }) => r.changes.map((w) => decodeChange(w).val);
const hasReplay = (s: Store, d: string, p: string) => !!s.prepare(`SELECT 1 FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(d, p);

test('replay returns only that project, only up to upto_seq, paged', () => {
  const { store, cleanup } = tempStore();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    const A = registerProject(store, { ulid: newUlid(), name: 'A', code: 'AA' }, 'd-a').ulid;
    const B = registerProject(store, { ulid: newUlid(), name: 'B', code: 'BB' }, 'd-a').ulid;
    row(store, A, 'a1'); row(store, B, 'b1'); row(store, null, 'none'); row(store, '?', 'held'); row(store, A, 'a2'); row(store, A, 'a3');
    setProjectMember(store, 'd-a', A, 'd-b', 'Reader');
    row(store, A, 'a-after'); // above upto_seq: normal delivery's job
    const upto = (store.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = 'd-b'`).get() as { upto_seq: number }).upto_seq;

    const p1 = fetchReplay(store, 'd-b', A, 0, 2);
    assert.deepEqual(vals(p1), ['a1', 'a2']);
    assert.equal(p1.more, true);
    assert.equal(p1.done, false);
    const p2 = fetchReplay(store, 'd-b', A, p1.last_seq, 2);
    assert.deepEqual(vals(p2), ['a3']);
    assert.equal(p2.more, false);
    assert.equal(p2.done, false);
    assert.equal(p2.last_seq, upto, 'the last page points at upto_seq so the next call confirms');
  } finally { cleanup(); }
});

test('replay row is deleted only by the confirming call (after >= upto_seq)', () => {
  const { store, cleanup } = tempStore();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    const A = registerProject(store, { ulid: newUlid(), name: 'A', code: 'AA' }, 'd-a').ulid;
    row(store, A, 'a1');
    setProjectMember(store, 'd-a', A, 'd-b', 'Reader');
    const p = fetchReplay(store, 'd-b', A, 0, 100);
    assert.equal(p.done, false);
    assert.ok(hasReplay(store, 'd-b', A), 'a crash after the page still leaves the replay');
    assert.deepEqual(vals(fetchReplay(store, 'd-b', A, 0, 100)), ['a1'], 'resuming gives the same page');
    const c = fetchReplay(store, 'd-b', A, p.last_seq, 100);
    assert.equal(c.done, true);
    assert.deepEqual(c.changes, []);
    assert.ok(!hasReplay(store, 'd-b', A));
    const again = fetchReplay(store, 'd-b', A, 0, 100);
    assert.equal(again.done, true);
    assert.deepEqual(again.changes, [], 'no replay row = nothing');
  } finally { cleanup(); }
});

test('replay drops a replay whose membership row is gone', () => {
  const { store, cleanup } = tempStore();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    const A = registerProject(store, { ulid: newUlid(), name: 'A', code: 'AA' }, 'd-a').ulid;
    row(store, A, 'a1');
    setProjectMember(store, 'd-a', A, 'd-b', 'Reader');
    store.prepare(`DELETE FROM po_project_members WHERE device_id = 'd-b'`).run();
    const r = fetchReplay(store, 'd-b', A, 0, 100);
    assert.equal(r.done, true);
    assert.deepEqual(r.changes, []);
    assert.ok(!hasReplay(store, 'd-b', A));
  } finally { cleanup(); }
});

test('GET /v1/replay: member gets it; non-member 404; member without note.view 403 naming it', async () => {
  const o = await office();
  try {
    const n = await o.join('N'), r = await o.join('R'), x = await o.join('X');
    const A = { ulid: newUlid(), name: 'Proj', code: 'RPL' };
    assert.equal((await requestJson(o.target(n), 'POST', '/v1/projects', A)).status, 200);
    row(o.store, A.ulid, 'a1', n.device);
    assert.equal((await requestJson(o.target(n), 'PUT', `/v1/projects/${A.ulid}/members/${r.device}`, { role: 'Reader' })).status, 200);
    const ok = await requestJson(o.target(r), 'GET', `/v1/replay?project=${A.ulid}&after=0&limit=10`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.changes.length, 1);
    assert.equal(ok.body.done, false);
    const fin = await requestJson(o.target(r), 'GET', `/v1/replay?project=${A.ulid}&after=${ok.body.last_seq}`);
    assert.equal(fin.body.done, true);

    const non = await requestJson(o.target(x), 'GET', `/v1/replay?project=${A.ulid}`);
    assert.equal(non.status, 404);
    assert.deepEqual(non.body, { error: 'no such team project' });
    assert.equal((await requestJson(o.target(x), 'GET', `/v1/replay?project=${newUlid()}`)).status, 404);
    assert.equal((await requestJson(o.target(x), 'GET', `/v1/replay`)).status, 400);

    // A member whose role lacks note.view
    const blindUlid = newUlid();
    o.store.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, 'Blind', '[]', 0)`).run(blindUlid, A.ulid);
    o.store.prepare(`INSERT INTO po_project_members (project_ulid, device_id, role_ulid) VALUES (?, ?, ?)`).run(A.ulid, x.device, blindUlid);
    const blind = await requestJson(o.target(x), 'GET', `/v1/replay?project=${A.ulid}`);
    assert.equal(blind.status, 403);
    assert.match(blind.body.error, /note\.view/);
  } finally { await o.stop(); }
});
