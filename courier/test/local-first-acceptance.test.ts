// file: courier/test/local-first-acceptance.test.ts
// Local-first Task 9, the release gate: one office, laptops `owner`, `member`
// (E Editor), `outsider` (TT Editor only) and `oldie` (an E Editor on old code:
// autoAdoptE false, controller ruling 3). Before adoption a module is shared the
// legacy way and E notes reach the office; then the office adopts E (owner as
// Owner) and the laptops adopt by themselves. Each scenario builds its own world.
import { test } from 'node:test';
import assert from 'node:assert';
import type { Database as DB } from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, newUlid, initModule, bindModule, rollup, isEAdopted, neverSend, getSyncValue,
  unsentSharedCount, requestJson, postOfficeTargetFromDb, setAllocator, setAllocationRetry,
  E_PROJECT_ULID, DEFAULT_PROJECT_KEY,
} from '@collab-mcp/core';
import { setModuleShared, adoptE, registerProject, setProjectMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until, type Office } from './world.js';
import { Courier, type CourierOptions } from '../src/engine.js';

const SHARED = 'custom-reports';
const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, ...extra });
const row = (db: DB | Office['store'], title: string) =>
  (db as DB).prepare(`SELECT ulid, id, series, project_ulid, type, rollup_of_task, description FROM entries WHERE title = ?`).get(title) as
    { ulid: string; id: number | null; series: string; project_ulid: string | null; type: string; rollup_of_task: string | null; description: string | null } | undefined;
const has = (db: DB | Office['store'], title: string) => row(db, title) !== undefined;
const refused = (db: DB) => (db.prepare(`SELECT COUNT(*) n FROM refused_changes`).get() as { n: number }).n;

interface Laptop { name: string; path: string; device: string; w: DB; c: Courier }

/** The adopted world. `live`: couriers listen (save pings + doorbell) and are started after setup. */
async function world(o: { live?: boolean } = {}) {
  const t = tempDir('collab-lf-gate-');
  const office = await startOffice(t.dir, 0);
  const logs: string[] = [];
  const laptops: Laptop[] = [];
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  const done = async () => {
    setAllocator(null); setAllocationRetry(null);
    for (const l of laptops) await l.c.stop();
    for (const l of laptops) closeWriter(l.w);
    await office.close();
    t.cleanup();
  };
  try {
    setModuleShared(office.store, SHARED, true);
    const laptop = async (name: string, opts: Partial<CourierOptions> = {}): Promise<Laptop> => {
      const j = await joinedDb(office, t.dir, name);
      const w = openWriter(j.path);
      const live = o.live ? { retryMs: 300, maxReconnectMs: 200 } : { watch: false, retryMs: 60_000 };
      const c = new Courier({ dbPath: j.path, ...live, log: (l) => logs.push(`${name}: ${l}`), ...opts });
      const l = { name, ...j, w, c };
      laptops.push(l);
      return l;
    };
    // The earliest member is the office admin.
    const owner = await laptop('owner');
    const member = await laptop('member');
    const outsider = await laptop('outsider');
    const oldie = await laptop('oldie', { autoAdoptE: false });
    const tt = registerProject(office.store, { ulid: newUlid(), name: 'Tools', code: 'TT', seed: 0 }, owner.device);
    setProjectMember(office.store, null, tt.ulid, outsider.device, 'Editor');
    const syncAll = async () => { for (const l of laptops) await l.c.syncNow(); };

    // Before adoption: the legacy way. A shared module's E notes go to everyone.
    await addEntryAsync(owner.w, note('legacy shared 1', { module: SHARED }));
    await addEntryAsync(owner.w, note('legacy shared 2', { module: SHARED }));
    await addEntryAsync(member.w, note('member secret before adoption', { module: 'secret' })); // module not shared: stays here
    await syncAll();
    await syncAll();
    assert.equal(has(office.store, 'legacy shared 1'), true, 'the office holds the legacy E notes');
    assert.equal(has(outsider.w, 'legacy shared 2'), true, 'before adoption the legacy path reaches everyone');
    assert.equal(has(office.store, 'member secret before adoption'), false);

    // The office adopts E; member and oldie are E Editors before any laptop asks again.
    adoptE(office.store, { name: 'emp1st', ownerDevice: owner.device });
    setProjectMember(office.store, null, E_PROJECT_ULID, member.device, 'Editor');
    setProjectMember(office.store, null, E_PROJECT_ULID, oldie.device, 'Editor');
    await syncAll();
    await syncAll();
    for (const l of [owner, member, outsider]) assert.equal(isEAdopted(l.w), true, `${l.name} adopted E\n${logs.join('\n')}`);
    assert.equal(isEAdopted(oldie.w), false, 'the old-code laptop never adopts');
    for (const l of laptops) assert.equal(refused(l.w), 0, `${l.name}: nothing refused in setup\n${logs.join('\n')}`);
    if (o.live) {
      for (const l of laptops) l.c.start();
      await until(() => laptops.every((l) => l.c.status.state === 'connected'), 5000, 'every doorbell');
    }
    return { office, owner, member, outsider, oldie, laptops, logs, syncAll, done };
  } catch (e) { await done(); throw e; }
}

test('E note in a bound module reaches the member, not the outsider', async () => {
  const s = await world();
  try {
    const n = await addEntryAsync(s.owner.w, note('after adoption, bound', { module: SHARED }));
    assert.notEqual(n.id, null, 'numbered by the office');
    assert.equal(row(s.owner.w, 'after adoption, bound')?.project_ulid, null, 'an E note keeps project_ulid NULL');
    assert.equal(row(s.owner.w, 'after adoption, bound')?.series, 'E');
    await s.syncAll(); await s.syncAll();
    assert.equal(has(s.office.store, 'after adoption, bound'), true);
    assert.equal(row(s.member.w, 'after adoption, bound')?.id, n.id, 'the member has it, same number');
    assert.equal(has(s.outsider.w, 'after adoption, bound'), false, 'the outsider never gets it');
    assert.equal(refused(s.owner.w) + refused(s.member.w), 0);
  } finally { await s.done(); }
});

test('note in an unbound new module stays local and is not pending', async () => {
  const s = await world();
  try {
    const def = getSyncValue(s.member.w, DEFAULT_PROJECT_KEY);
    assert.ok(def, 'adoption set a default project');
    const n = await addEntryAsync(s.member.w, note('brand new module note', { module: 'brand-new' }));
    const r = row(s.member.w, 'brand new module note')!;
    assert.notEqual(n.id, null, 'numbered here, not pending');
    assert.equal(r.series, def, 'in the default private project');
    assert.notEqual(r.project_ulid, null);
    await s.syncAll();
    assert.equal(has(s.office.store, 'brand new module note'), false, 'never sent');
    assert.equal(has(s.owner.w, 'brand new module note'), false);
    assert.equal(unsentSharedCount(s.member.w), 0, 'nothing waiting to be sent');
    assert.equal((s.member.w.prepare(`SELECT COUNT(*) n FROM entries WHERE id IS NULL`).get() as { n: number }).n, 0, 'nothing pending');
  } finally { await s.done(); }
});

test('never-send E note never reaches the office, even after a rebind', async () => {
  const s = await world();
  try {
    const kept = row(s.member.w, 'member secret before adoption')!;
    assert.ok(neverSend(s.member.w).has(kept.ulid), 'adoption kept it on this laptop');
    for (const db of [s.office.store, s.outsider.w]) {
      assert.equal(db.prepare(`SELECT 1 FROM modules WHERE slug = 'secret'`).get(), undefined, 'the private note did not carry its module row');
    }
    initModule(s.member.w, { slug: 'secret' });
    bindModule(s.member.w, 'secret', 'E');
    updateEntry(s.member.w, { ulid: kept.ulid, description: 'edited after the rebind' });
    // Control: a new note in the rebound module does go, so the rebind is live.
    await addEntryAsync(s.member.w, note('new in secret after rebind', { module: 'secret' }));
    await s.member.c.syncNow(); await s.member.c.syncNow();
    assert.equal(has(s.office.store, 'new in secret after rebind'), true, `the rebind is live\n${s.logs.join('\n')}`);
    assert.equal(has(s.office.store, 'member secret before adoption'), false, 'the never-send note never left');
    assert.equal(s.office.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(kept.ulid), undefined);
    for (const db of [s.office.store, s.outsider.w]) {
      assert.equal(db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ?`).get(kept.ulid), undefined, 'private refs never leave');
      assert.equal(db.prepare(`SELECT 1 FROM entry_modules WHERE entry_ulid = ?`).get(kept.ulid), undefined, 'private module links never leave');
      assert.equal(db.prepare(`SELECT 1 FROM entry_revisions WHERE entry_ulid = ?`).get(kept.ulid), undefined, 'private revisions never leave');
    }
    assert.equal(unsentSharedCount(s.member.w), 0, 'and is not counted as waiting');
    await s.owner.c.syncNow();
    assert.equal(has(s.owner.w, 'member secret before adoption'), false);
    assert.equal(refused(s.member.w), 0, `nothing refused: ${JSON.stringify(s.member.w.prepare(`SELECT key, reason FROM refused_changes`).all())}`);
  } finally { await s.done(); }
});

test('outsider added to E later gets the full E history by replay', async () => {
  const s = await world();
  try {
    await addEntryAsync(s.owner.w, note('E history 1', { module: SHARED }));
    await addEntryAsync(s.owner.w, note('E history 2', { project: 'E' }));
    await s.owner.c.syncNow();
    await s.outsider.c.syncNow();
    assert.equal(has(s.outsider.w, 'E history 1'), false, 'not yet a member');
    setProjectMember(s.office.store, null, E_PROJECT_ULID, s.outsider.device, 'Reader');
    await s.outsider.c.syncNow(); await s.outsider.c.syncNow();
    for (const t of ['E history 1', 'E history 2']) {
      assert.equal(has(s.outsider.w, t), true, `replayed: ${t}\n${s.logs.join('\n')}`);
    }
    assert.equal(row(s.outsider.w, 'E history 2')?.id, row(s.owner.w, 'E history 2')?.id, 'same number');
    assert.equal((s.outsider.w.prepare(`SELECT COUNT(*) n FROM entries WHERE id IS NULL`).get() as { n: number }).n, 0, 'no ghost rows');
    assert.equal(refused(s.outsider.w), 0);
  } finally { await s.done(); }
});

test('rollup of private notes never reaches an E member', async () => {
  const s = await world();
  try {
    const ps = getSyncValue(s.member.w, DEFAULT_PROJECT_KEY)!;
    s.member.w.prepare(`INSERT INTO tasks (id, title) VALUES ('T-private-rollup', 'private')`).run();
    await addEntryAsync(s.member.w, note('private rollup source 1', { project: ps, task_id: 'T-private-rollup' }));
    await addEntryAsync(s.member.w, note('private rollup source 2', { project: ps, task_id: 'T-private-rollup' }));
    const out = rollup(s.member.w, { task_id: 'T-private-rollup' });
    assert.equal(out.created_entries.length, 1);
    await s.member.c.syncNow(); await s.owner.c.syncNow();
    assert.equal(has(s.office.store, 'Rollup: task=T-private-rollup (2 entries)'), false);
    assert.equal(has(s.owner.w, 'Rollup: task=T-private-rollup (2 entries)'), false);
  } finally { await s.done(); }
});

test("admin's new E module is not delivered to the outsider", async () => {
  const s = await world();
  try {
    initModule(s.owner.w, { slug: 'admin-e-only', name: 'Admin E only' });
    bindModule(s.owner.w, 'admin-e-only', 'E');
    await addEntryAsync(s.owner.w, note('admin module carrier', { module: 'admin-e-only' }));
    await s.owner.c.syncNow(); await s.outsider.c.syncNow();
    assert.equal(s.outsider.w.prepare(`SELECT 1 FROM modules WHERE slug = 'admin-e-only'`).get(), undefined);
  } finally { await s.done(); }
});

test('member removed from E stops receiving and keeps what it had', async () => {
  const s = await world();
  try {
    await addEntryAsync(s.owner.w, note('before removal', { module: SHARED }));
    await s.owner.c.syncNow(); await s.member.c.syncNow();
    assert.equal(has(s.member.w, 'before removal'), true);
    setProjectMember(s.office.store, null, E_PROJECT_ULID, s.member.device, null);
    await addEntryAsync(s.owner.w, note('after removal', { module: SHARED }));
    await s.owner.c.syncNow();
    await s.member.c.syncNow(); await s.member.c.syncNow();
    assert.equal(has(s.office.store, 'after removal'), true);
    assert.equal(has(s.member.w, 'after removal'), false, 'stops receiving');
    for (const t of ['legacy shared 1', 'legacy shared 2', 'before removal']) assert.equal(has(s.member.w, t), true, `keeps ${t}`);
    assert.notEqual(s.member.c.status.state, 'revoked');
    assert.notEqual(s.member.c.status.state, 'error');
  } finally { await s.done(); }
});

test('private-project note is numbered while the office is down', async () => {
  const s = await world();
  try {
    const def = getSyncValue(s.owner.w, DEFAULT_PROJECT_KEY);
    await s.office.down();
    const n = await addEntryAsync(s.owner.w, note('written offline, no project'));
    assert.notEqual(n.id, null, 'numbered with the office down');
    assert.equal(row(s.owner.w, 'written offline, no project')?.series, def);
    await s.office.up();
    await s.owner.c.syncNow();
    assert.equal(has(s.office.store, 'written offline, no project'), false, 'a private note never leaves');
    assert.equal(unsentSharedCount(s.owner.w), 0);
  } finally { await s.done(); }
});

test('old-code laptop keeps syncing formerly shared modules without a 409', async () => {
  const s = await world();
  try {
    assert.equal(isEAdopted(s.oldie.w), false);
    const n = await addEntryAsync(s.oldie.w, note('from the old laptop', { module: SHARED }));
    assert.notEqual(n.id, null, 'numbered by the office');
    assert.equal(row(s.oldie.w, 'from the old laptop')?.series, 'E');
    await s.oldie.c.syncNow();
    await s.member.c.syncNow(); await s.owner.c.syncNow();
    assert.equal(has(s.office.store, 'from the old laptop'), true);
    assert.equal(row(s.member.w, 'from the old laptop')?.id, n.id, 'reaches an E member');
    await s.outsider.c.syncNow(); await s.outsider.c.syncNow(); // it could arrive: the office stamps it E, so it must not
    assert.equal(s.outsider.c.status.state, 'connected', s.outsider.c.status.lastError ?? '');
    assert.equal(has(s.outsider.w, 'from the old laptop'), false, 'not the outsider (not in E)');
    // And it still receives E notes written on adopted laptops.
    await addEntryAsync(s.owner.w, note('to the old laptop', { module: SHARED }));
    await s.owner.c.syncNow(); await s.oldie.c.syncNow();
    assert.equal(has(s.oldie.w, 'to the old laptop'), true);
    assert.equal(refused(s.oldie.w), 0);
    assert.equal(s.oldie.c.status.state, 'connected');
    assert.doesNotMatch(s.oldie.c.status.lastError ?? '', /409|410/);
    assert.equal(s.logs.filter((l) => l.startsWith('oldie:') && /409|410/.test(l)).length, 0, s.logs.join('\n'));
  } finally { await s.done(); }
});

test('rollup note crosses both ways', async () => {
  const s = await world();
  try {
    for (const t of ['task part 1', 'task part 2']) await addEntryAsync(s.owner.w, note(t, { project: 'E', task_id: 'T-261' }));
    const r = rollup(s.owner.w, { task_id: 'T-261' });
    assert.equal(r.created_entries.length, 1);
    const ownerRow = s.owner.w.prepare(`SELECT ulid, series, project_ulid FROM entries WHERE type = 'rollup'`).get() as { ulid: string; series: string; project_ulid: string | null };
    assert.deepEqual({ ...ownerRow, ulid: undefined }, { ulid: undefined, series: 'E', project_ulid: null }, 'the E-261 shape');
    await s.owner.c.syncNow(); await s.member.c.syncNow();
    const onMember = s.member.w.prepare(`SELECT id, type, rollup_of_task FROM entries WHERE ulid = ?`).get(ownerRow.ulid) as { id: number | null; type: string; rollup_of_task: string | null } | undefined;
    assert.ok(onMember, `the rollup reached the member\n${s.logs.join('\n')}`);
    assert.equal(onMember.type, 'rollup');
    assert.equal(onMember.rollup_of_task, 'T-261');
    assert.notEqual(onMember.id, null);
    await s.outsider.c.syncNow();
    assert.equal(s.outsider.w.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(ownerRow.ulid), undefined, 'not the outsider');
    updateEntry(s.member.w, { ulid: ownerRow.ulid, description: 'rollup, edited by the member' });
    await s.member.c.syncNow(); await s.owner.c.syncNow();
    const back = s.owner.w.prepare(`SELECT description, type, rollup_of_task FROM entries WHERE ulid = ?`).get(ownerRow.ulid) as { description: string; type: string; rollup_of_task: string };
    assert.equal(back.description, 'rollup, edited by the member', 'the edit came back');
    assert.equal(back.type, 'rollup');
    assert.equal(refused(s.owner.w) + refused(s.member.w), 0);
  } finally { await s.done(); }
});

test('a binding or membership change reaches connected laptops without a restart', async () => {
  const s = await world({ live: true });
  try {
    // Membership: the owner adds the outsider to E through the office's route (which rings the doorbell).
    await addEntryAsync(s.owner.w, note('E before the outsider joined', { module: SHARED }));
    await until(() => has(s.member.w, 'E before the outsider joined'), 5000, 'the member to receive it live');
    assert.equal(has(s.outsider.w, 'E before the outsider joined'), false);
    const put = await requestJson(postOfficeTargetFromDb(s.owner.w)!, 'PUT', `/v1/projects/${E_PROJECT_ULID}/members/${s.outsider.device}`, { role: 'Reader' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await until(() => has(s.outsider.w, 'E before the outsider joined'), 5000, `the outsider's replay without a restart\n${s.logs.join('\n')}`);
    // Binding: the member binds a new module to E on its connected laptop; its next note there reaches the owner.
    initModule(s.member.w, { slug: 'fresh' });
    bindModule(s.member.w, 'fresh', 'E');
    await addEntryAsync(s.member.w, note('after a live bind', { module: 'fresh' }));
    await until(() => has(s.owner.w, 'after a live bind'), 5000, `the bound note to reach the owner\n${s.logs.join('\n')}`);
    assert.equal(row(s.member.w, 'after a live bind')?.series, 'E');
    // The member records any refusal when its push is acknowledged: wait for that before counting.
    const top = (s.member.w.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
    await until(() => Number(getSyncValue(s.member.w, 'sent_db_version') ?? 0) >= top && !getSyncValue(s.member.w, 'push_inflight'), 5000, 'the member push acknowledged');
    for (const l of s.laptops) assert.equal(refused(l.w), 0, `${l.name}: ${JSON.stringify(l.w.prepare(`SELECT * FROM refused_changes`).all())}\n${s.logs.join('\n')}`);
  } finally { await s.done(); }
});
