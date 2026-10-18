// RnR R3: a team project's changes reach only devices holding note.view in it.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { addEntryAsync, createProject, updateEntry, initModule, migrate, migrateTo, enableSync, isCrsqliteLoaded, setAllocator, readOwnChanges, applyChanges, decodeChange, newUlid, type WireChange } from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { budget } from './perf.js'; // strict: COLLAB_PERF=1 npx tsx --test --test-concurrency=1 test/<file>.test.ts
import { acceptChanges, fetchDeliveries, lastSeq } from '../src/deliveries.js';
import { registerProject, openStore, closeStore, getMeta, allocate, type Store } from '../src/store.js';
import { setProjectMember as grant, assignNewMemberOfficeRole } from '../src/access.js';

const TABLES = ['entries', 'refs', 'entry_modules', 'entry_revisions'];

function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
  assignNewMemberOfficeRole(store, id); // as addMember does: the first is Office admin (S2: modules need office keys)
}
// Each team project's office: its notes take the series and number the office allocates (R-28).
const offices = new Map<string, { store: Store; code: string }>();
function project(store: Store, code: string, creator: string): string {
  const ulid = registerProject(store, { ulid: newUlid(), name: `Project ${code}`, code }, creator).ulid;
  offices.set(ulid, { store, code });
  return ulid;
}
/** A laptop note set into a team project: its series and the office's number, as allocate gives it. */
function intoProject(db: Database.Database, u: string, projectUlid: string): void {
  const o = offices.get(projectUlid);
  if (o) db.prepare(`UPDATE entries SET series = ?, id = ? WHERE ulid = ?`).run(o.code, allocate(o.store, u, null, o.code), u);
  db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(projectUlid, u);
}
let n = 0;
/** A note with a ref, a module and revisions; `projectUlid` is set as a laptop would (a column change). */
async function note(db: Database.Database, title: string, projectUlid: string | null): Promise<string> {
  setAllocator({ allocate: async () => ++n });
  const r = await addEntryAsync(db, {
    type: 'decision', title, summary: `${title} s`, description: `${title} body`, module: 'm',
    refs: [{ ref_type: 'file', ref_value: `${title}.ts` }],
  });
  if (projectUlid) intoProject(db, r.ulid, projectUlid);
  updateEntry(db, { ulid: r.ulid, description: `${title} body, edited` }); // gives entry_revisions rows
  return r.ulid;
}
/** The entry a delivered change belongs to, resolved in `db` (the office). null = modules. */
function ownerOf(db: Store, w: WireChange): string | null {
  const c = decodeChange(w);
  if (c.table === 'modules') return null;
  const k = (db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(c.pk) as { cell: string }).cell;
  if (c.table !== 'entry_revisions') return k;
  return (db.prepare(`SELECT entry_ulid FROM entry_revisions WHERE rev_id = ?`).get(k) as { entry_ulid: string }).entry_ulid;
}
const tablesOf = (ws: WireChange[]) => new Set(ws.map((w) => decodeChange(w).table));
/** These tests are about stamping, not replay: the new member counts as already replayed (no barrier). */
const setProjectMember: typeof grant = (db, ...a) => { grant(db, ...a); db.prepare(`DELETE FROM po_replays`).run(); };
const fetchAll = (s: Store, d: string, after = 0) => fetchDeliveries(s, d, after, 5000);

test('member of A never receives B rows: entries, refs, entry_modules, entry_revisions', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop(), lb = laptop();
  try {
    for (const d of ['d-a', 'd-b', 'd-c']) member(store, d);
    const A = project(store, 'AA', 'd-a'), B = project(store, 'BB', 'd-b');
    setProjectMember(store, 'd-a', A, 'd-c', 'Reader');
    const ua = await note(la.db, 'in A', A);
    const ub = await note(lb.db, 'in B', B);
    const sentA = readOwnChanges(la.db, 0), sentB = readOwnChanges(lb.db, 0);
    for (const t of TABLES) assert.ok(tablesOf(sentB).has(t), `the B batch has ${t} rows (else the test proves nothing for it)`);
    acceptChanges(store, 'd-a', sentA);
    acceptChanges(store, 'd-b', sentB);

    const c = fetchAll(store, 'd-c');
    assert.equal(c.lastSeq, lastSeq(store), 'the bookmark passes filtered rows');
    const owners = new Set(c.changes.map((w) => ownerOf(store, w)));
    assert.ok(!owners.has(ub), 'd-c (A only) gets nothing of B');
    assert.ok(owners.has(ua));
    for (const t of TABLES) assert.ok(tablesOf(c.changes).has(t), `d-c gets A's ${t} rows`);
    for (const w of c.changes) assert.ok(!decodeChange(w).val?.toString().includes(B), 'no cell names project B');

    const a = fetchAll(store, 'd-a');
    assert.ok(!a.changes.some((w) => ownerOf(store, w) === ub), 'd-a (Owner of A) gets nothing of B');
    const b = fetchAll(store, 'd-b');
    assert.ok(!b.changes.some((w) => ownerOf(store, w) === ua), 'd-b (Owner of B) gets nothing of A');
    assert.ok(!b.changes.some((w) => ownerOf(store, w) === ub), 'and never its own back');

    member(store, 'd-x');
    const x = fetchAll(store, 'd-x');
    assert.ok(!x.changes.some((w) => [ua, ub].includes(ownerOf(store, w) as string)), 'a non-member gets no team rows');
    assert.equal(x.lastSeq, lastSeq(store));
    assert.equal(x.more, false);
  } finally { setAllocator(null); la.cleanup(); lb.cleanup(); cleanup(); }
});

test('legacy E shared-module rows and modules rows still reach every member', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop();
  try {
    for (const d of ['d-a', 'd-x']) member(store, d);
    initModule(la.db, { slug: 'm', name: 'M' });
    const ue = await note(la.db, 'legacy', null);
    const sent = readOwnChanges(la.db, 0);
    assert.ok(tablesOf(sent).has('modules'));
    acceptChanges(store, 'd-a', sent);
    const x = fetchAll(store, 'd-x');
    assert.equal(x.changes.length, sent.length, 'every row, as before RnR');
    for (const t of [...TABLES, 'modules']) assert.ok(tablesOf(x.changes).has(t), `${t} rows reach a non-project member`);
    const bad = x.changes.map((w) => [decodeChange(w).table, ownerOf(store, w)]).filter(([, o]) => o !== ue && o !== null);
    assert.deepEqual(bad, [], 'only the legacy note and modules rows');
    assert.equal((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid IS NOT NULL`).get() as { n: number }).n, 0);
  } finally { setAllocator(null); la.cleanup(); cleanup(); }
});

test('orphan ref held as "?" and released when its entry arrives', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop();
  try {
    for (const d of ['d-a', 'd-c', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    setProjectMember(store, 'd-a', A, 'd-c', 'Reader');
    const ua = await note(la.db, 'orphaned', A);
    const sent = readOwnChanges(la.db, 0);
    const isEntry = (w: WireChange) => decodeChange(w).table === 'entries';
    const children = sent.filter((w) => !isEntry(w) && decodeChange(w).table !== 'modules');
    const entry = sent.filter(isEntry);
    assert.ok(children.some((w) => decodeChange(w).table === 'refs'));

    acceptChanges(store, 'd-a', children);
    const held = store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`).get() as { n: number };
    assert.equal(held.n, children.length, 'every child row waits for its entry');
    const c1 = fetchAll(store, 'd-c'), x1 = fetchAll(store, 'd-x');
    assert.deepEqual(c1.changes, [], 'a held row goes to nobody, members included');
    assert.deepEqual(x1.changes, []);
    assert.equal(c1.lastSeq, lastSeq(store), 'the bookmark still moves past held rows');

    acceptChanges(store, 'd-a', entry);
    const c2 = fetchAll(store, 'd-c', c1.lastSeq);
    const got = tablesOf(c2.changes);
    for (const t of TABLES) assert.ok(got.has(t), `after the entry arrives d-c gets ${t} rows, from its old bookmark`);
    assert.equal(c2.changes.length, sent.length - sent.filter((w) => decodeChange(w).table === 'modules').length);
    assert.ok(c2.changes.every((w) => ownerOf(store, w) === ua));
    assert.equal((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = '?'`).get() as { n: number }).n, 0);
    assert.deepEqual(fetchAll(store, 'd-x', x1.lastSeq).changes, [], 'released rows still skip non-members');

    // The released rows still apply cleanly on a member laptop.
    const lc = laptop();
    try {
      lc.db.transaction(() => applyChanges(lc.db, c2.changes.map(decodeChange)))();
      assert.equal((lc.db.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid = ?`).get(ua) as { n: number }).n, 1);
    } finally { lc.cleanup(); }
  } finally { setAllocator(null); la.cleanup(); cleanup(); }
});

test('first insert records the note owner from the authenticated origin, not the author cell', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop(), lb = laptop();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    const u = await note(la.db, 'mine', null);
    la.db.prepare(`UPDATE entries SET author = 'd-b' WHERE ulid = ?`).run(u); // a forged author cell
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    const owner = () => (store.prepare(`SELECT device_id FROM po_note_owners WHERE ulid = ?`).get(u) as { device_id: string } | undefined)?.device_id;
    assert.equal(owner(), 'd-a');

    // b receives the note, edits it, sends: the owner does not change.
    const got = fetchAll(store, 'd-b');
    lb.db.transaction(() => applyChanges(lb.db, got.changes.map(decodeChange)))();
    const top = (lb.db.prepare(`SELECT COALESCE(MAX(db_version), 0) v FROM crsql_changes`).get() as { v: number }).v;
    lb.db.prepare(`UPDATE entries SET title = 'edited by b' WHERE ulid = ?`).run(u);
    const edit = readOwnChanges(lb.db, top);
    assert.ok(edit.length > 0);
    acceptChanges(store, 'd-b', edit);
    assert.equal(owner(), 'd-a');
  } finally { setAllocator(null); la.cleanup(); lb.cleanup(); cleanup(); }
});

test('backfill stamps pre-upgrade rows once', async () => {
  const { store, path, cleanup } = tempStore();
  const la = laptop();
  let db: Store = store;
  try {
    for (const d of ['d-a', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    await note(la.db, 'old team note', A);
    await note(la.db, 'old legacy note', null);
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    // Turn the store back into a pre-upgrade one: no column, no index, no meta.
    store.exec(`DROP INDEX idx_po_deliveries_project; ALTER TABLE po_deliveries DROP COLUMN project_ulid;`);
    store.prepare(`DELETE FROM po_meta WHERE key IN ('deliveries_stamped', 'deliveries_stamped_upto')`).run();
    closeStore(store);

    db = openStore(path);
    assert.ok(getMeta(db, 'deliveries_stamped'));
    assert.equal(getMeta(db, 'deliveries_stamped_upto'), String(lastSeq(db)));
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_po_deliveries_project'`).get());
    const count = (where: string) => (db.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE ${where}`).get() as { n: number }).n;
    assert.ok(count(`project_ulid = '${A}'`) > 0, 'team rows stamped with their project');
    assert.ok(count(`project_ulid IS NULL AND tbl = 'entries'`) > 0, 'legacy rows stay open to all');
    assert.equal(count(`project_ulid = '?'`), 0);
    assert.ok(!fetchAll(db, 'd-x').changes.some((w) => decodeChange(w).val === A), 'pre-upgrade team rows no longer reach non-members');

    // Once: a later open does not stamp again.
    db.prepare(`UPDATE po_deliveries SET project_ulid = 'ZZ' WHERE project_ulid = ?`).run(A);
    closeStore(db);
    db = openStore(path);
    assert.ok(count(`project_ulid = 'ZZ'`) > 0);
  } finally { setAllocator(null); la.cleanup(); try { closeStore(db); } catch { /* closed */ } cleanup(); }
});

test('rollback: rows an older office binary wrote after the upgrade are stamped on the next open', async () => {
  const { store, path, cleanup } = tempStore();
  const la = laptop();
  let db: Store = store;
  try {
    for (const d of ['d-a', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    await note(la.db, 'stamped team note', A);
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    const upto = lastSeq(store);
    assert.equal(getMeta(store, 'deliveries_stamped_upto'), String(upto), 'acceptChanges moves the watermark');
    // A row below the watermark that was stamped NULL stays NULL: it was stamped.
    const legit = (store.prepare(`SELECT seq FROM po_deliveries WHERE project_ulid = ? ORDER BY seq LIMIT 1`).get(A) as { seq: number }).seq;
    store.prepare(`UPDATE po_deliveries SET project_ulid = NULL WHERE seq = ?`).run(legit);
    // An older binary records a later team note without stamping it.
    const top = (la.db.prepare(`SELECT COALESCE(MAX(db_version), 0) v FROM crsql_changes`).get() as { v: number }).v;
    const u = await note(la.db, 'written under the old binary', A);
    acceptChanges(store, 'd-a', readOwnChanges(la.db, top), { stamp: false });
    const ofNote = (s: Store) => fetchAll(s, 'd-x', upto).changes.filter((w) => ownerOf(s, w) === u);
    assert.ok(ofNote(store).length > 0, 'unstamped rows reach a non-member (the leak)');
    assert.equal(getMeta(store, 'deliveries_stamped_upto'), String(upto), 'the old binary did not move the watermark');
    closeStore(store);

    db = openStore(path);
    assert.equal(ofNote(db).length, 0, 'after reopening, a non-member gets nothing of the note');
    const count = (where: string) => (db.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE ${where}`).get() as { n: number }).n;
    assert.equal(count(`seq > ${upto} AND project_ulid IS NULL`), 0, 'every row past the watermark is stamped');
    assert.ok(count(`seq > ${upto} AND project_ulid = '${A}'`) > 0);
    assert.equal(count(`seq = ${legit} AND project_ulid IS NULL`), 1, 'rows below the watermark are left alone');
    assert.equal(getMeta(db, 'deliveries_stamped_upto'), String(lastSeq(db)));
    assert.ok(fetchAll(db, 'd-a', upto).changes.length === 0, 'the creator sent them: nothing echoes back');
  } finally { setAllocator(null); la.cleanup(); try { closeStore(db); } catch { /* closed */ } cleanup(); }
});

test('a store stamped by the first RnR binary (boolean only) starts its watermark at its last seq', async () => {
  const { store, path, cleanup } = tempStore();
  const la = laptop();
  let db: Store = store;
  try {
    for (const d of ['d-a', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    await note(la.db, 'team note', A);
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    store.prepare(`UPDATE po_deliveries SET project_ulid = NULL WHERE project_ulid = ?`).run(A); // "stamped NULL" by that binary
    store.prepare(`DELETE FROM po_meta WHERE key = 'deliveries_stamped_upto'`).run();
    assert.ok(getMeta(store, 'deliveries_stamped'));
    closeStore(store);
    db = openStore(path);
    assert.equal(getMeta(db, 'deliveries_stamped_upto'), String(lastSeq(db)));
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = ?`).get(A) as { n: number }).n, 0, 'nothing restamped');
  } finally { setAllocator(null); la.cleanup(); try { closeStore(db); } catch { /* closed */ } cleanup(); }
});

test('stamping 2000 changes adds < 5 ms', async () => {
  // One long-lived store fed consecutive 2000-change requests, as in production
  // (prepared statements warm). Requests cut through notes, so held rows and
  // releases are exercised: the worst case.
  const RUNS = 9, WARM = 3;
  const la = laptop();
  const { store, cleanup } = tempStore();
  try {
    member(store, 'd-a'); // S2: the sender's modules cells are judged against its office keys
    // Each note is written as production writes it: its project in the INSERT, one laptop
    // transaction (a solo project here: the office doesn't know it, so nothing is judged).
    const A = createProject(la.db, { name: 'Perf', code: 'PF' }).ulid;
    let wire: WireChange[] = [];
    for (let i = 0; wire.length < 2000 * (RUNS + WARM); i++) {
      setAllocator({ allocate: async () => ++n });
      await addEntryAsync(la.db, { type: 'decision', title: `perf ${i}`, summary: `perf ${i} s`, description: `perf ${i} body`, module: 'm',
        refs: [{ ref_type: 'file', ref_value: `perf ${i}.ts` }], project: i % 2 ? A : 'none' });
      if (i % 20 === 19) wire = readOwnChanges(la.db, 0);
    }
    const ms: number[] = [];
    for (let k = 0; k < RUNS + WARM; k++) {
      const timing = { stampMs: -1 };
      const r = acceptChanges(store, 'd-a', wire.slice(k * 2000, (k + 1) * 2000), { timing });
      assert.equal(r.accepted, 2000, JSON.stringify(r.refused));
      if (k >= WARM) ms.push(timing.stampMs);
    }
    assert.ok((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = ?`).get(A) as { n: number }).n > 0, 'it did real work');
    const median = [...ms].sort((x, y) => x - y)[Math.floor(ms.length / 2)];
    console.log(`2000 changes x ${RUNS}: R3 stamping median ${median.toFixed(2)} ms (runs ${ms.map((x) => x.toFixed(2)).join(', ')})`);
    assert.ok(median < budget(5), `stamping added ${median.toFixed(2)} ms (limit ${budget(5)})`);
  } finally { setAllocator(null); la.cleanup(); cleanup(); }
});

test("the office's own merge rows of a team note are stamped too", async () => {
  const { store, cleanup } = tempStore();
  const la = laptop(), lb = laptop();
  try {
    for (const d of ['d-a', 'd-b', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    setProjectMember(store, 'd-a', A, 'd-b', 'Editor');
    setAllocator({ allocate: async () => ++n });
    const r = await addEntryAsync(la.db, { type: 'decision', title: 't', summary: 's', description: 'p1\n\np2', module: 'm' });
    intoProject(la.db, r.ulid, A);
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    const got = fetchAll(store, 'd-b');
    lb.db.transaction(() => applyChanges(lb.db, got.changes.map(decodeChange)))();
    updateEntry(la.db, { ulid: r.ulid, description: 'P1 from a\n\np2' });
    updateEntry(lb.db, { ulid: r.ulid, description: 'p1\n\nP2 from b' });
    const x0 = fetchAll(store, 'd-x').lastSeq;
    acceptChanges(store, 'd-a', readOwnChanges(la.db, 0));
    assert.equal(acceptChanges(store, 'd-b', readOwnChanges(lb.db, 0)).officeWrote, true, 'the office merged');
    const own = store.prepare(`SELECT project_ulid p, COUNT(*) n FROM po_deliveries WHERE origin = 'post-office' GROUP BY p`).all();
    assert.deepEqual(own, [{ p: A, n: (own as any[])[0]?.n }], 'every office-written row carries the project');
    assert.deepEqual(fetchAll(store, 'd-x', x0).changes, [], 'a non-member gets none of it');
    assert.ok(fetchAll(store, 'd-b', got.lastSeq).changes.length > 0, 'the member gets the merge');
  } finally { setAllocator(null); la.cleanup(); lb.cleanup(); cleanup(); }
});

// Fix round 1: a note's project cell can reach the office in a later request than its other cells.
const cellAt = (ws: WireChange[], table: string, cid: string) => ws.findIndex((w) => { const c = decodeChange(w); return c.table === table && c.cid === cid; });

test('a team note split just before its project cell is held until that cell arrives', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop();
  try {
    for (const d of ['d-a', 'd-c', 'd-x']) member(store, d);
    const A = project(store, 'AA', 'd-a');
    setProjectMember(store, 'd-a', A, 'd-c', 'Reader');
    const u = await note(la.db, 'SECRET', A);
    const w = readOwnChanges(la.db, 0);
    const cut = cellAt(w, 'entries', 'project_ulid');
    assert.ok(cut > 0);
    acceptChanges(store, 'd-a', w.slice(0, cut));
    const x1 = fetchAll(store, 'd-x'), c1 = fetchAll(store, 'd-c');
    assert.ok(!x1.changes.some((c) => ownerOf(store, c) === u), 'a non-member gets nothing of the first half');
    assert.ok(!c1.changes.some((c) => ownerOf(store, c) === u), 'nor does a member, until the project is known');
    acceptChanges(store, 'd-a', w.slice(cut));
    assert.ok(!fetchAll(store, 'd-x', x1.lastSeq).changes.some((c) => ownerOf(store, c) === u), 'still nothing for a non-member');
    const c2 = fetchAll(store, 'd-c', c1.lastSeq);
    const want = w.filter((c) => decodeChange(c).table !== 'modules').length;
    assert.equal(c2.changes.filter((c) => ownerOf(store, c) === u).length, want, 'the member gets every row, from its old bookmark');
  } finally { setAllocator(null); la.cleanup(); cleanup(); }
});

test('a legacy note split the same way reaches everyone once its project_ulid = NULL cell arrives', async () => {
  const { store, cleanup } = tempStore();
  const la = laptop();
  try {
    member(store, 'd-x');
    const u = await note(la.db, 'legacy split', null);
    const w = readOwnChanges(la.db, 0);
    const cut = cellAt(w, 'entries', 'project_ulid');
    assert.ok(cut > 0);
    assert.equal(decodeChange(w[cut]).val, null, 'a post-0009 legacy insert sends project_ulid = NULL');
    acceptChanges(store, 'd-a', w.slice(0, cut));
    const x1 = fetchAll(store, 'd-x');
    assert.ok(!x1.changes.some((c) => ownerOf(store, c) === u), 'held while its project is unknown');
    acceptChanges(store, 'd-a', w.slice(cut));
    const x2 = fetchAll(store, 'd-x', x1.lastSeq);
    assert.equal(x2.changes.filter((c) => ownerOf(store, c) === u).length, w.filter((c) => decodeChange(c).table !== 'modules').length);
  } finally { setAllocator(null); la.cleanup(); cleanup(); }
});

test('a note written before 0009 (no project cell anywhere) still reaches everyone, and so do its edits (rule 2)', async () => {
  const { store, cleanup } = tempStore();
  const t = laptop(); // only for a temp dir; the old laptop is built by hand below
  const old = new Database(t.path.replace(/collab\.db$/, 'old.db'));
  try {
    member(store, 'd-x');
    migrateTo(old, '0008_revision_author');
    enableSync(old);
    setAllocator({ allocate: async () => ++n });
    const r = await addEntryAsync(old, { type: 'decision', title: 'pre 0009', summary: 's', module: 'm', refs: [{ ref_type: 'file', ref_value: 'old.ts' }] });
    migrate(old);
    const w = readOwnChanges(old, 0);
    assert.equal(cellAt(w, 'entries', 'project_ulid'), -1, 'an old note has no project cell');
    assert.equal(cellAt(w, 'entries', 'series'), -1);
    acceptChanges(store, 'd-a', w);
    const x1 = fetchAll(store, 'd-x');
    assert.equal(x1.changes.length, w.length, 'every row reaches a non-project member');
    const top = (old.prepare(`SELECT COALESCE(MAX(db_version), 0) v FROM crsql_changes`).get() as { v: number }).v;
    updateEntry(old, { ulid: r.ulid, title: 'pre 0009, edited' });
    const edit = readOwnChanges(old, top);
    acceptChanges(store, 'd-a', edit);
    assert.equal(fetchAll(store, 'd-x', x1.lastSeq).changes.length, edit.length, 'and so does a later edit');
    assert.equal((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid IS NOT NULL`).get() as { n: number }).n, 0);
  } finally {
    setAllocator(null);
    try { if (isCrsqliteLoaded(old)) old.prepare('SELECT crsql_finalize()').get(); old.close(); } catch { /* closed */ }
    t.cleanup(); cleanup();
  }
});
