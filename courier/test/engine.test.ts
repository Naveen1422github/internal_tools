// file: courier/test/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addEntryAsync, getSyncValue, updateEntry } from '@collab-mcp/core';
import { setModuleShared } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, type Office } from './world.js';
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
