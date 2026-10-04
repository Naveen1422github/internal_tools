// file: courier/test/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, getSyncValue, updateEntry, COURIER_PORT_KEY } from '@collab-mcp/core';
import { setModuleShared } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, until, type Office } from './world.js';
import { Courier } from '../src/engine.js';
import { COURIER_KEYS } from '../src/keys.js';

async function setting(seed = 0) {
  const t = tempDir();
  const office = await startOffice(t.dir, seed);
  const opened: Array<{ close(): void }> = [];
  const couriers: Courier[] = [];
  const machine = async (name: string) => {
    const j = await joinedDb(office, t.dir, name);
    const w = openWriter(j.path);
    opened.push({ close: () => closeWriter(w) });
    const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
    couriers.push(c);
    return { ...j, w, c };
  };
  return {
    office, machine,
    done: async () => { for (const c of couriers) await c.stop(); for (const o of opened) o.close(); await office.close(); t.cleanup(); },
  };
}
const inStore = (o: Office, title: string) => !!o.store.prepare('SELECT 1 FROM entries WHERE title = ?').get(title);
const lastSeq = (o: Office) => (o.store.prepare('SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries').get() as { s: number }).s;
const fullRow = (o: Office, title: string) => o.store.prepare('SELECT title, summary, type, module FROM entries WHERE title = ?').get(title) as any;

test('push sends only notes whose primary module is shared; numbers are still asked for all', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    const shared = await addEntryAsync(a.w, { type: 'decision', title: 'team note', summary: 's', module: 'team' });
    await addEntryAsync(a.w, { type: 'decision', title: 'private note', summary: 's', module: 'private' });
    await addEntryAsync(a.w, { type: 'decision', title: 'loose note', summary: 's' });
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'team note'), true);
    assert.equal(inStore(s.office, 'private note'), false);
    assert.equal(inStore(s.office, 'loose note'), false);
    assert.equal((s.office.store.prepare('SELECT COUNT(*) c FROM po_allocations').get() as { c: number }).c, 3, 'only ULIDs were sent for the private ones');
    assert.ok(shared.id >= 1);
    const seq = lastSeq(s.office);
    await a.c.pushNow();
    assert.equal(lastSeq(s.office), seq, 'nothing new to send');
    assert.equal(Number(getSyncValue(a.w, COURIER_KEYS.sent)), (a.w.prepare('SELECT crsql_db_version() v').get() as { v: number }).v);
  } finally { await s.done(); }
});

test('a module shared later is backfilled; a note moved into a shared module is sent whole', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    await addEntryAsync(a.w, { type: 'decision', title: 'later note', summary: 'from before sharing', module: 'later' });
    const moved = await addEntryAsync(a.w, { type: 'gotcha', title: 'moved note', summary: 'was private', module: 'private' });
    await a.c.syncNow();
    assert.equal(inStore(s.office, 'later note'), false);
    setModuleShared(s.office.store, 'later', true);
    await a.c.syncNow();
    assert.deepEqual(fullRow(s.office, 'later note'), { title: 'later note', summary: 'from before sharing', type: 'decision', module: 'later' });
    a.w.prepare(`UPDATE entries SET module = 'team' WHERE id = ?`).run(moved.id);
    await a.c.pushNow();
    assert.deepEqual(fullRow(s.office, 'moved note'), { title: 'moved note', summary: 'was private', type: 'gotcha', module: 'team' });
  } finally { await s.done(); }
});

test('pull applies, re-indexes search, moves the bookmark; received rows are never sent back', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a'), b = await s.machine('b');
    const { id } = await addEntryAsync(a.w, { type: 'decision', title: 'okapi sighting', summary: 's', module: 'team' });
    await a.c.syncNow();
    await b.c.syncNow();
    assert.equal((b.w.prepare(`SELECT COUNT(*) c FROM entries_fts WHERE entries_fts MATCH 'okapi'`).get() as { c: number }).c, 1);
    assert.equal(Number(getSyncValue(b.w, COURIER_KEYS.recv)), lastSeq(s.office));
    const seq = lastSeq(s.office);
    await b.c.pushNow();
    assert.equal(lastSeq(s.office), seq, 'no echo');
    updateEntry(b.w, { id, description: 'edited on b' });
    await b.c.pushNow();
    await a.c.pullNow();
    assert.equal((a.w.prepare('SELECT description d FROM entries WHERE id = ?').get(id) as { d: string }).d, 'edited on b');
  } finally { await s.done(); }
});

test('the sent-bookmark moves only after the post office acknowledged', async () => {
  const s = await setting();
  try {
    setModuleShared(s.office.store, 'team', true);
    const a = await s.machine('a');
    await a.c.syncNow();
    let drop = true;
    s.office.hooks.dropChangesAnswer = () => { const d = drop; drop = false; return d; };
    await addEntryAsync(a.w, { type: 'decision', title: 'unacknowledged', summary: 's', module: 'team' });
    const before = Number(getSyncValue(a.w, COURIER_KEYS.sent) ?? 0);
    await a.c.pushNow();
    assert.equal(a.c.status.state, 'offline');
    assert.equal(Number(getSyncValue(a.w, COURIER_KEYS.sent) ?? 0), before, 'not acknowledged => not advanced');
    assert.equal(a.c.pendingTimers(), 1, 'a retry is scheduled');
    const stored = lastSeq(s.office);
    await a.c.pushNow();
    assert.equal(lastSeq(s.office), stored, 'the resend was all duplicates');
    assert.ok(Number(getSyncValue(a.w, COURIER_KEYS.sent)) > before);
    assert.equal((s.office.store.prepare(`SELECT COUNT(*) c FROM entries WHERE title = 'unacknowledged'`).get() as { c: number }).c, 1);
  } finally { s.office.hooks.dropChangesAnswer = undefined; await s.done(); }
});

test('a DB that is not set up is refused with a clear message', () => {
  const t = tempDir();
  try {
    const db = openWriter(`${t.dir}/plain.db`);
    db.exec('CREATE TABLE x (a)');
    closeWriter(db);
    assert.throws(() => new Courier({ dbPath: `${t.dir}/plain.db`, watch: false }), /collab sync setup/);
  } finally { t.cleanup(); }
});

test('the courier publishes its ping port, a save pings it, the save is pushed; stop removes the port', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const j = await joinedDb(office, t.dir, 'a');
  const c = new Courier({ dbPath: j.path, retryMs: 60_000, maxReconnectMs: 200 });
  const w = openWriter(j.path);
  try {
    c.start();
    await until(() => c.status.state === 'connected' && c.pingPort !== null, 3000, 'connected + listening');
    assert.strictEqual(getSyncValue(w, COURIER_PORT_KEY), String(c.pingPort));
    const before = c.status.sentTotal;
    await addEntryAsync(w, { type: 'decision', title: 'pinged', summary: 's', module: 'team' });
    await until(() => c.status.sentTotal > before, 2000, 'the ping-triggered push');
  } finally {
    await c.stop();
    assert.strictEqual(getSyncValue(w, COURIER_PORT_KEY), null, 'stop removes the port');
    closeWriter(w); await office.close(); t.cleanup();
  }
});

test('applying pulled changes does not make the courier ping itself (no push request after a pull)', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'team', true);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const ca = new Courier({ dbPath: ja.path, retryMs: 60_000, maxReconnectMs: 200 });
  const cb = new Courier({ dbPath: jb.path, retryMs: 60_000, maxReconnectMs: 200 });
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  try {
    ca.start(); cb.start();
    await until(() => ca.status.state === 'connected' && cb.status.state === 'connected', 3000);
    const { id } = await addEntryAsync(wa, { type: 'decision', title: 'echo-check', summary: 's', module: 'team' });
    await until(() => wb.prepare('SELECT 1 FROM entries WHERE id = ?').get(id) !== undefined, 3000, 'B received');
    await new Promise((r) => setTimeout(r, 500));
    const bPushes = office.requests.filter((r) => r.device === jb.device && r.route.startsWith('POST /v1/changes')).length;
    assert.strictEqual(bPushes, 0, 'B pushed after only receiving');
  } finally { await ca.stop(); await cb.stop(); closeWriter(wa); closeWriter(wb); await office.close(); t.cleanup(); }
});

test('a schema mismatch puts the courier in needs-update and it does not hammer the office', async () => {
  const t = tempDir();
  const office = await startOffice(t.dir, 0);
  const j = await joinedDb(office, t.dir, 'a');
  const w = openWriter(j.path);
  // This laptop claims a newer migration than the office has.
  w.prepare(`INSERT INTO schema_migrations (version) VALUES ('9999_from_the_future')`).run();
  const c = new Courier({ dbPath: j.path, watch: false, retryMs: 60_000 });
  try {
    await c.syncNow().catch(() => {});
    assert.equal(c.status.state, 'needs-update');
    assert.match(c.status.lastError ?? '', /update this laptop: the post office is on \S+, this notes DB is on 9999_from_the_future/);
    const before = c.status.lastError;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.status.state, 'needs-update', 'still paused, no retry storm inside the 60 s interval');
    assert.equal(c.status.lastError, before);
  } finally { await c.stop(); closeWriter(w); await office.close(); t.cleanup(); }
});
