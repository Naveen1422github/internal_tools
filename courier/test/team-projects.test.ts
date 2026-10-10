// file: courier/test/team-projects.test.ts
// Stage C: the courier numbers pending notes, learns the office's team
// projects, and sends team notes whole. Two laptops (A, B) and one office.
import { test } from 'node:test';
import assert from 'node:assert';
import type { Database as DB } from 'better-sqlite3';
import {
  addEntry, addEntryAsync, createProject, updateEntry, getEntryByUlid, ownerOfRef, newUlid, getSyncValue,
  setAllocator, setAllocationRetry, type Allocator,
} from '@collab-mcp/core';
import { setModuleShared, registerProject, allocate } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, type Office } from './world.js';
import { Courier } from '../src/engine.js';
import { COURIER_KEYS as K } from '../src/keys.js';

async function world() {
  const t = tempDir('collab-team-');
  const office = await startOffice(t.dir, 0);
  setModuleShared(office.store, 'portfolio', true);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  const ca = new Courier({ dbPath: ja.path, watch: false, retryMs: 60_000 });
  const cb = new Courier({ dbPath: jb.path, watch: false, retryMs: 60_000 });
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  return {
    office, wa, wb, ca, cb,
    cleanup: async () => {
      setAllocator(null);
      setAllocationRetry(null);
      await ca.stop(); await cb.stop();
      closeWriter(wa); closeWriter(wb);
      await office.close();
      t.cleanup();
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, description: `${title} body`, ...extra });
function team(office: Office, code = 'SH', name = 'Support hub', seed = 0) {
  return registerProject(office.store, { ulid: newUlid(), name, code, seed });
}
const atOffice = (o: Office, ulid: string) =>
  o.store.prepare(`SELECT id, series, title, summary, description FROM entries WHERE ulid = ?`).get(ulid) as any;
const deliveriesOf = (o: Office, ulid: string) =>
  (o.store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE instr(pk, CAST(? AS BLOB)) > 0`).get(ulid) as { n: number }).n;
const deliveries = (o: Office) => (o.store.prepare(`SELECT COUNT(*) n FROM po_deliveries`).get() as { n: number }).n;
const ownTop = (db: DB) =>
  (db.prepare(`SELECT COALESCE(MAX(db_version), 0) v FROM crsql_changes WHERE site_id = crsql_site_id()`).get() as { v: number }).v;
const sent = (db: DB) => Number(getSyncValue(db, K.sent) ?? 0);
const down: Allocator = { allocate: async () => { throw new Error('connect ECONNREFUSED'); } };

test('learns the office team projects; a team note round-trips whole', async () => {
  const w = await world();
  try {
    const sh = team(w.office);
    await w.cb.syncNow();
    const p = w.wb.prepare(`SELECT ulid, code, mode, team FROM projects WHERE code = 'SH'`).get() as any;
    assert.deepEqual(p, { ulid: sh.ulid, code: 'SH', mode: 'team', team: w.office.fingerprint });
    await w.ca.syncNow();
    const r = await addEntryAsync(w.wa, note('First team note', { project: 'SH', module: 'portfolio', refs: [{ ref_type: 'file', ref_value: 'a.ts' }] }));
    assert.equal(`${r.series}-${r.id}`, 'SH-1');
    await w.ca.pushNow();
    await w.cb.syncNow();
    const got = getEntryByUlid(w.wb, r.ulid)!;
    assert.equal(got.id, 1);
    assert.equal(got.title, 'First team note');
    assert.equal(got.summary, 'First team note summary');
    assert.equal(got.description, 'First team note body');
    assert.deepEqual(got.refs.map((x) => x.ref_value), ['a.ts']);
  } finally { await w.cleanup(); }
});

test('Review Focus 1: pending, skipped by a push, then numbered: the office gets the WHOLE note', async () => {
  const w = await world();
  try {
    team(w.office);
    await w.ca.syncNow();
    await addEntryAsync(w.wa, note('numbered first', { project: 'SH' }));
    await w.office.down();
    const tNote = await addEntryAsync(w.wa, note('Written offline', { project: 'SH', module: 'portfolio', modules: ['ops'], refs: [{ ref_type: 'file', ref_value: 'x.ts' }] }));
    assert.equal(tNote.pending, true);
    updateEntry(w.wa, { ulid: tNote.ulid, description: 'edited while pending' }); // a revision exists
    await w.office.up();
    setAllocator(down); // the office is back, but numbering fails this time
    await w.ca.pushNow();
    assert.equal(atOffice(w.office, tNote.ulid), undefined, 'a pending team note is never sent');
    assert.equal(deliveriesOf(w.office, tNote.ulid), 0);
    assert.equal(sent(w.wa), ownTop(w.wa), 'the bookmark passed the held note (never pinned)');
    setAllocator(null);
    await w.ca.syncNow();
    assert.equal((w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(tNote.ulid) as any).id, 2);
    const o = atOffice(w.office, tNote.ulid);
    assert.deepEqual([o.id, o.series, o.title, o.summary, o.description], [2, 'SH', 'Written offline', 'Written offline summary', 'edited while pending']);
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid = ?`).get(tNote.ulid) as any).n, 1);
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM entry_modules WHERE entry_ulid = ?`).get(tNote.ulid) as any).n, 2);
    assert.ok((w.office.store.prepare(`SELECT COUNT(*) n FROM entry_revisions WHERE entry_ulid = ?`).get(tNote.ulid) as any).n >= 1);
    await w.cb.syncNow();
    const b = getEntryByUlid(w.wb, tNote.ulid)!;
    assert.equal(b.title, 'Written offline');
    assert.equal(b.id, 2);
    assert.equal(b.description, 'edited while pending');
  } finally { await w.cleanup(); }
});

test('Review Focus 3: the answer was lost after the office allocated: the retry gets the SAME number', async () => {
  const w = await world();
  try {
    team(w.office);
    await w.ca.syncNow();
    const u = newUlid();
    assert.equal(allocate(w.office.store, u, 'd', 'SH'), 1); // the office numbered it; the laptop never heard
    const p = addEntry(w.wa, { ...note('lost answer'), project: 'SH', pendingUlid: u });
    assert.deepEqual([p.pending, p.ulid], [true, u]);
    await w.ca.numberPendingNow();
    assert.equal((w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(u) as any).id, 1);
    assert.equal((w.office.store.prepare(`SELECT value FROM po_series_counters WHERE series = 'SH'`).get() as any).value, 1, 'the counter did not move');
  } finally { await w.cleanup(); }
});

test('an E note saved pending while the office is down is numbered and delivered once it is back', async () => {
  const w = await world();
  try {
    await w.ca.syncNow();
    await w.office.down();
    const e = await addEntryAsync(w.wa, note('E offline', { module: 'portfolio' }));
    assert.equal(e.pending, true);
    await w.office.up();
    await w.ca.syncNow();
    const id = (w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(e.ulid) as any).id;
    assert.equal(id, 1, 'numbered from the E counter');
    await w.cb.syncNow();
    assert.equal(getEntryByUlid(w.wb, e.ulid)?.title, 'E offline');
    assert.equal(getEntryByUlid(w.wb, e.ulid)?.id, 1);
  } finally { await w.cleanup(); }
});

test('a solo note is still never sent', async () => {
  const w = await world();
  try {
    createProject(w.wa, { name: 'mine', code: 'P1' });
    const s = await addEntryAsync(w.wa, note('solo', { project: 'P1', module: 'portfolio' }));
    assert.equal(`${s.series}-${s.id}`, 'P1-1');
    await w.ca.syncNow();
    assert.equal(deliveriesOf(w.office, s.ulid), 0);
  } finally { await w.cleanup(); }
});

test('promote: a solo project made team sends its older notes whole and continues its numbers', async () => {
  const w = await world();
  try {
    const nv = createProject(w.wa, { name: 'Navi', code: 'NV' });
    const n1 = await addEntryAsync(w.wa, note('nv one', { project: 'NV' }));
    const n2 = await addEntryAsync(w.wa, note('nv two', { project: 'NV' }));
    await w.ca.syncNow();
    assert.equal(deliveriesOf(w.office, n1.ulid), 0, 'solo until promoted');
    w.wa.prepare(`UPDATE projects SET mode = 'team', team = ? WHERE ulid = ?`).run(w.office.fingerprint, nv.ulid);
    registerProject(w.office.store, { ulid: nv.ulid, name: 'Navi', code: 'NV', seed: 2 });
    await w.ca.syncNow();
    assert.equal(atOffice(w.office, n1.ulid)?.title, 'nv one');
    assert.equal(atOffice(w.office, n2.ulid)?.title, 'nv two');
    await w.cb.syncNow();
    assert.deepEqual(
      (w.wb.prepare(`SELECT id FROM entries WHERE series = 'NV' ORDER BY id`).all() as any[]).map((r) => r.id), [1, 2]);
    const n3 = await addEntryAsync(w.wa, note('nv three', { project: 'NV' }));
    assert.equal(`${n3.series}-${n3.id}`, 'NV-3');
    assert.ok(w.office.store.prepare(`SELECT 1 FROM po_series_allocations WHERE ulid = ? AND series = 'NV' AND id = 3`).get(n3.ulid), 'numbered by the office');
  } finally { await w.cleanup(); }
});

test('Review Focus 4: a pulled note names an unknown project: the pull learns it; an edit made while it was unknown is still sent', async () => {
  const w = await world();
  try {
    await w.ca.syncNow(); await w.cb.syncNow();
    team(w.office, 'ZZ', 'Zed');
    await w.ca.syncNow();
    const z = await addEntryAsync(w.wa, note('zz one', { project: 'ZZ' }));
    await w.ca.pushNow();
    await w.cb.pullNow(); // the changes doorbell only: no projects refresh before it
    assert.ok(w.wb.prepare(`SELECT 1 FROM projects WHERE code = 'ZZ' AND mode = 'team'`).get(), 'the pull learned the project');
    assert.equal(getEntryByUlid(w.wb, z.ulid)?.title, 'zz one');
    // B forgets the project (as if it never learned it), then edits the note.
    w.wb.prepare(`DELETE FROM projects WHERE code = 'ZZ'`).run();
    updateEntry(w.wb, { ulid: z.ulid, summary: 'edited on B before knowing ZZ' });
    await w.cb.pushNow();
    assert.equal(atOffice(w.office, z.ulid).summary, 'zz one summary', 'held while the project is unknown');
    assert.equal(sent(w.wb), ownTop(w.wb), 'the bookmark is not pinned');
    await w.cb.syncNow(); // learns ZZ again; its notes are backfilled
    assert.equal(atOffice(w.office, z.ulid).summary, 'edited on B before knowing ZZ');
  } finally { await w.cleanup(); }
});

test('a note that can never be numbered stays pending; everything else is sent and the bookmark moves', async () => {
  const w = await world();
  try {
    team(w.office);
    await w.ca.syncNow();
    setAllocator({
      allocate: async (u, s) => {
        if (s === 'SH') throw Object.assign(new Error('the post office did not number this note in series SH: update the post office'), { retriable: false });
        return allocate(w.office.store, u, 'fake', s);
      },
    });
    const sh = await addEntryAsync(w.wa, note('never numbered', { project: 'SH' }));
    const e = await addEntryAsync(w.wa, note('E goes through', { module: 'portfolio' }));
    assert.equal(sh.pending, true);
    assert.equal(e.pending, false);
    await w.ca.syncNow();
    assert.equal(atOffice(w.office, e.ulid)?.title, 'E goes through');
    assert.equal((w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(sh.ulid) as any).id, null);
    assert.match(w.ca.status.lastError ?? '', /update the post office/);
    assert.equal(sent(w.wa), ownTop(w.wa));
    const before = deliveries(w.office);
    const sentTotal = w.ca.status.sentTotal;
    await w.ca.pushNow();
    assert.equal(deliveries(w.office), before, 'a second push sends nothing');
    assert.equal(w.ca.status.sentTotal, sentTotal);
  } finally { await w.cleanup(); }
});

test('deleted while pending: never numbered, never sent, the bookmark reaches the top', async () => {
  const w = await world();
  try {
    team(w.office);
    await w.ca.syncNow();
    await w.office.down();
    const p = await addEntryAsync(w.wa, note('gone before numbered', { project: 'SH' }));
    w.wa.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ?`).run(p.ulid);
    await w.office.up();
    await w.ca.syncNow();
    assert.equal((w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(p.ulid) as any).id, null);
    assert.equal(deliveriesOf(w.office, p.ulid), 0);
    assert.equal(sent(w.wa), ownTop(w.wa));
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM po_series_allocations`).get() as any).n, 0);
  } finally { await w.cleanup(); }
});

test('Review Focus 5: a team code that clashes with a local solo project is never mixed in; it resumes once resolved', async () => {
  const w = await world();
  try {
    createProject(w.wb, { name: 'Bs own', code: 'SH' });
    const mine = await addEntryAsync(w.wb, note('B solo SH one', { project: 'SH' }));
    assert.equal(`${mine.series}-${mine.id}`, 'SH-1');
    const sh = team(w.office);
    await w.ca.syncNow();
    const aNote = addEntry(w.wa, { ...note('A team SH one'), project: 'SH', assigned: { ulid: '00000000000000000000000001', id: 1 } });
    await w.ca.pushNow();
    assert.equal(atOffice(w.office, aNote.ulid)?.title, 'A team SH one');
    const bE = await addEntryAsync(w.wb, note('B E note', { module: 'portfolio' }));

    await w.cb.syncNow();
    const bProjects = w.wb.prepare(`SELECT ulid, mode FROM projects WHERE code = 'SH'`).all() as any[];
    assert.equal(bProjects.length, 1);
    assert.equal(bProjects[0].mode, 'solo', 'B keeps its own SH');
    assert.equal(w.wb.prepare(`SELECT 1 FROM projects WHERE ulid = ?`).get(sh.ulid), undefined, 'the team SH is not created');
    assert.deepEqual(JSON.parse(getSyncValue(w.wb, K.projectClash) ?? '[]').map((c: any) => c.code), ['SH']);
    assert.equal(w.cb.status.state, 'needs-action');
    assert.match(w.cb.status.lastError ?? '', /SH/);
    assert.equal(w.wb.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(aNote.ulid), undefined, 'no team change was applied');
    assert.equal(ownerOfRef(w.wb, { series: 'SH', id: 1 })?.ulid, mine.ulid);
    assert.equal(atOffice(w.office, bE.ulid)?.title, 'B E note', 'B still sends its E notes');
    await w.cb.pullNow();
    assert.equal(w.wb.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(aNote.ulid), undefined, 'a doorbell pull is held too');

    // B resolves it: its solo SH goes away.
    w.wb.prepare(`DELETE FROM entries WHERE series = 'SH'`).run();
    w.wb.prepare(`DELETE FROM projects WHERE code = 'SH'`).run();
    await w.cb.syncNow();
    assert.equal(getSyncValue(w.wb, K.projectClash), '[]');
    assert.equal(w.cb.status.state, 'connected');
    assert.equal(getEntryByUlid(w.wb, aNote.ulid)?.title, 'A team SH one');
  } finally { await w.cleanup(); }
});
