// file: courier/test/refusals.test.ts
// RnR S2 Task 6: the courier keeps each laptop transaction on one page (R5),
// records the office's refusals in the same transaction that moves the
// sent-bookmark (R6), turns an allocate 403 into a refusal never retried (R7),
// and never sends a refused note again. N owns the project; R is the teammate.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, newUlid, getSyncValue, listRefused, unsentSharedCount, setAllocator, setAllocationRetry, type WireChange,
} from '@collab-mcp/core';
import { registerProject, setProjectMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';
import { Courier, pagesOf } from '../src/engine.js';
import { COURIER_KEYS as K } from '../src/keys.js';

const cell = (note: string, cid: string, dbv: number, table = 'entries', site = 's1'): WireChange =>
  ({ table, pk: note, cid, val: null, col_version: 1, db_version: dbv, site_id: site, cl: 1, seq: 0 } as unknown as WireChange);
const noteOf = (w: WireChange) => (w.table === 'entries' ? String(w.pk) : null);
const groupOf = (w: WireChange) => `${w.site_id}:${w.db_version}`;

test('a group bigger than one page is never split; groups stay whole across pages', () => {
  const batch: WireChange[] = [];
  // v1: n1 (2 cells); v2: a big transaction (7 cells, 3 notes + refs); v3: n4 (2); v4: a refs-only pair; v5: n1 again.
  batch.push(cell('n1', 'title', 1), cell('n1', 'summary', 1));
  for (const n of ['n2', 'n3']) batch.push(cell(n, 'title', 2), cell(n, 'summary', 2));
  batch.push(cell('n2', 'x', 2, 'refs'), cell('n3', 'x', 2, 'refs'), cell('n2', 'y', 2, 'refs'));
  batch.push(cell('n4', 'title', 3), cell('n4', 'summary', 3));
  batch.push(cell('n4', 'a', 4, 'refs'), cell('n4', 'b', 4, 'refs'));
  batch.push(cell('n1', 'project_ulid', 5));
  // Another laptop's site with the same db_version is a different group.
  batch.push(cell('n5', 'title', 1, 'entries', 's2'));
  const pages = pagesOf(batch, noteOf, 3);
  assert.equal(pages.flat().length, batch.length, 'nothing lost or doubled');
  const pageOfGroup = new Map<string, Set<number>>();
  pages.forEach((p, i) => p.forEach((w) => { const s = pageOfGroup.get(groupOf(w)) ?? new Set(); s.add(i); pageOfGroup.set(groupOf(w), s); }));
  for (const [g, s] of pageOfGroup) assert.equal(s.size, 1, `group ${g} is on one page`);
  const big = pages.findIndex((p) => p.some((w) => w.db_version === 2));
  assert.ok(pages[big].every((w) => w.db_version === 2), 'the oversize group goes alone on its page');
  assert.equal(pages[big].length, 7);
  // A note's entries cells still ride together (R3): n1's v1 and v5 cells share a page.
  for (const n of ['n1', 'n2', 'n3', 'n4']) {
    const where = new Set(pages.flatMap((p, i) => (p.some((w) => w.table === 'entries' && w.pk === n) ? [i] : [])));
    assert.equal(where.size, 1, `${n}'s entries cells are in one request`);
  }
  // Pages stay at the size unless one group (or one note's groups) is bigger.
  for (const p of pages) if (!p.some((w) => w.db_version === 2)) assert.ok(p.length <= 3, `page of ${p.length}`);
  for (const p of pages) {
    const idx = p.map((w) => batch.indexOf(w));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'original order kept within a page');
  }
});

async function world(batchSize?: number) {
  const t = tempDir('collab-refusals-');
  const office = await startOffice(t.dir, 0);
  const jn = await joinedDb(office, t.dir, 'n'), jr = await joinedDb(office, t.dir, 'r');
  const wn = openWriter(jn.path), wr = openWriter(jr.path);
  const cn = new Courier({ dbPath: jn.path, watch: false, retryMs: 60_000 });
  const cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000, ...(batchSize ? { batchSize } : {}) });
  setAllocationRetry({ delaysMs: [0, 0], timeoutMs: 1500 });
  const sh = registerProject(office.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, jn.device);
  await cn.syncNow();
  return {
    office, wn, wr, cn, cr, n: jn.device, r: jr.device, sh,
    cleanup: async () => {
      setAllocator(null); setAllocationRetry(null);
      await cn.stop(); await cr.stop();
      closeWriter(wn); closeWriter(wr);
      await office.close();
      t.cleanup();
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** N writes notes in SH; R joins as Reader and gets them by replay. */
async function readerHasNotes(w: World, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await addEntryAsync(w.wn, { type: 'decision', title: 'office title', summary: `s${i}`, project: 'SH' })).ulid);
  await w.cn.pushNow();
  setProjectMember(w.office.store, w.n, w.sh.ulid, w.r, 'Reader');
  await w.cr.syncNow();
  for (const u of out) assert.equal(titleOf(w.wr, u), 'office title', 'R has the note');
  return out;
}
const readerHasNote = async (w: World) => (await readerHasNotes(w, 1))[0];
const titleOf = (db: ReturnType<typeof openWriter>, ulid: string) =>
  (db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(ulid) as { title: string } | undefined)?.title;
const typed = (cells: WireChange[]) => cells.filter((c) => c.table === 'entries' && c.cid === 'title').map((c) => c.val);

test('refused edit: values saved in refused_changes, laptop reverted after the next pull', async () => {
  const w = await world();
  try {
    const ulid = await readerHasNote(w);
    w.wr.prepare(`UPDATE entries SET title = 'typed by R' WHERE ulid = ?`).run(ulid);
    await w.cr.pushNow();
    const rows = listRefused(w.wr);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'edit');
    assert.equal(rows[0].note_ulid, ulid);
    assert.equal(rows[0].project_ulid, w.sh.ulid);
    assert.match(rows[0].key ?? '', /^note\.edit/);
    assert.ok(rows[0].reason.length > 0);
    assert.deepEqual(typed(rows[0].cells), ['typed by R'], 'the typed value is kept');
    assert.equal(titleOf(w.office.store as never, ulid), 'office title', 'the office kept its value');
    await w.cr.pullNow();
    assert.equal(titleOf(w.wr, ulid), 'office title', 'the write-back reverted the laptop');
    assert.equal(listRefused(w.wr).length, 1, 'the refusal stays until the person acts');
    const before = w.office.requests.filter((q) => q.route === 'POST /v1/changes' && q.device === w.r).length;
    await w.cr.pushNow();
    assert.equal(w.office.requests.filter((q) => q.route === 'POST /v1/changes' && q.device === w.r).length, before, 'nothing new to send');
  } finally { await w.cleanup(); }
});

test('crash between the POST answer and K.sent: resend gives the same refusal, recorded once', async () => {
  const w = await world();
  try {
    const ulid = await readerHasNote(w);
    w.wr.prepare(`UPDATE entries SET title = 'typed by R' WHERE ulid = ?`).run(ulid);
    const sentBefore = getSyncValue(w.wr, K.sent);
    let drop = true;
    w.office.hooks.dropChangesAnswer = (d) => { if (d === w.r && drop) { drop = false; return true; } return false; };
    await w.cr.pushNow();
    assert.equal(w.cr.status.state, 'offline', 'the lost answer is a failure');
    assert.equal(listRefused(w.wr).length, 0, 'nothing recorded without an answer');
    assert.equal(getSyncValue(w.wr, K.sent), sentBefore, 'the sent-bookmark did not move');
    // The real retry path: syncNow (pulls first, then pushes).
    await w.cr.syncNow();
    const rows = listRefused(w.wr);
    assert.equal(rows.length, 1, 'recorded once');
    assert.equal(rows[0].kind, 'edit');
    assert.deepEqual(typed(rows[0].cells), ['typed by R'], 'the typed value survived the crash');
    await w.cr.syncNow();
    assert.equal(listRefused(w.wr).length, 1, 'a further sync records nothing more');
    assert.equal(titleOf(w.wr, ulid), 'office title');
    assert.equal(getSyncValue(w.wr, K.inflight), null, 'the outbox is cleared');
  } finally { await w.cleanup(); }
});

test("a push that fails partway through its pages: the first page's refusal is recorded once after recovery (R-22)", async () => {
  const w = await world(1);
  try {
    const [a, b] = await readerHasNotes(w, 2);
    w.wr.prepare(`UPDATE entries SET title = 'typed A' WHERE ulid = ?`).run(a);
    w.wr.prepare(`UPDATE entries SET title = 'typed B' WHERE ulid = ?`).run(b);
    let posts = 0;
    w.office.hooks.dropChangesAnswer = (d) => d === w.r && ++posts === 2; // page 1 answered, page 2's answer lost
    await w.cr.pushNow();
    assert.equal(posts, 2, 'two pages');
    assert.equal(w.cr.status.state, 'offline');
    assert.equal(listRefused(w.wr).length, 0, 'nothing recorded before the whole push is acknowledged');
    assert.ok(getSyncValue(w.wr, K.inflight), 'the outbox holds the push');
    await w.cr.syncNow(); // pulls the write-backs only after the resend
    const rows = listRefused(w.wr);
    assert.equal(rows.length, 2, 'each refusal once');
    assert.deepEqual(rows.map((r) => typed(r.cells)[0]).sort(), ['typed A', 'typed B']);
    assert.deepEqual([titleOf(w.wr, a), titleOf(w.wr, b)], ['office title', 'office title'], 'reverted after the pull');
    assert.equal(getSyncValue(w.wr, K.inflight), null);
    await w.cr.syncNow();
    assert.equal(listRefused(w.wr).length, 2, 'never recorded again');
  } finally { await w.cleanup(); }
});

test('after a refused edit, a later allowed edit of the same note is sent and accepted (R-23)', async () => {
  const w = await world();
  try {
    const ulid = await readerHasNote(w);
    w.wr.prepare(`UPDATE entries SET title = 'typed by R' WHERE ulid = ?`).run(ulid);
    await w.cr.syncNow();
    assert.equal(listRefused(w.wr).length, 1);
    await w.cr.pullNow(); // the office's write-back
    assert.equal(titleOf(w.wr, ulid), 'office title');
    setProjectMember(w.office.store, w.n, w.sh.ulid, w.r, 'Editor');
    await w.cr.syncNow();
    w.wr.prepare(`UPDATE entries SET title = 'allowed now' WHERE ulid = ?`).run(ulid);
    await w.cr.pushNow();
    assert.equal(titleOf(w.office.store as never, ulid), 'allowed now', 'the office accepted the later edit');
    assert.equal(listRefused(w.wr).length, 1, 'no new refusal');
    await w.cn.pullNow();
    assert.equal(titleOf(w.wn, ulid), 'allowed now', 'N got it');
  } finally { await w.cleanup(); }
});

test('offline note in a project where note.create was taken away: refused on numbering, never retried, never sent', async () => {
  const w = await world();
  try {
    setProjectMember(w.office.store, w.n, w.sh.ulid, w.r, 'Contributor');
    await w.cr.syncNow();
    await w.office.down();
    const { ulid } = await addEntryAsync(w.wr, { type: 'decision', title: 'written offline', summary: 's', project: 'SH' });
    assert.equal((w.wr.prepare(`SELECT id FROM entries WHERE ulid = ?`).get(ulid) as { id: number | null }).id, null, 'pending');
    setProjectMember(w.office.store, w.n, w.sh.ulid, w.r, 'Reader');
    await w.office.up();
    const allocs = () => w.office.requests.filter((q) => q.route === 'POST /v1/allocate' && q.device === w.r).length;
    await w.cr.syncNow();
    assert.equal(allocs(), 1, 'asked once');
    const rows = listRefused(w.wr);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'new');
    assert.equal(rows[0].note_ulid, ulid);
    assert.equal(rows[0].key, 'note.create');
    assert.match(rows[0].reason, /note\.create/);
    assert.doesNotMatch(rows[0].reason, /answered 403/, 'the office\'s plain text');
    assert.deepEqual(typed(rows[0].cells), ['written offline'], 'the note\'s cells are kept');
    assert.doesNotMatch(w.cr.status.lastError ?? '', /could not be numbered/, 'not a numbering problem');
    await w.cr.syncNow();
    await w.cr.numberPendingNow();
    assert.equal(allocs(), 1, 'never asked again');
    assert.equal(listRefused(w.wr).length, 1, 'kept once');
    assert.equal(w.office.store.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(ulid), undefined, 'never sent');
    assert.equal(unsentSharedCount(w.wr), 0, 'not counted as waiting');
    assert.equal(titleOf(w.wr, ulid), 'written offline', 'the note stays local');
  } finally { await w.cleanup(); }
});

test('courier status shows the refused count', async () => {
  const w = await world();
  try {
    const ulid = await readerHasNote(w);
    assert.doesNotMatch(w.cr.status.lastError ?? '', /refused by the post office/);
    w.wr.prepare(`UPDATE entries SET title = 'typed by R' WHERE ulid = ?`).run(ulid);
    await w.cr.syncNow();
    assert.equal(w.cr.status.state, 'connected');
    assert.match(w.cr.status.lastError ?? '', /1 change\(s\) refused by the post office: collab refused list/);
  } finally { await w.cleanup(); }
});
