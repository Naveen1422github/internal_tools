// file: courier/test/copy-leak.test.ts
// Stage B2: the spec's leak tests (Testing, "Leak tests"), plus copies and
// copied_to links (B2-3) and a team this laptop left (P11), through a real office.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, createProject, deleteEntry, newUlid, markProjectLeft, planCopy, applyCopy,
  setAllocator, setAllocationRetry,
} from '@collab-mcp/core';
import { registerProject, setProjectMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter, type Office } from './world.js';
import { Courier } from '../src/engine.js';

async function world() {
  const t = tempDir('collab-copy-leak-');
  const office = await startOffice(t.dir, 0);
  const ja = await joinedDb(office, t.dir, 'a'), jb = await joinedDb(office, t.dir, 'b');
  const wa = openWriter(ja.path), wb = openWriter(jb.path);
  const ca = new Courier({ dbPath: ja.path, watch: false, retryMs: 60_000 });
  const cb = new Courier({ dbPath: jb.path, watch: false, retryMs: 60_000 });
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  const sh = registerProject(office.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, ja.device); // RnR: a creates it
  setProjectMember(office.store, ja.device, sh.ulid, jb.device, 'Editor'); // RnR R7a: b is added explicitly
  await ca.syncNow();
  await cb.syncNow();
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

const note = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'decision' as const, title, summary: 's', ...extra });
const deliveriesOf = (o: Office, ulid: string) =>
  (o.store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE instr(pk, CAST(? AS BLOB)) > 0`).get(ulid) as { n: number }).n;
const atOffice = (o: Office, ulid: string) => !!o.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(ulid);

async function asAuthor<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.COLLAB_AUTHOR;
  process.env.COLLAB_AUTHOR = name;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.COLLAB_AUTHOR; else process.env.COLLAB_AUTHOR = saved; }
}

test('leak: a solo note tagged with a team project\'s module is never sent; an E note in a module of that name is never sent', async () => {
  const w = await world();
  try {
    createProject(w.wa, { name: 'mine', code: 'P1' });
    const sh = await addEntryAsync(w.wa, note('team note', { project: 'SH', module: 'support' }));
    const solo = await addEntryAsync(w.wa, note('solo note', { project: 'P1', module: 'support' }));
    const e = await addEntryAsync(w.wa, note('E note', { project: 'none', module: 'support' }));
    assert.equal(sh.series, 'SH');
    assert.equal(solo.series, 'P1');
    assert.equal(e.series, 'E');
    await w.ca.syncNow();
    assert.ok(atOffice(w.office, sh.ulid), 'the team note reached the office');
    assert.equal(deliveriesOf(w.office, solo.ulid), 0, 'nothing keyed by the solo note');
    assert.equal(deliveriesOf(w.office, e.ulid), 0, 'nothing keyed by the E note in a module named like a team module');
  } finally { await w.cleanup(); }
});

test('team -> solo copy with --author me: neither the copies nor any copied_to link reach the office or the team', async () => {
  const w = await world();
  try {
    const mine = await asAuthor('naveen', () => addEntryAsync(w.wa, note('mine', { project: 'SH', refs: [{ ref_type: 'file', ref_value: 'a.ts' }] })));
    await w.ca.pushNow();
    const hers = await asAuthor('rinku', () => addEntryAsync(w.wb, note('hers', { project: 'SH' })));
    await w.cb.pushNow();
    await w.ca.syncNow();
    createProject(w.wa, { name: 'mine', code: 'P1' });
    const plan = await asAuthor('naveen', () => planCopy(w.wa, { from: 'SH', to: 'P1', author: 'me' }));
    assert.deepEqual(plan.items.map((i) => i.ulid), [mine.ulid], 'only my notes');
    const r = await asAuthor('naveen', () => applyCopy(w.wa, plan));
    assert.equal(r.copied[0].to, 'P1-1');
    const copyUlid = r.copied[0].to_ulid;
    const before = (w.office.store.prepare(`SELECT COUNT(*) n FROM po_deliveries`).get() as { n: number }).n;
    await w.ca.syncNow();
    assert.equal(deliveriesOf(w.office, copyUlid), 0, 'nothing keyed by the copy');
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM refs WHERE ref_value LIKE 'copied_to:%'`).get() as { n: number }).n, 0,
      'no copied_to link at the office');
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM po_deliveries`).get() as { n: number }).n, before, 'the copy sent nothing at all');
    await w.cb.syncNow();
    assert.equal((w.wb.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid = ? AND ref_value LIKE 'copied_to:%'`).get(mine.ulid) as { n: number }).n, 0,
      "the team's copy of the original is unchanged");
    assert.ok(hers.ulid);
  } finally { await w.cleanup(); }
});

test('a team this laptop left: a delete is not sent, a pending note is never numbered', async () => {
  const w = await world();
  try {
    const kept = await addEntryAsync(w.wa, note('numbered', { project: 'SH' }));
    await w.ca.pushNow();
    setAllocator({ allocate: async () => { throw new Error('connect ECONNREFUSED'); } });
    const waiting = await addEntryAsync(w.wa, note('pending', { project: 'SH' }));
    assert.equal(waiting.pending, true);
    setAllocator(null);
    markProjectLeft(w.wa, 'SH');
    const before = deliveriesOf(w.office, kept.ulid);
    deleteEntry(w.wa, kept.id!, 'SH');
    await w.ca.syncNow();
    assert.equal(deliveriesOf(w.office, kept.ulid), before, 'the tombstone of a left note is not sent');
    assert.equal((w.wa.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(waiting.ulid) as { id: number | null }).id, null, 'never numbered');
    assert.equal(atOffice(w.office, waiting.ulid), false);
    assert.equal((w.office.store.prepare(`SELECT COUNT(*) n FROM po_series_allocations WHERE ulid = ?`).get(waiting.ulid) as { n: number }).n, 0,
      'the office was never asked for its number');
  } finally { await w.cleanup(); }
});
