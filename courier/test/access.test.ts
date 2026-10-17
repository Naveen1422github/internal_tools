// file: courier/test/access.test.ts
// RnR S1: the courier caches this laptop's access (R2), replays a project's
// history when added (R14), and marks a project it was removed from as left
// (R15). N creates the project; R is the teammate. One office.
import { test } from 'node:test';
import assert from 'node:assert';
import type { Database as DB } from 'better-sqlite3';
import {
  addEntryAsync, createProject, newUlid, getSyncValue, readAccessCache, requestJson, findProject, getEntryByUlid,
} from '@collab-mcp/core';
import { registerProject, setProjectMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until, type Office } from './world.js';
import { Courier } from '../src/engine.js';

async function world() {
  const t = tempDir('collab-access-');
  const office = await startOffice(t.dir, 0);
  const jn = await joinedDb(office, t.dir, 'n'), jr = await joinedDb(office, t.dir, 'r');
  const wn = openWriter(jn.path), wr = openWriter(jr.path);
  const cn = new Courier({ dbPath: jn.path, watch: false, retryMs: 60_000 });
  let cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000 });
  return {
    office, wn, wr, cn, n: jn.device, r: jr.device, rPath: jr.path,
    get cr() { return cr; },
    /** R's laptop restarts its courier (was offline). */
    async restartR() { await cr.stop(); cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000 }); return cr; },
    cleanup: async () => {
      await cn.stop(); await cr.stop();
      closeWriter(wn); closeWriter(wr);
      await office.close();
      t.cleanup();
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, ...extra });
/** A team project with only N in it (R7a): R is added only when a test says so. */
async function project(w: World, code = 'SH', name = 'Support hub') {
  const p = registerProject(w.office.store, { ulid: newUlid(), name, code, seed: 0 }, w.n);
  await w.cn.syncNow();
  return p;
}
async function write(w: World, code: string, ...titles: string[]) {
  const out = [];
  for (const t of titles) out.push((await addEntryAsync(w.wn, note(t, { project: code }))).ulid);
  await w.cn.pushNow();
  return out;
}
const titlesIn = (db: DB, code: string) =>
  (db.prepare(`SELECT title FROM entries WHERE series = ? AND deleted_at IS NULL ORDER BY id`).all(code) as Array<{ title: string }>).map((r) => r.title);
const replayRow = (o: Office, device: string, ulid: string) =>
  o.store.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(device, ulid);
const replayKey = (ulid: string) => `replay:${ulid}`;
/** N changes R's role over HTTP, so the office rings the `access` event. */
const putMember = (w: World, ulid: string, role: string) =>
  requestJson(w.cn.target, 'PUT' as 'POST', `/v1/projects/${ulid}/members/${w.r}`, { role });

test('added to a project later: receives its full history', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'one', 'two', 'three');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), [], 'not a member: nothing');
    assert.equal(findProject(w.wr, 'SH'), null, 'a project R is not in is hidden');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    assert.ok(replayRow(w.office, w.r, sh.ulid), 'the grant queued a replay');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two', 'three']);
    assert.equal(replayRow(w.office, w.r, sh.ulid), undefined, 'the confirming call ended the replay');
    assert.equal(getSyncValue(w.wr, replayKey(sh.ulid)), null, 'the replay bookmark is gone');
    assert.equal(readAccessCache(w.wr).get(sh.ulid)?.role, 'Reader');
  } finally { await w.cleanup(); }
});

test('role granted while R is offline: history arrives after reconnect', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'old one', 'old two');
    await w.cr.syncNow(); // R's bookmark passes the history while it is not a member
    assert.deepEqual(titlesIn(w.wr, 'SH'), []);
    await w.cr.stop(); // R goes offline
    assert.equal((await putMember(w, sh.ulid, 'Reader')).status, 200);
    // An edit to an OLD note after the grant: its delivery (seq > the replay's
    // upto_seq) carries one cell, not the note's project or series.
    const oldOne = (w.wn.prepare(`SELECT ulid FROM entries WHERE title = 'old one'`).get() as { ulid: string }).ulid;
    w.wn.prepare(`UPDATE entries SET title = 'old one, edited' WHERE ulid = ?`).run(oldOne);
    await write(w, 'SH', 'after the grant');
    // The note must never be held here as a project-less E note, even when the
    // replay stalls: numberPending would ask the office for an E number for it.
    const ghost = () => w.wr.prepare(`SELECT 1 FROM entries WHERE ulid = ? AND (project_ulid IS NULL OR series = 'E')`).get(oldOne);
    const allocatedFor = () => w.office.store.prepare(`SELECT 1 FROM po_allocations WHERE ulid = ?`).get(oldOne);
    const allocCalls = () => w.office.requests.filter((q) => q.route === 'POST /v1/allocate' && q.device === w.r).length;
    let cr = await w.restartR();
    w.office.hooks.accessStatus = (d) => (d === w.r ? 500 : null); // the replay can't run this time
    await cr.syncNow();
    assert.equal(ghost(), undefined, 'no ghost E note after a sync whose replay stalled');
    await cr.numberPendingNow();
    assert.equal(allocatedFor(), undefined, 'no E number was asked for the old note');
    assert.equal(allocCalls(), 0);
    w.office.hooks.accessStatus = undefined;
    cr = await w.restartR();
    await cr.syncNow();
    assert.equal(ghost(), undefined, 'right after the sync: the note is an SH note');
    cr.start();
    await until(() => titlesIn(w.wr, 'SH').length === 3, 8000, 'the history and the new note on R');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['old one, edited', 'old two', 'after the grant']);
    await cr.whenIdle();
    await until(() => replayRow(w.office, w.r, sh.ulid) === undefined, 5000, 'the replay to finish');
    assert.equal(getSyncValue(w.wr, replayKey(sh.ulid)), null);
    assert.equal(ghost(), undefined);
    assert.equal(allocatedFor(), undefined, 'numberPending never gave the old note an E number');
    assert.equal(allocCalls(), 0);
  } finally { await w.cleanup(); }
});

test('removed from a project: R keeps its notes, project marked left, nothing new arrives', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'one', 'two');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two']);
    assert.equal(findProject(w.wr, 'SH')!.left_at, null);
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, null);
    await w.cr.syncNow();
    assert.ok(findProject(w.wr, 'SH')!.left_at, 'marked left (read-only)');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two'], 'R keeps the notes');
    assert.equal(readAccessCache(w.wr).has(sh.ulid), false);
    await write(w, 'SH', 'while R is out');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two'], 'nothing new arrives');
  } finally { await w.cleanup(); }
});

test('added back after removal: writable again, and what was missed arrives', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'one');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Editor');
    await w.cr.syncNow();
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, null);
    await w.cr.syncNow();
    assert.ok(findProject(w.wr, 'SH')!.left_at);
    const missed = await write(w, 'SH', 'missed');
    await w.cr.syncNow();
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Editor');
    await w.cr.syncNow();
    assert.equal(findProject(w.wr, 'SH')!.left_at, null, 'writable again');
    assert.equal(getEntryByUlid(w.wr, missed[0])?.title, 'missed');
    const mine = await addEntryAsync(w.wr, note('R writes again', { project: 'SH' }));
    await w.cr.pushNow();
    await w.cn.syncNow();
    assert.equal(getEntryByUlid(w.wn, mine.ulid)?.title, 'R writes again', 'R sends again');
  } finally { await w.cleanup(); }
});

test('replay of a project whose code clashes locally holds, bookmark unchanged', async () => {
  const w = await world();
  try {
    createProject(w.wr, { name: 'Rs own', code: 'SH' });
    const solo = await addEntryAsync(w.wr, note('R solo', { project: 'SH' }));
    const sh = await project(w);
    const team = await write(w, 'SH', 'team one', 'team two');
    await w.cr.syncNow(); // not a member yet: no clash, the bookmark passes the history
    assert.equal(w.cr.status.state, 'connected');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    assert.equal(w.cr.status.state, 'needs-action');
    assert.match(w.cr.status.lastError ?? '', /SH/);
    for (const u of team) assert.equal(getEntryByUlid(w.wr, u), null, 'no team note applied');
    assert.equal(getEntryByUlid(w.wr, solo.ulid)?.title, 'R solo');
    assert.equal(getSyncValue(w.wr, replayKey(sh.ulid)), null, 'the replay bookmark did not move');
    assert.ok(replayRow(w.office, w.r, sh.ulid), 'the office still owes the replay');
    // R resolves it: its solo SH goes away.
    w.wr.prepare(`DELETE FROM entries WHERE series = 'SH'`).run();
    w.wr.prepare(`DELETE FROM projects WHERE code = 'SH'`).run();
    await w.cr.syncNow();
    assert.equal(w.cr.status.state, 'connected');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['team one', 'team two']);
    assert.equal(replayRow(w.office, w.r, sh.ulid), undefined);
  } finally { await w.cleanup(); }
});

test('access_cache mirrors the office after an access event', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'one');
    w.cr.start();
    await until(() => w.cr.status.state === 'connected', 5000, 'R connected');
    await w.cr.whenIdle();
    assert.equal(readAccessCache(w.wr).has(sh.ulid), false);
    assert.equal((await putMember(w, sh.ulid, 'Reader')).status, 200);
    await until(() => readAccessCache(w.wr).get(sh.ulid)?.role === 'Reader', 5000, 'the Reader role in the cache');
    await until(() => titlesIn(w.wr, 'SH').length === 1, 5000, 'the history on R');
    assert.equal((await putMember(w, sh.ulid, 'Editor')).status, 200);
    await until(() => readAccessCache(w.wr).get(sh.ulid)?.role === 'Editor', 5000, 'the Editor role in the cache');
    await w.cr.whenIdle();
    const office = (await requestJson(w.cr.target, 'GET', '/v1/access')).body;
    const cache = readAccessCache(w.wr);
    assert.deepEqual([...cache.get(sh.ulid)!.keys].sort(), [...office.projects[0].keys].sort());
    assert.deepEqual([...cache.get('office')!.keys].sort(), [...office.office.keys].sort());
    assert.equal(cache.get('office')!.role, office.office.role);
  } finally { await w.cleanup(); }
});

// ---- the office's membership decides (fix round 1) ----

test('removed before this laptop ever cached its access: still marked left', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    await write(w, 'SH', 'one');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one']);
    w.wr.prepare(`DELETE FROM access_cache`).run(); // as if this laptop never filled it (just upgraded)
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, null);
    await w.cr.syncNow();
    assert.ok(findProject(w.wr, 'SH')!.left_at, 'not a member at the office: read-only');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one']);
  } finally { await w.cleanup(); }
});

test('an older office (404 on /v1/access): nothing marked left, the sync still completes', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    const cached = readAccessCache(w.wr).get(sh.ulid)?.role;
    w.office.hooks.accessStatus = (d) => (d === w.r ? 404 : null);
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, null);
    await w.cr.syncNow();
    assert.equal(findProject(w.wr, 'SH')!.left_at, null, 'no roles known: nothing is marked left');
    assert.equal(w.cr.status.state, 'connected');
    assert.equal(w.cr.status.lastError, null);
    assert.equal(readAccessCache(w.wr).get(sh.ulid)?.role, cached, 'the cache is left as it was');
  } finally { await w.cleanup(); }
});

test('a broken office (500 on /v1/access): the cache is unchanged and nothing is marked left', async () => {
  const w = await world();
  try {
    const sh = await project(w);
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    const before = w.wr.prepare(`SELECT * FROM access_cache ORDER BY scope_key`).all();
    assert.ok(before.length >= 2);
    w.office.hooks.accessStatus = (d) => (d === w.r ? 500 : null);
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, null);
    await w.cr.syncNow();
    assert.deepEqual(w.wr.prepare(`SELECT * FROM access_cache ORDER BY scope_key`).all(), before);
    assert.equal(findProject(w.wr, 'SH')!.left_at, null);
    assert.equal(w.cr.status.state, 'offline', 'a failed step retries later');
    assert.match(w.cr.status.lastError ?? '', /did not say what this laptop may do \(500\)/);
  } finally { await w.cleanup(); }
});

test('a team project created here while /v1/access is answering is not marked left', async () => {
  const w = await world();
  try {
    await w.cr.syncNow();
    const ulid = newUlid();
    // Another program on R's laptop finishes creating a team project while the
    // office is computing R's access (so the answer does not list it yet).
    w.office.hooks.accessStatus = (d) => {
      if (d === w.r && !findProject(w.wr, 'NW')) {
        w.wr.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, 'New one', 'NW', 'team', ?)`).run(ulid, w.office.fingerprint);
      }
      return null;
    };
    await w.cr.syncNow();
    assert.equal(findProject(w.wr, 'NW')!.left_at, null);
  } finally { await w.cleanup(); }
});
