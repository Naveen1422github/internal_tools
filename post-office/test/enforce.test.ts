// RnR S2 (R5, R6, R7): acceptChanges records and applies only what the sender's
// role allows; a refused group is answered in `refused` and the office writes its
// own value back so the sender's laptop reverts. /v1/allocate checks note.create.
import { test } from 'node:test';
import assert from 'node:assert';
import type Database from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, updateEntryRefs, setAllocator, readOwnChanges, applyChanges, decodeChange,
  addEntry, revisionsOf, headsOf, rootRevId, newUlid, requestJson, openEventStream, upsertTeamProjectFromOffice, type WireChange,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { office } from './office.js';
import { acceptChanges, fetchDeliveries, firstTextCell, OFFICE_ORIGIN } from '../src/deliveries.js';
import { allocate, registerProject, StoreError, type Store } from '../src/store.js';
import { setProjectMember } from '../src/access.js';
import { groupKey } from '../src/classify.js';

type DB = Database.Database;
const dbv = (db: DB | Store) => (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
const member = (s: Store, id: string) =>
  s.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
const count = (s: Store, sql: string, ...args: unknown[]) => (s.prepare(sql).get(...args) as { n: number }).n;
const titleOf = (db: DB | Store, u: string) => (db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(u) as { title: string } | undefined)?.title;
const cvOf = (db: DB | Store, u: string, cid: string) =>
  (db.prepare(`SELECT col_version v FROM crsql_changes WHERE "table" = 'entries' AND pk = crsql_pack_columns(?) AND cid = ?`).get(u, cid) as { v: number } | undefined)?.v;
const need = (label: string, key: string) => `You need "${label}" (${key}) in TM to do this`;
/** The laptop knows team project TM, as the courier records it from the office. */
const teamOn = (db: DB, ulid: string) => upsertTeamProjectFromOffice(db, { ulid, name: 'Team', code: 'TM' }, 'test-office');

/** A member's laptop: push = its own changes since the last push; pull = deliveries since the last pull, applied. */
function device(store: Store, id: string) {
  const l = laptop();
  let sent = 0, got = 0;
  return {
    id, db: l.db,
    changes(): WireChange[] { return readOwnChanges(l.db, sent); },
    push(extra?: { changes?: WireChange[] }) {
      const ch = extra?.changes ?? readOwnChanges(l.db, sent);
      if (!extra?.changes) sent = dbv(l.db);
      return acceptChanges(store, id, ch);
    },
    pull() {
      const r = fetchDeliveries(store, id, got, 5000);
      l.db.transaction(() => applyChanges(l.db, r.changes.map(decodeChange)))();
      got = r.lastSeq;
      return r.changes.length;
    },
    cleanup: l.cleanup,
  };
}

let n = 0;
/** Office with team project TM: d-n Owner, d-r Contributor, d-m Editor, d-rd Reader, d-x no project. */
function world() {
  const { store, cleanup } = tempStore();
  setAllocator({ allocate: async () => ++n });
  for (const d of ['d-n', 'd-r', 'd-m', 'd-rd', 'd-x']) member(store, d);
  const A = registerProject(store, { ulid: newUlid(), name: 'Team', code: 'TM' }, 'd-n').ulid;
  setProjectMember(store, null, A, 'd-r', 'Contributor');
  setProjectMember(store, null, A, 'd-m', 'Editor');
  setProjectMember(store, null, A, 'd-rd', 'Reader');
  store.prepare(`DELETE FROM po_replays`).run(); // nothing to replay yet (R14): the project is new
  const devs = ['d-n', 'd-r', 'd-m', 'd-rd', 'd-x'].map((d) => device(store, d));
  const [N, R, M, RD, X] = devs;
  for (const d of devs) teamOn(d.db, A);
  /** A TM note on `on`'s laptop, written as production writes it: project and series in the INSERT (one transaction). */
  const note = async (on: ReturnType<typeof device>, title: string) => {
    const r = await addEntryAsync(on.db, { type: 'decision', title, summary: `${title} s`, module: 'm', project: A, refs: [{ ref_type: 'file', ref_value: `${title}.ts` }] });
    return r.ulid;
  };
  return { store, A, N, R, M, RD, X, note, done: () => { setAllocator(null); for (const d of devs) d.cleanup(); cleanup(); } };
}

test('refused edit: nothing recorded for the group, sender reverts after pulling the write-back', async () => {
  const w = world();
  try {
    const u = await w.note(w.N, "N's note");
    w.N.push();
    w.R.pull();
    for (const t of ['r1', 'r2', 'r3']) updateEntry(w.R.db, { ulid: u, title: t });
    const before = count(w.store, `SELECT COUNT(*) n FROM po_deliveries`);
    const res = w.R.push();
    assert.equal(res.accepted, 0);
    assert.equal(res.duplicates, 0);
    assert.equal(res.refused.length, 3, 'one refusal per laptop transaction');
    assert.ok(res.refused.every((r) => r.key === 'note.edit.any' && r.ulid === u && r.reason === need('Edit any note', 'note.edit.any')));
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE origin = 'd-r'`), 0, 'nothing of the group is recorded');
    assert.equal(titleOf(w.store, u), "N's note", 'nor applied');
    assert.ok(count(w.store, `SELECT COUNT(*) n FROM po_deliveries`) > before, 'the write-back is recorded');
    assert.equal(res.officeWrote, true);

    w.R.pull();
    assert.equal(titleOf(w.R.db, u), "N's note", "R's title is the office's again");
    // R's new revisions are gone; the root (`${ulid}.0`, the same on every machine) is never tombstoned (spike §2.2).
    const revs = revisionsOf(w.R.db, u).map((r) => r.rev_id);
    assert.deepEqual(revs, [rootRevId(u)]);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE tbl = 'entry_revisions' AND pk = crsql_pack_columns(?)`, rootRevId(u)), 0);
    // R-5: the revision tombstones carry the note's real stamp, never '?'.
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`), 0);
    assert.ok(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE origin = ? AND tbl = 'entry_revisions' AND project_ulid = ?`, OFFICE_ORIGIN, w.A) >= 3);
    // R pushes again: nothing to send (the revert is not an own change).
    assert.deepEqual(w.R.changes(), []);
  } finally { w.done(); }
});

test('refused edit wins over a run of offline edits (version = max + 1)', async () => {
  const w = world();
  try {
    const u = await w.note(w.N, 'office title');
    w.N.push(); w.R.pull(); w.M.pull();
    assert.equal(cvOf(w.store, u, 'title'), 1);
    for (const t of ['x1', 'x2', 'x3', 'x4']) updateEntry(w.R.db, { ulid: u, title: t });
    const laptopCv = cvOf(w.R.db, u, 'title')!;
    assert.equal(laptopCv, 5);
    const seq0 = fetchDeliveries(w.store, 'd-n', 0, 5000).lastSeq;
    w.R.push();
    const wb = w.store.prepare(`SELECT origin, val, col_version FROM po_deliveries WHERE seq > ? AND tbl = 'entries' AND cid = 'title'`).all(seq0) as Array<{ origin: string; val: string; col_version: number }>;
    assert.deepEqual(wb, [{ origin: OFFICE_ORIGIN, val: 'office title', col_version: laptopCv + 1 }]);
    assert.equal(cvOf(w.store, u, 'title'), laptopCv + 1);
    w.R.pull();
    assert.equal(titleOf(w.R.db, u), 'office title');
    assert.equal(cvOf(w.R.db, u, 'title'), laptopCv + 1);
    // Another member: value unchanged, no echo.
    w.M.pull();
    assert.equal(titleOf(w.M.db, u), 'office title');
    assert.deepEqual(w.M.changes(), []);
  } finally { w.done(); }
});

test('refused new ref / revision row is tombstoned on the sender; other members unaffected', async () => {
  const w = world();
  try {
    const u = await w.note(w.N, 't0');
    updateEntry(w.N.db, { ulid: u, title: 't1' }); // the office holds root + r1
    w.N.push(); w.R.pull(); w.M.pull(); w.X.pull();
    const officeHeads = headsOf(revisionsOf(w.store, u)).map((h) => h.rev_id);
    updateEntry(w.R.db, { ulid: u, title: 't2' });
    updateEntryRefs(w.R.db, { ulid: u, add: [{ ref_type: 'file', ref_value: 'new.ts' }] });
    const res = w.R.push();
    assert.equal(res.refused.length, 2);
    assert.equal(w.store.prepare(`SELECT 1 FROM refs WHERE ref_value = 'new.ts'`).get(), undefined);
    w.R.pull();
    assert.equal(w.R.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ? AND ref_value = 'new.ts'`).get(u), undefined, 'ref gone on the sender');
    assert.ok(w.R.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ? AND ref_value = 't0.ts'`).get(u), 'its other ref stays');
    assert.equal(titleOf(w.R.db, u), 't1');
    assert.deepEqual(headsOf(revisionsOf(w.R.db, u)).map((h) => h.rev_id), officeHeads, "the sender's head is the office's again");
    // Other members: nothing changes, nothing echoes. A device outside TM gets none of it.
    const xSeen = fetchDeliveries(w.store, 'd-x', 0, 5000).changes.map(decodeChange);
    assert.ok(xSeen.every((c) => firstTextCell(c.pk) !== u && c.table !== 'entry_revisions'), 'stamped TM: not sent outside it');
    for (const m of [w.M, w.N]) {
      m.pull();
      assert.equal(m.db.prepare(`SELECT 1 FROM refs WHERE ref_value = 'new.ts'`).get(), undefined);
      assert.equal(titleOf(m.db, u), 't1');
      assert.deepEqual(headsOf(revisionsOf(m.db, u)).map((h) => h.rev_id), officeHeads);
      assert.deepEqual(m.changes(), []);
    }
  } finally { w.done(); }
});

test('refused ref removal: the office revives the row on the sender', async () => {
  const w = world();
  try {
    const u = await w.note(w.N, 'keep');
    w.N.push(); w.R.pull();
    updateEntryRefs(w.R.db, { ulid: u, remove: [{ ref_type: 'file', ref_value: 'keep.ts' }] });
    assert.equal(w.R.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ?`).get(u), undefined);
    assert.equal(w.R.push().refused.length, 1);
    assert.ok(w.store.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ?`).get(u), 'the office still has it');
    w.R.pull();
    assert.ok(w.R.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ? AND ref_value = 'keep.ts'`).get(u), 'revived on the sender');
    assert.deepEqual(w.R.changes(), []);
    assert.equal(w.R.push().refused.length, 0, 'and nothing refused is re-sent');
  } finally { w.done(); }
});

test('mixed batch: allowed group delivered to N, refused group answered in refused[]', async () => {
  const w = world();
  try {
    const theirs = await w.note(w.N, 'theirs');
    w.N.push(); w.R.pull();
    const mine = await w.note(w.R, 'mine');
    updateEntry(w.R.db, { ulid: theirs, title: 'theirs, edited by R' });
    const res = w.R.push();
    assert.ok(res.accepted > 0);
    assert.deepEqual(res.refused.map((r) => [r.key, r.ulid]), [['note.edit.any', theirs]]);
    w.N.pull();
    assert.equal(titleOf(w.N.db, mine), 'mine', "R's own note reaches N");
    assert.equal(titleOf(w.N.db, theirs), 'theirs', "N's note is untouched");
    w.R.pull();
    assert.equal(titleOf(w.R.db, theirs), 'theirs');
    assert.equal(titleOf(w.R.db, mine), 'mine');
  } finally { w.done(); }
});

test('all-refused batch still rings the sender', async () => {
  const o = await office();
  const ln = laptop(), lr = laptop();
  setAllocator({ allocate: async () => ++n });
  try {
    const nn = await o.join('n'), rr = await o.join('r');
    const A = registerProject(o.store, { ulid: newUlid(), name: 'Team', code: 'TM' }, nn.device).ulid;
    setProjectMember(o.store, null, A, rr.device, 'Contributor');
    o.store.prepare(`DELETE FROM po_replays`).run();
    teamOn(ln.db, A);
    const u = (await addEntryAsync(ln.db, { type: 'decision', title: 'n', summary: 's', module: 'm', project: A })).ulid;
    assert.equal((await requestJson(o.target(nn), 'POST', '/v1/changes', { changes: readOwnChanges(ln.db, 0) })).status, 200);
    const page = await requestJson(o.target(rr), 'GET', '/v1/changes?after=0');
    lr.db.transaction(() => applyChanges(lr.db, page.body.changes.map(decodeChange)))();
    const v = dbv(lr.db);
    updateEntry(lr.db, { ulid: u, title: 'not yours' });

    const events: string[] = [];
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const stream = openEventStream(o.target(rr), '/v1/events', { event: (name) => { events.push(name); if (name === 'ready') ready(); }, close: () => {} });
    await isReady;
    const r = await requestJson(o.target(rr), 'POST', '/v1/changes', { changes: readOwnChanges(lr.db, v) });
    assert.equal(r.status, 200, 'a refusal is never an HTTP error');
    assert.deepEqual(Object.keys(r.body).sort(), ['accepted', 'duplicates', 'last_seq', 'refused']);
    assert.equal(r.body.accepted, 0);
    assert.equal(r.body.refused.length, 1);
    assert.deepEqual(Object.keys(r.body.refused[0]).sort(), ['db_version', 'key', 'reason', 'site_id', 'ulid']);
    const end = Date.now() + 3000;
    while (!events.includes('changes')) { if (Date.now() > end) throw new Error('the sender was not rung'); await new Promise((x) => setTimeout(x, 10)); }
    stream.close();
    // Allocate over HTTP: a Contributor holds note.create; a Reader gets the 403;
    // a device outside TM gets the 404 of a project that doesn't exist for it (R7a).
    const ok = await requestJson(o.target(rr), 'POST', '/v1/allocate', { ulid: newUlid(), series: 'TM' });
    assert.deepEqual([ok.status, ok.body.series], [200, 'TM']);
    const rd = await o.join('rd');
    setProjectMember(o.store, null, A, rd.device, 'Reader');
    const no = await requestJson(o.target(rd), 'POST', '/v1/allocate', { ulid: newUlid(), series: 'TM' });
    assert.equal(no.status, 403);
    assert.match(no.body.error, /note\.create/);
    const x = await o.join('x');
    const out = await requestJson(o.target(x), 'POST', '/v1/allocate', { ulid: newUlid(), series: 'TM' });
    assert.deepEqual([out.status, out.body.error], [404, 'no team project with code TM on this post office']);
  } finally { setAllocator(null); ln.cleanup(); lr.cleanup(); await o.stop(); }
});

test('resend of a refused group: same refusal, no second write-back', async () => {
  const w = world();
  try {
    const u = await w.note(w.N, 'office');
    w.N.push(); w.R.pull();
    updateEntry(w.R.db, { ulid: u, title: 'refused' });
    const edit = w.R.changes();
    const first = w.R.push({ changes: edit });
    const rows = count(w.store, `SELECT COUNT(*) n FROM po_deliveries`);
    const again = w.R.push({ changes: edit });
    assert.deepEqual(again.refused, first.refused);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries`), rows, 'no second write-back');
    assert.equal(again.officeWrote, false);

    // A refused creation (a Reader): same refusal on resend, nothing written either time.
    const v = dbv(w.RD.db);
    const c = await w.note(w.RD, 'reader note');
    const create = readOwnChanges(w.RD.db, v);
    const r1 = w.RD.push({ changes: create });
    assert.deepEqual(r1.refused.map((r) => [r.key, r.ulid]), [['note.create', c]]);
    const r2 = w.RD.push({ changes: create });
    assert.deepEqual(r2.refused, r1.refused);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries`), rows, 'a refused creation gets no write-back (R-13)');
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_refused_notes WHERE ulid = ?`, c), 1);
    // A later edit of that note names the key its creation was refused for (R7).
    const ev = dbv(w.RD.db);
    updateEntry(w.RD.db, { ulid: c, title: 'reader note, edited' });
    const later = w.RD.push({ changes: readOwnChanges(w.RD.db, ev) });
    assert.deepEqual(later.refused.map((r) => [r.key, r.reason, r.ulid]), [['note.create', need('Create notes', 'note.create'), c]]);
  } finally { w.done(); }
});

test('allocate without note.create -> 403 naming note.create; po_refused_notes has the ulid', async () => {
  const w = world();
  try {
    const u = newUlid();
    assert.throws(() => allocate(w.store, u, 'd-rd', 'TM'),
      (e: unknown) => e instanceof StoreError && e.status === 403 && e.message === need('Create notes', 'note.create'));
    assert.deepEqual(w.store.prepare(`SELECT ulid, device_id, key FROM po_refused_notes`).all(), [{ ulid: u, device_id: 'd-rd', key: 'note.create' }]);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_series_allocations`), 0, 'no number spent');
    // Idempotent (E-713): a ulid already numbered still gets its number back.
    const v = newUlid();
    assert.equal(allocate(w.store, v, 'd-r', 'TM'), 1);
    assert.equal(allocate(w.store, v, 'd-rd', 'TM'), 1);
    // E has no project: unchecked. The office CLI (null) is unguarded. 404/409 unchanged.
    assert.ok(allocate(w.store, newUlid(), 'd-x', 'E') > 0);
    assert.equal(allocate(w.store, newUlid(), null, 'TM'), 2);
    assert.throws(() => allocate(w.store, newUlid(), 'd-rd', 'ZZ'), (e: unknown) => e instanceof StoreError && e.status === 404);
    assert.throws(() => allocate(w.store, v, 'd-rd', 'E'), (e: unknown) => e instanceof StoreError && e.status === 409);
    // R7a: outside TM the project doesn't exist: the same 404 as a missing one, nothing recorded.
    const outside = newUlid();
    assert.throws(() => allocate(w.store, outside, 'd-x', 'TM'),
      (e: unknown) => e instanceof StoreError && e.status === 404 && e.message === 'no team project with code TM on this post office');
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_refused_notes WHERE ulid = ?`, outside), 0);
  } finally { w.done(); }
});

test('refused allocate, then note.create granted: allocate numbers it and the note is accepted', async () => {
  const w = world();
  try {
    const u = newUlid();
    assert.throws(() => allocate(w.store, u, 'd-rd', 'TM'), (e: unknown) => e instanceof StoreError && e.status === 403);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_refused_notes WHERE ulid = ?`, u), 1);
    setProjectMember(w.store, null, w.A, 'd-rd', 'Contributor');
    w.store.prepare(`DELETE FROM po_replays`).run();
    const id = allocate(w.store, u, 'd-rd', 'TM');
    assert.ok(id > 0);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_refused_notes WHERE ulid = ?`, u), 0, 'the refusal is lifted: the office holds nothing of it');
    // The laptop wrote it pending under that ulid, then numbered it (as the courier does).
    addEntry(w.RD.db, { type: 'decision', title: 'granted', summary: 's', module: 'm', project: w.A, pendingUlid: u });
    w.RD.db.prepare(`UPDATE entries SET id = ? WHERE ulid = ?`).run(id, u);
    const res = w.RD.push();
    assert.deepEqual(res.refused, []);
    assert.ok(res.accepted > 0);
    assert.equal(titleOf(w.store, u), 'granted');
    w.N.pull();
    assert.equal(titleOf(w.N.db, u), 'granted');
  } finally { w.done(); }
});

test('a refused group touching a held note still arriving: its write-back is held, never stamped NULL', async () => {
  const w = world();
  try {
    const other = await w.note(w.N, 'other');
    w.N.push();
    // N's next note reaches the office cut before its project cell: held ('?').
    const v = dbv(w.N.db);
    const half = await w.note(w.N, 'half');
    const cells = readOwnChanges(w.N.db, v);
    const cut = cells.map(decodeChange).findIndex((c) => c.table === 'entries' && c.cid === 'project_ulid');
    w.N.push({ changes: cells.slice(0, cut) });
    // R has both notes (out of band) and edits them in ONE transaction: refused (edit.any on N's notes).
    w.R.pull();
    w.R.db.transaction(() => applyChanges(w.R.db, cells.map(decodeChange)))();
    const rv = dbv(w.R.db);
    w.R.db.transaction(() => {
      w.R.db.prepare(`UPDATE entries SET title = 'r' WHERE ulid IN (?, ?)`).run(other, half);
    })();
    const seq0 = fetchDeliveries(w.store, 'd-n', 0, 5000).lastSeq;
    const res = w.R.push({ changes: readOwnChanges(w.R.db, rv) });
    assert.equal(res.refused.length, 1);
    const stamps = w.store.prepare(`SELECT pk, project_ulid p FROM po_deliveries WHERE seq > ? AND origin = ?`).all(seq0, OFFICE_ORIGIN) as Array<{ pk: Buffer; p: string | null }>;
    const of = (u: string) => stamps.filter((s) => firstTextCell(s.pk) === u).map((s) => s.p);
    assert.ok(of(other).length > 0 && of(other).every((p) => p === w.A));
    assert.ok(of(half).length > 0 && of(half).every((p) => p === '?'), 'held like its note, never NULL (sent to everyone)');
    assert.ok(fetchDeliveries(w.store, 'd-x', 0, 5000).changes.every((c) => ![other, half].includes(firstTextCell(decodeChange(c).pk)!)));
  } finally { w.done(); }
});

test('held "?" rows of a refused creation are purged, never released', async () => {
  const w = world();
  try {
    let u = '';
    const v = dbv(w.RD.db);
    u = await w.note(w.RD, 'split');
    updateEntry(w.RD.db, { ulid: u, title: 'split, edited' });
    const all = readOwnChanges(w.RD.db, v);
    const cut = all.map(decodeChange).findIndex((c) => c.table === 'entries' && c.cid === 'project_ulid');
    w.RD.push({ changes: all.slice(0, cut) });
    assert.ok(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`) > 0, 'the first half is held');
    const res = w.RD.push({ changes: all.slice(cut) });
    assert.equal(res.refused[0].key, 'note.create');
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`), 0, 'purged');
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_deliveries WHERE origin = 'd-rd'`), 0);
    assert.equal(count(w.store, `SELECT COUNT(*) n FROM po_refused_notes WHERE ulid = ? AND device_id = 'd-rd' AND key = 'note.create'`, u), 1);
    // A later accepted batch releases nothing of it, and no write-back touches the sender's note (R-13).
    await w.note(w.N, 'later');
    w.N.push();
    for (const m of [w.N, w.M]) { m.pull(); assert.equal(titleOf(m.db, u), undefined); }
    w.RD.pull();
    assert.equal(titleOf(w.RD.db, u), 'split, edited', 'the sender keeps its whole note');
    assert.ok(w.RD.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ?`).get(u), 'with its refs');
  } finally { w.done(); }
});

/**
 * The perf harness: one long-lived store fed consecutive 2000-change batches from
 * a Contributor, as in production. Each batch: own edits and creations (allowed),
 * plus edits of `refusedNotes` of the Owner's notes (refused, written back).
 * Returns per-run timings after WARM warm-ups (the JIT's, not the steady state).
 */
async function perfRuns(refusedNotes: number, RUNS = 5, WARM = 10) {
  const w = world();
  try {
    const theirs: string[] = [], mine: string[] = [];
    for (let i = 0; i < refusedNotes; i++) theirs.push(await w.note(w.N, `perf theirs ${i}`));
    w.N.push(); w.R.pull();
    for (let i = 0; i < 30; i++) mine.push(await w.note(w.R, `perf mine ${i}`));
    w.R.push();
    const runs: Array<{ classifyMs: number; stampMs: number; writeBackMs: number; refusedCells: number; refusedGroups: number }> = [];
    for (let k = 0; k < WARM + RUNS; k++) {
      const v = dbv(w.R.db);
      for (const u of theirs) updateEntry(w.R.db, { ulid: u, title: `${u} ${k}` });
      for (const u of mine) updateEntry(w.R.db, { ulid: u, title: `${u} ${k}` });
      for (let i = 0; readOwnChanges(w.R.db, v).length < 2000; i++) await w.note(w.R, `perf new ${k}.${i}`);
      const batch = readOwnChanges(w.R.db, v).slice(0, 2000);
      const timing = { stampMs: -1, classifyMs: -1, writeBackMs: -1 };
      const res = acceptChanges(w.store, 'd-r', batch, { timing });
      const refusedKeys = new Set(res.refused.map((r) => `${r.site_id}:${r.db_version}`));
      const refusedCells = batch.map(decodeChange).filter((c) => refusedKeys.has(groupKey(c))).length;
      assert.equal(res.refused.length, refusedNotes, `round ${k}: one refused group per edit of the Owner's notes`);
      assert.equal(res.accepted + refusedCells, 2000, `round ${k}: every cell accepted or refused`);
      if (k >= WARM) runs.push({ ...timing, refusedCells, refusedGroups: res.refused.length });
      // The rest of the last note, untimed (as the courier's next POST): otherwise each
      // round leaves a half note held ('?') and R3's held sweep grows with the rounds.
      acceptChanges(w.store, 'd-r', readOwnChanges(w.R.db, v).slice(2000));
    }
    return runs;
  } finally { w.done(); }
}
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

test('an all-allowed 2000-change batch: classify + stamp < 5 ms', async () => {
  const runs = await perfRuns(0);
  const ms = runs.map((r) => r.classifyMs + r.stampMs);
  console.log(`2000 allowed changes x ${runs.length}: classify+stamp median ${median(ms).toFixed(2)} ms (runs ${runs.map((r) => `${r.classifyMs.toFixed(2)}+${r.stampMs.toFixed(2)}`).join(', ')})`);
  assert.ok(median(ms) < 5, `R4+R3 took ${median(ms).toFixed(2)} ms`);
});

test('R6 write-back: < 0.25 ms per refused cell', async () => {
  const runs = await perfRuns(5);
  const per = runs.map((r) => r.writeBackMs / r.refusedCells);
  console.log(`2000 changes x ${runs.length} (${runs[0].refusedGroups} refused groups, ${runs[0].refusedCells} refused cells): write-back median ${median(per).toFixed(3)} ms per refused cell (runs ${runs.map((r) => `${r.writeBackMs.toFixed(2)}/${r.refusedCells}`).join(', ')})`);
  assert.ok(median(per) < 0.25, `write-back took ${median(per).toFixed(3)} ms per refused cell`);
});
