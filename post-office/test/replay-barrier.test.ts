// RnR S2: a project owed a replay to the caller is not delivered by the normal fetch (R14 barrier).
import { test } from 'node:test';
import assert from 'node:assert';
import { newUlid, decodeChange } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import { fetchDeliveries, fetchReplay } from '../src/deliveries.js';
import { registerProject, type Store } from '../src/store.js';
import { setProjectMember } from '../src/access.js';

function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
}
function row(store: Store, proj: string | null, val: string, origin = 'd-a'): number {
  return Number(store.prepare(
    `INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, project_ulid)
     VALUES (?, 'entries', X'0101', 'title', ?, 1, (SELECT COALESCE(MAX(seq),0)+1 FROM po_deliveries), X'00112233445566778899aabbccddeeff', 1, 0, ?)`,
  ).run(origin, val, proj).lastInsertRowid);
}
const vals = (r: { changes: any[] }) => r.changes.map((w) => decodeChange(w).val);
const upto = (s: Store, d: string, p: string) =>
  (s.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(d, p) as { upto_seq: number } | undefined)?.upto_seq;

function setup() {
  const { store, cleanup } = tempStore();
  for (const d of ['d-a', 'd-b']) member(store, d);
  const P = registerProject(store, { ulid: newUlid(), name: 'P', code: 'PP' }, 'd-a').ulid;
  const Q = registerProject(store, { ulid: newUlid(), name: 'Q', code: 'QQ' }, 'd-a').ulid;
  return { store, cleanup, P, Q };
}

test('a P row fetched while a replay of P is owed is withheld and moved into the replay', () => {
  const { store, cleanup, P } = setup();
  try {
    row(store, P, 'old');
    setProjectMember(store, 'd-a', P, 'd-b', 'Reader');
    const granted = upto(store, 'd-b', P)!;
    const edit = row(store, P, 'edit');
    const f = fetchDeliveries(store, 'd-b', granted);
    assert.deepEqual(vals(f), [], 'the P edit is withheld');
    assert.equal(f.lastSeq, edit);
    assert.equal(upto(store, 'd-b', P), edit, 'upto_seq now covers the withheld row');
    assert.deepEqual(vals(fetchReplay(store, 'd-b', P, 0)), ['old', 'edit'], 'the replay carries history then the edit, in order');
  } finally { cleanup(); }
});

test('other projects and NULL rows still flow while P is owed', () => {
  const { store, cleanup, P, Q } = setup();
  try {
    setProjectMember(store, 'd-a', P, 'd-b', 'Reader');
    setProjectMember(store, 'd-a', Q, 'd-b', 'Reader');
    store.prepare(`DELETE FROM po_replays WHERE device_id = 'd-b' AND project_ulid = ?`).run(Q); // only P is owed
    const base = upto(store, 'd-b', P)!;
    row(store, P, 'p1'); row(store, Q, 'q1'); row(store, null, 'none'); const lastP = row(store, P, 'p2');
    const f = fetchDeliveries(store, 'd-b', base);
    assert.deepEqual(vals(f), ['q1', 'none']);
    assert.equal(upto(store, 'd-b', P), lastP);
  } finally { cleanup(); }
});

test('only the caller\'s own owed projects are withheld', () => {
  const { store, cleanup, P } = setup();
  try {
    member(store, 'd-c');
    setProjectMember(store, 'd-a', P, 'd-b', 'Reader');
    store.prepare(`DELETE FROM po_replays WHERE device_id = 'd-b'`).run();
    setProjectMember(store, 'd-a', P, 'd-c', 'Reader'); // d-c owes a replay, d-b does not
    const base = upto(store, 'd-c', P)!;
    row(store, P, 'p1');
    assert.deepEqual(vals(fetchDeliveries(store, 'd-b', base)), ['p1']);
    assert.equal(upto(store, 'd-c', P), base, 'another device\'s replay is untouched');
  } finally { cleanup(); }
});

test('after the replay is confirmed done, P rows flow through the normal fetch again', () => {
  const { store, cleanup, P } = setup();
  try {
    row(store, P, 'old');
    setProjectMember(store, 'd-a', P, 'd-b', 'Reader');
    const g = upto(store, 'd-b', P)!;
    const r = fetchReplay(store, 'd-b', P, 0);
    assert.equal(fetchReplay(store, 'd-b', P, r.last_seq).done, true);
    assert.equal(upto(store, 'd-b', P), undefined);
    row(store, P, 'new');
    assert.deepEqual(vals(fetchDeliveries(store, 'd-b', g)), ['new']);
  } finally { cleanup(); }
});
