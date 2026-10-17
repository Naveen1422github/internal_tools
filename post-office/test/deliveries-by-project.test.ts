// RnR R3: a team project's changes reach only devices holding note.view in it.
import { test } from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { addEntryAsync, updateEntry, initModule, setAllocator, readOwnChanges, applyChanges, decodeChange, newUlid, type WireChange } from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries, lastSeq } from '../src/deliveries.js';
import { registerProject, openStore, closeStore, getMeta, type Store } from '../src/store.js';
import { setProjectMember } from '../src/access.js';

const TABLES = ['entries', 'refs', 'entry_modules', 'entry_revisions'];

function member(store: Store, id: string): void {
  store.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
}
function project(store: Store, code: string, creator: string): string {
  return registerProject(store, { ulid: newUlid(), name: `Project ${code}`, code }, creator).ulid;
}
let n = 0;
/** A note with a ref, a module and revisions; `projectUlid` is set as a laptop would (a column change). */
async function note(db: Database.Database, title: string, projectUlid: string | null): Promise<string> {
  setAllocator({ allocate: async () => ++n });
  const r = await addEntryAsync(db, {
    type: 'decision', title, summary: `${title} s`, description: `${title} body`, module: 'm',
    refs: [{ ref_type: 'file', ref_value: `${title}.ts` }],
  });
  if (projectUlid) db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(projectUlid, r.ulid);
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
    store.prepare(`DELETE FROM po_meta WHERE key = 'deliveries_stamped'`).run();
    closeStore(store);

    db = openStore(path);
    assert.ok(getMeta(db, 'deliveries_stamped'));
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

test('stamping 2000 changes adds < 5 ms', async () => {
  const la = laptop();
  try {
    const A = newUlid();
    let wire: WireChange[] = [];
    for (let i = 0; wire.length < 2000; i++) {
      await note(la.db, `perf ${i}`, i % 2 ? A : null);
      wire = readOwnChanges(la.db, 0);
    }
    wire = wire.slice(0, 2000);
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    // Whole acceptChanges, with vs without stamping: logged only, disk noise here is tens of ms.
    const accept = (stamp: boolean): number => {
      const { store, cleanup } = tempStore();
      try {
        const t0 = performance.now();
        acceptChanges(store, 'd-a', wire, { stamp });
        return performance.now() - t0;
      } finally { cleanup(); }
    };
    // The extra itself, timed inside acceptChanges: the pre-apply guess + stampProjects.
    // (The extra RECORD column is one more bound value per insert, inside the logged totals.)
    const extraOnce = (): number => {
      const { store, cleanup } = tempStore();
      try {
        const timing = { stampMs: -1 };
        acceptChanges(store, 'd-a', wire, { timing });
        assert.ok((store.prepare(`SELECT COUNT(*) n FROM po_deliveries WHERE project_ulid = ?`).get(A) as { n: number }).n > 0, 'it did real work');
        return timing.stampMs;
      } finally { cleanup(); }
    };
    for (let i = 0; i < 3; i++) { accept(true); accept(false); extraOnce(); } // warm up (JIT)
    const withS: number[] = [], without: number[] = [], extra: number[] = [];
    for (let i = 0; i < 5; i++) {
      if (i % 2) { without.push(accept(false)); withS.push(accept(true)); } else { withS.push(accept(true)); without.push(accept(false)); }
      extra.push(extraOnce());
    }
    console.log(`2000 changes: acceptChanges with ${median(withS).toFixed(2)} ms, without ${median(without).toFixed(2)} ms; R3 stamping ${median(extra).toFixed(2)} ms (runs ${extra.map((x) => x.toFixed(2)).join(', ')})`);
    assert.ok(median(extra) < 5, `stamping added ${median(extra).toFixed(2)} ms`);
  } finally { setAllocator(null); la.cleanup(); }
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
    la.db.prepare(`UPDATE entries SET project_ulid = ? WHERE ulid = ?`).run(A, r.ulid);
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
