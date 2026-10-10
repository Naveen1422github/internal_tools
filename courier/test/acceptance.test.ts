// file: courier/test/acceptance.test.ts
// The spec's 9 acceptance tests ("done" = all pass), automated with two
// simulated machines and a post office in ONE process, using temp dirs.
// A = the main laptop (existing notes; the post office is seeded from it).
// B = the second laptop (joins with an empty notes file, D11).
// Each machine has a WRITER connection (what MCP/REST/scripts use) and its
// own courier, exactly as on a real machine. Tests run in this order and
// share the world; test 7 (revoke) runs last because it locks B out.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  migrateTo, addEntry, addEntryAsync, updateEntry, deleteEntry, initModule, getModule, doctor, searchEntries,
  getSyncValue, postOfficeTargetFromDb, requestJson, newUlid,
} from '@collab-mcp/core';
import { setModuleShared, revokeMember, seedFromNotesDb } from '@collab-mcp/post-office';
import { tempDir, startOffice, openWriter, closeWriter, until, sleep, type Office } from './world.js';
import { setup } from '../src/setup.js';
import { Courier } from '../src/engine.js';
import { COURIER_KEYS } from '../src/keys.js';

interface Machine { name: string; dbPath: string; courierDir: string; device: string; w: DB; c: Courier }
let t: ReturnType<typeof tempDir>;
let office: Office;
let A: Machine, B: Machine;
let preexistingTeamId = 0, preexistingPrivateId = 0;

const TIMING = { retryMs: 300, maxReconnectMs: 300 }; // the real defaults are 30 s; the debounce stays at 200 ms
function courier(m: Machine): Courier {
  const c = new Courier({ dbPath: m.dbPath, ...TIMING });
  c.start();
  return c;
}
const find = (db: DB, q: string) =>
  searchEntries(db, { query: q, kind: 'any', include_deprecated: false, limit: 20 }).results;
const row = (db: DB, id: number) =>
  db.prepare('SELECT ulid, title, description, needs_merge, deleted_at FROM entries WHERE id = ? ORDER BY ulid LIMIT 1').get(id) as
    | { ulid: string; title: string; description: string | null; needs_merge: number; deleted_at: string | null }
    | undefined;
const count = (db: DB) => (db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
const ctx = { platform: 'linux' as NodeJS.Platform, nodePath: 'node', binPath: 'bin.js', home: '/nowhere', env: {}, courierDir: '/nowhere', logPath: '/nowhere/log' };

before(async () => {
  t = tempDir('collab-acceptance-');
  // A: the main laptop, with notes from before sharing (0006 = today's live level).
  const aPath = join(t.dir, 'a', 'collab.db');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(t.dir, 'a'), { recursive: true });
  const seedDb = new Database(aPath);
  migrateTo(seedDb, '0006', { includeStaged: true });
  initModule(seedDb, { slug: 'team' });
  initModule(seedDb, { slug: 'private' });
  for (let i = 0; i < 30; i++) addEntry(seedDb, { type: 'session-note', title: `old note ${i}`, summary: 's', module: i % 2 ? 'team' : 'private' });
  preexistingTeamId = addEntry(seedDb, { type: 'decision', title: 'Existing ferret policy', summary: 'from before sharing', description: 'v0', module: 'team' }).id;
  preexistingPrivateId = addEntry(seedDb, { type: 'decision', title: 'Existing salary notes', summary: 'private, from before sharing', module: 'private' }).id;
  seedDb.close();

  office = await startOffice(t.dir, seedFromNotesDb(aPath));
  setModuleShared(office.store, 'team', true);

  const join1 = office.code('main laptop');
  await setup({ code: join1.code, dbPath: aPath, courierDir: join(t.dir, 'a-courier'), autostart: false, uploadExisting: true, includeStaged: true, autostartCtx: ctx, out: () => {} });
  const join2 = office.code('second laptop');
  const bPath = join(t.dir, 'b', 'collab.db');
  await setup({ code: join2.code, dbPath: bPath, courierDir: join(t.dir, 'b-courier'), autostart: false, includeStaged: true, autostartCtx: ctx, out: () => {} });

  A = { name: 'A', dbPath: aPath, courierDir: join(t.dir, 'a-courier'), device: join1.device, w: openWriter(aPath), c: null as unknown as Courier };
  B = { name: 'B', dbPath: bPath, courierDir: join(t.dir, 'b-courier'), device: join2.device, w: openWriter(bPath), c: null as unknown as Courier };
  A.c = courier(A);
  B.c = courier(B);
  // D11: the new machine downloads every shared module on first join.
  await until(() => find(B.w, 'ferret').length === 1, 10_000, 'B to receive the existing shared notes');
});

after(async () => {
  for (const m of [A, B]) { await m?.c?.stop(); if (m?.w) closeWriter(m.w); }
  await office?.close();
  t?.cleanup();
});

test('1. a note written on B appears on A within 2 s, and collab_search finds it', async () => {
  const t0 = Date.now();
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Pangolin migration plan', summary: 'written on B', module: 'team' });
  await until(() => find(A.w, 'pangolin').some((r) => r.id === id), 2000, 'A to find the note by search');
  assert.ok(Date.now() - t0 <= 2000, `took ${Date.now() - t0} ms`);
  assert.ok(id > preexistingPrivateId, 'its number came from the post office, after the seed');
});

test('2. B offline while A writes: B catches up on reconnect', async () => {
  await B.c.stop();
  const { id } = await addEntryAsync(A.w, { type: 'gotcha', title: 'Quokka cache gotcha', summary: 'written while B was away', module: 'team' });
  updateEntry(A.w, { id: preexistingTeamId, description: 'v1, edited while B was away' });
  await sleep(500);
  assert.equal(find(B.w, 'quokka').length, 0);
  B.c = courier(B);
  await until(() => find(B.w, 'quokka').some((r) => r.id === id), 5000, 'B to catch up the new note');
  await until(() => row(B.w, preexistingTeamId)?.description === 'v1, edited while B was away', 5000, 'B to catch up the edit');
});

// Stage C (E-820) replaces E-708's refusal: the new note is saved pending.
test('3. post office offline: a new note is saved pending (no number, says why); offline edits sync once it is back', async () => {
  const quokka = find(B.w, 'quokka')[0].id;
  await office.down();
  const before = count(B.w);
  const waiting = await addEntryAsync(B.w, { type: 'decision', title: 'Waiting note', summary: 's', module: 'team' });
  assert.equal(waiting.pending, true);
  assert.equal(waiting.id, null);
  assert.ok(waiting.pendingReason, 'the answer says why it has no number yet');
  assert.equal(count(B.w), before + 1, 'saved at once');
  updateEntry(B.w, { id: quokka, description: 'edited on B while the post office was down' });
  await until(() => B.c.status.state === 'offline', 3000, 'B to notice');
  await sleep(700); // a few retries fail meanwhile
  await office.up();
  await until(() => row(A.w, quokka)?.description === 'edited on B while the post office was down', 5000, 'the offline edit to arrive');
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Accepted again', summary: 's', module: 'team' });
  await until(() => !!row(A.w, id), 3000, 'new notes to flow again');
});

test('4. the same note edited on A and B: different paragraphs merge; the same line becomes needs_merge', async () => {
  const { id } = await addEntryAsync(A.w, { type: 'decision', title: 'Merge target', summary: 's', description: 'para one\n\npara two', module: 'team' });
  await until(() => row(B.w, id)?.description === 'para one\n\npara two', 3000);
  await Promise.all([A.c.stop(), B.c.stop()]); // both edit without seeing the other
  updateEntry(A.w, { id, description: 'para one (A)\n\npara two' });
  updateEntry(B.w, { id, description: 'para one\n\npara two (B)' });
  A.c = courier(A);
  B.c = courier(B);
  const merged = 'para one (A)\n\npara two (B)';
  await until(() => row(A.w, id)?.description === merged && row(B.w, id)?.description === merged, 8000, 'the merged text on both');
  assert.equal(row(A.w, id)!.needs_merge, 0);

  await Promise.all([A.c.stop(), B.c.stop()]);
  updateEntry(A.w, { id, description: 'para ONE by A\n\npara two (B)' });
  updateEntry(B.w, { id, description: 'para ONE by B\n\npara two (B)' });
  A.c = courier(A);
  B.c = courier(B);
  await until(() => row(A.w, id)?.needs_merge === 1 && row(B.w, id)?.needs_merge === 1, 8000, 'needs_merge on both');
  assert.ok(getModule(A.w, 'team').needs_merge.some((n) => n.id === id), 'shown on the module card');
  assert.equal(doctor(B.w).checks.find((c) => c.name === 'sync.needs_merge')!.severity, 'warn', 'and in doctor');
  const texts = (A.w.prepare('SELECT description FROM entry_revisions WHERE entry_ulid = ?').all(row(A.w, id)!.ulid) as Array<{ description: string }>).map((r) => r.description);
  assert.ok(texts.includes('para ONE by A\n\npara two (B)') && texts.includes('para ONE by B\n\npara two (B)'), 'nothing silently lost');
});

test('5. a delete on A is gone on B and never comes back after further syncs', async () => {
  const { id } = await addEntryAsync(A.w, { type: 'decision', title: 'Wombat note to delete', summary: 's', module: 'team' });
  await until(() => find(B.w, 'wombat').length === 1, 3000);
  const ulid = row(A.w, id)!.ulid;
  deleteEntry(A.w, id);
  await until(() => find(B.w, 'wombat').length === 0, 3000, 'the delete to reach B');
  assert.ok(row(B.w, id)!.deleted_at);
  assert.throws(() => updateEntry(B.w, { id, title: 'resurrect?' }), /no entry found/);
  const { id: later } = await addEntryAsync(B.w, { type: 'decision', title: 'After the wombat', summary: 's', module: 'team' });
  updateEntry(A.w, { id: preexistingTeamId, description: 'v2, after the delete' });
  await until(() => !!row(A.w, later) && row(B.w, preexistingTeamId)?.description === 'v2, after the delete', 3000, 'further syncs');
  for (const db of [A.w, B.w, office.store]) {
    assert.ok((db.prepare('SELECT deleted_at FROM entries WHERE ulid = ?').get(ulid) as { deleted_at: string | null }).deleted_at, 'still a tombstone');
  }
  assert.equal([...find(A.w, 'wombat'), ...find(B.w, 'wombat')].filter((r) => r.id === id).length, 0, 'search never finds it again');
});

test('6. a private-module note never leaves its machine (checked on the post office store)', async () => {
  const p = await addEntryAsync(A.w, { type: 'decision', title: 'Salary bands', summary: 'private', module: 'private' });
  const loose = await addEntryAsync(A.w, { type: 'decision', title: 'No module at all', summary: 's' });
  const marker = await addEntryAsync(A.w, { type: 'decision', title: 'Marker after the private notes', summary: 's', module: 'team' });
  await until(() => !!row(B.w, marker.id), 3000, "A's courier to push past the private notes");
  for (const id of [p.id, loose.id, preexistingPrivateId]) {
    const ulid = row(A.w, id)!.ulid;
    assert.equal(office.store.prepare('SELECT 1 FROM entries WHERE ulid = ?').get(ulid), undefined, `E-${id} is on the post office`);
    assert.equal((office.store.prepare('SELECT COUNT(*) c FROM po_deliveries WHERE instr(pk, ?) > 0').get(Buffer.from(ulid)) as { c: number }).c, 0);
    assert.equal(row(B.w, id)?.ulid === ulid, false);
  }
  assert.ok(office.store.prepare('SELECT 1 FROM po_allocations WHERE ulid = ?').get(row(A.w, p.id)!.ulid), 'only its ULID went out, to get its number');
});

test('8. the courier is killed between send and acknowledgement: no loss, no duplicate', async () => {
  let armed = true;
  office.hooks.dropChangesAnswer = (device) => device === B.device && armed && !(armed = false);
  const sentBefore = Number(getSyncValue(B.w, COURIER_KEYS.sent));
  const { id } = await addEntryAsync(B.w, { type: 'decision', title: 'Axolotl delivery', summary: 's', module: 'team' });
  await until(() => !armed, 3000, 'the post office to accept the batch and lose the answer');
  await B.c.stop(); // "killed" before it could record the acknowledgement
  office.hooks.dropChangesAnswer = undefined;
  assert.equal(Number(getSyncValue(B.w, COURIER_KEYS.sent)), sentBefore, 'not acknowledged => bookmark unchanged');
  const deliveries = (office.store.prepare('SELECT COUNT(*) c FROM po_deliveries').get() as { c: number }).c;
  B.c = courier(B); // restarts from its bookmark and sends the same changes again
  await until(() => Number(getSyncValue(B.w, COURIER_KEYS.sent)) > sentBefore, 5000, 'the resend to be acknowledged');
  assert.equal((office.store.prepare('SELECT COUNT(*) c FROM po_deliveries').get() as { c: number }).c, deliveries, 'the resend was all duplicates');
  await until(() => !!row(A.w, id), 3000);
  for (const db of [A.w, B.w, office.store]) {
    assert.equal((db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(id) as { c: number }).c, 1, 'exactly one copy');
  }
});

test('9. doctor duplicate_entry_ids stays ok everywhere; the allocator returns the same number for a repeated ULID', async () => {
  for (const db of [A.w, B.w, office.store]) {
    assert.equal(doctor(db).checks.find((c) => c.name === 'data.duplicate_entry_ids')!.severity, 'ok');
  }
  const target = postOfficeTargetFromDb(B.w)!;
  const ulid = newUlid();
  const first = await requestJson(target, 'POST', '/v1/allocate', { ulid });
  const again = await requestJson(target, 'POST', '/v1/allocate', { ulid });
  assert.equal(first.status, 200);
  assert.equal(again.body.id, first.body.id);
});

test('7. a revoked key is refused', async () => {
  revokeMember(office.store, B.device);
  await until(() => B.c.status.state === 'revoked', 3000, 'B to be told');
  assert.match(B.c.status.lastError ?? '', /revoked/);
  // Stage C (E-820): saving is never refused; the note waits, and says why.
  const after = await addEntryAsync(B.w, { type: 'decision', title: 'After revoke', summary: 's', module: 'team' });
  assert.equal(after.pending, true);
  assert.match(after.pendingReason ?? '', /revoked/);
  const fromB = () => office.requests.filter((r) => r.device === B.device).length;
  const n = fromB();
  await sleep(1000);
  assert.equal(fromB(), n, 'no retries or reconnects from B');
  assert.equal(B.c.pendingTimers(), 0, 'no retry or reconnect pending');
  assert.equal((await requestJson(postOfficeTargetFromDb(A.w)!, 'GET', '/v1/status')).status, 200, 'A is unaffected');
});
