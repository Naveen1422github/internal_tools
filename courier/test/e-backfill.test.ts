// file: courier/test/e-backfill.test.ts
// Task 7: the laptop adopts E (by itself, after the office did) and backfills E to its members.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, addEntry, newUlid, initModule, createProject, createProjectOp, bindModule, listBindings,
  getSyncValue, setSyncValue, isEAdopted, neverSend, readAccessCache, requestJson, postOfficeTargetFromDb,
  E_ADOPTED_KEY, NEVER_SEND_KEY, E_PROJECT_ULID,
} from '@collab-mcp/core';
import { setModuleShared, adoptE } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, type Office } from './world.js';
import { Courier, type CourierOptions } from '../src/engine.js';
import { COURIER_KEYS } from '../src/keys.js';

async function setting() {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const opened: Array<() => void> = [];
  const couriers: Courier[] = [];
  const logs: string[] = [];
  const machine = async (name: string, opts: Partial<CourierOptions> = {}) => {
    const j = await joinedDb(office, t.dir, name);
    const w = openWriter(j.path);
    opened.push(() => closeWriter(w));
    const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000, log: (l) => logs.push(l), ...opts });
    couriers.push(c);
    return { ...j, w, c };
  };
  return {
    office, machine, logs,
    done: async () => { for (const c of couriers) await c.stop(); for (const o of opened) o(); await office.close(); t.cleanup(); },
  };
}
const inStore = (o: Office, title: string) => !!o.store.prepare('SELECT 1 FROM entries WHERE title = ?').get(title);
const note = (title: string, module?: string) => ({ type: 'decision' as const, title, summary: 's', ...(module ? { module } : {}) });
const dbv = (w: any) => (w.prepare('SELECT crsql_db_version() v').get() as { v: number }).v;

test('after adoption one backfill sends the E notes not in never-send, and none twice', async () => {
  const s = await setting();
  try {
    const a = await s.machine('a', { autoAdoptE: false });
    const unsentA = await addEntryAsync(a.w, note('never reached the office', 'later'));
    const priv = await addEntryAsync(a.w, note('private', 'secret'));
    await a.c.syncNow(); // numbers both; neither module is shared, so nothing of them is sent
    assert.equal(inStore(s.office, 'never reached the office'), false);
    // Adopted here by hand, with the bookmark already past both notes: only the E backfill can send one.
    setSyncValue(a.w, COURIER_KEYS.sent, String(dbv(a.w)));
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    setSyncValue(a.w, NEVER_SEND_KEY, JSON.stringify([priv.ulid]));
    setSyncValue(a.w, E_ADOPTED_KEY, '1');
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'never reached the office'), true, 'backfilled');
    assert.equal(inStore(s.office, 'private'), false, 'never-send stays here');
    assert.ok(JSON.parse(getSyncValue(a.w, COURIER_KEYS.backfilledProjects) ?? '[]').includes(E_PROJECT_ULID), 'E backfill recorded');
    const sent = a.c.status.sentTotal;
    await a.c.pushNow();
    await a.c.syncNow();
    assert.equal(a.c.status.sentTotal, sent, 'the backfill is not sent again');
    assert.equal(a.w.prepare(`SELECT COUNT(*) n FROM refused_changes`).get().n, 0, 'the office refused nothing');
    void unsentA;
  } finally { await s.done(); }
});

test('an adopted laptop holds E changes when the cached office access says E is not adopted', async () => {
  const s = await setting();
  try {
    const a = await s.machine('a', { autoAdoptE: false });
    const n = await addEntryAsync(a.w, note('held until office adoption', 'private'));
    setSyncValue(a.w, E_ADOPTED_KEY, '1');
    setSyncValue(a.w, 'e_access', JSON.stringify({ adopted: false, member: false }));
    const before = getSyncValue(a.w, COURIER_KEYS.sent);
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'held until office adoption'), false, 'E note is not sent to an unadopted office');
    assert.equal(Number(getSyncValue(a.w, COURIER_KEYS.sent) ?? 0), Number(before ?? 0), 'the held change is not dropped behind the sent bookmark');
    assert.equal(a.c.status.state, 'needs-update');
    assert.match(a.c.status.lastError ?? '', /E changes are held locally/);
    void n;
  } finally { await s.done(); }
});

test('the courier adopts E by itself once the office has; unsent changes wait for the push first', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'shared', true);
    const a = await s.machine('a');
    await addEntryAsync(a.w, note('team note', 'shared'));
    await addEntryAsync(a.w, note('kept note', 'secret'));
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), false, 'the office has not adopted E');
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    const late = await addEntryAsync(a.w, note('written just before', 'shared')); // unsent when /v1/access answers
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), true, `adopted after the push cleared the unsent changes\n${s.logs.join('\n')}`);
    assert.ok(s.logs.some((l) => /sync first: \d+ change\(s\) not yet sent/.test(l)), s.logs.join('\n'));
    assert.equal(inStore(s.office, 'written just before'), true);
    const keep = a.w.prepare(`SELECT ulid FROM entries WHERE title = 'kept note'`).get() as { ulid: string };
    assert.deepEqual([...neverSend(a.w)], [keep.ulid]);
    assert.equal(inStore(s.office, 'kept note'), false);
    // E is never a local project, nor a cached project, though /v1/access lists it.
    const r = await requestJson(postOfficeTargetFromDb(a.w)!, 'GET', '/v1/access');
    assert.ok((r.body.projects as Array<{ code: string }>).some((p) => p.code === 'E'), 'the office lists E');
    assert.equal(a.w.prepare(`SELECT 1 FROM projects WHERE code = 'E' OR ulid = ?`).get(E_PROJECT_ULID), undefined);
    assert.equal(readAccessCache(a.w).has(E_PROJECT_ULID), false);
    // After adoption: a new note in the shared module goes to E (bound) and reaches the office.
    await addEntryAsync(a.w, note('after adoption', 'shared'));
    await a.c.syncNow();
    const after = a.w.prepare(`SELECT id, series, project_ulid FROM entries WHERE title = 'after adoption'`).get();
    assert.equal(inStore(s.office, 'after adoption'), true, `${JSON.stringify(after)}\n${s.logs.join('\n')}`);
    assert.equal(a.w.prepare(`SELECT COUNT(*) n FROM refused_changes`).get().n, 0, 'the office refused nothing');
    void late;
  } finally { await s.done(); }
});

test('autoAdoptE:false (an older laptop) never adopts by itself', async () => {
  const s = await setting();
  try {
    const a = await s.machine('a', { autoAdoptE: false });
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), false);
    assert.equal(a.c.status.state, 'connected');
  } finally { await s.done(); }
});

test('a laptop that is not in E adopts too, keeping every E note to itself', async () => {
  const s = await setting();
  try {
    const owner = await s.machine('owner');
    const b = await s.machine('b');
    setModuleShared(s.office.store, 'shared', true);
    await addEntryAsync(b.w, note('b shared', 'shared'));
    await b.c.syncNow();
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: owner.device });
    await b.c.syncNow();
    assert.equal(isEAdopted(b.w), true);
    const all = (b.w.prepare(`SELECT ulid FROM entries WHERE project_ulid IS NULL AND series = 'E'`).all() as Array<{ ulid: string }>).map((r) => r.ulid);
    assert.deepEqual([...neverSend(b.w)].sort(), all.sort());
    assert.equal(b.w.prepare(`SELECT COUNT(*) n FROM project_modules`).get().n, 0);
    const r = await requestJson(postOfficeTargetFromDb(b.w)!, 'GET', '/v1/e-held');
    assert.equal(r.status, 403, 'a non-member may not ask which E notes the office holds');
  } finally { await s.done(); }
});

test('the E backfill re-sends a locally numbered note the office already has: nothing is refused', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'shared', true);
    const a = await s.machine('a');
    addEntry(a.w, { ...note('legacy, numbered here', 'shared'), assigned: { ulid: newUlid(), id: 500 } } as any);
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'legacy, numbered here'), true, 'sent before adoption');
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), true);
    assert.ok(JSON.parse(getSyncValue(a.w, COURIER_KEYS.backfilledProjects) ?? '[]').includes(E_PROJECT_ULID));
    assert.equal(a.w.prepare(`SELECT COUNT(*) n FROM refused_changes`).get().n, 0, s.logs.join('\n'));
    assert.doesNotMatch(a.c.status.lastError ?? '', /refused/);
  } finally { await s.done(); }
});

test('adoption never re-points a shared module bound to a private project', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'shared', true);
    setModuleShared(s.office.store, 'mine', true);
    const a = await s.machine('a');
    initModule(a.w, { slug: 'mine' });
    createProject(a.w, { name: 'Private', code: 'PRV' });
    bindModule(a.w, 'mine', 'PRV');
    await a.c.syncNow();
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), true);
    const b = Object.fromEntries(listBindings(a.w).map((x) => [x.module, x.project_code]));
    assert.equal(b.mine, 'PRV', 'the private binding stays');
    assert.equal(b.shared, 'E');
  } finally { await s.done(); }
});

test('fix round 1: a module shared, sent, then unshared keeps its notes sendable; a note never sent stays private', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'was-shared', true);
    const a = await s.machine('a');
    await addEntryAsync(a.w, note('sent then unshared', 'was-shared'));
    await addEntryAsync(a.w, note('never sent', 'secret'));
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'sent then unshared'), true);
    setModuleShared(s.office.store, 'was-shared', false);
    await a.c.syncNow(); // the laptop's shared and backfilled lists forget was-shared
    assert.deepEqual(JSON.parse(getSyncValue(a.w, COURIER_KEYS.backfilled) ?? '[]'), []);
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    await a.c.syncNow();
    assert.equal(isEAdopted(a.w), true, s.logs.join('\n'));
    const ulidOf = (t: string) => (a.w.prepare(`SELECT ulid FROM entries WHERE title = ?`).get(t) as { ulid: string }).ulid;
    assert.deepEqual([...neverSend(a.w)], [ulidOf('never sent')], 'the office holds "sent then unshared", so it is not kept private');
    // Its later edits leave again.
    a.w.prepare(`UPDATE entries SET summary = 'edited after adoption' WHERE ulid = ?`).run(ulidOf('sent then unshared'));
    await a.c.pushNow();
    assert.equal((s.office.store.prepare(`SELECT summary FROM entries WHERE title = 'sent then unshared'`).get() as { summary: string }).summary, 'edited after adoption');
  } finally { await s.done(); }
});

test('fix round 1: GET /v1/e-held lists E notes only, never a note of another project', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'shared', true);
    const a = await s.machine('a');
    await createProjectOp(a.w, { name: 'Team One', code: 'TM', team: true });
    await addEntryAsync(a.w, note('e note', 'shared'));
    await addEntryAsync(a.w, { ...note('team note'), project: 'TM' });
    await a.c.syncNow();
    const ulidOf = (t: string) => (a.w.prepare(`SELECT ulid FROM entries WHERE title = ?`).get(t) as { ulid: string }).ulid;
    assert.equal(inStore(s.office, 'team note'), true);
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    const r = await requestJson(postOfficeTargetFromDb(a.w)!, 'GET', '/v1/e-held');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ulids, [ulidOf('e note')]);
  } finally { await s.done(); }
});

test('fix round 1: when the office cannot say what it holds, adoption waits (no guess)', async () => {
  const s = await setting();
  try {
    const a = await s.machine('a');
    adoptE(s.office.store, { name: 'emp1st', ownerDevice: a.device });
    // The office answers /v1/access, but this laptop's E membership is gone by the time it asks /v1/e-held.
    s.office.store.prepare(`DELETE FROM po_project_members WHERE project_ulid = ? AND device_id = ?`).run(E_PROJECT_ULID, a.device);
    a.w.prepare(`INSERT INTO sync_state (key, value) VALUES ('e_access', '{"adopted":true,"member":true}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const { adoptEFromOffice } = await import('@collab-mcp/core');
    await assert.rejects(adoptEFromOffice(a.w, {}), /did not say which E notes it holds \(403/);
    assert.equal(isEAdopted(a.w), false);
    assert.equal(getSyncValue(a.w, NEVER_SEND_KEY), null, 'nothing written');
  } finally { await s.done(); }
});
