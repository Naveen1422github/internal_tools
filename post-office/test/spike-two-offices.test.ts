// SPIKE S2 (docs/superpowers/plans/2026-10-05-collab-join-spikes.md): one notebook
// exchanging changes with TWO post offices through cr-sqlite, each office fed
// through a per-module filter that copies the courier's rule (courier/src/engine.ts
// push() / placeOf()). Evidence, not product code: tests named "(observed)"
// assert what really happens so they stay green and document reality.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  addEntryAsync, setAllocator, updateEntry, deleteEntry, reassignModule, upsertModule,
  readOwnChanges, applyChanges, decodeChange, reindexFts, entryUlidOf, ownerOf,
  type WireChange,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

type DB = ReturnType<typeof laptop>['db'];
type Office = ReturnType<typeof tempStore> & { name: string; modules: Set<string> };

const changeKey = (w: WireChange) => `${w.table}|${w.pk}|${w.cid}`;

/** courier placeOf(): the note a change belongs to and that note's CURRENT primary module; for a modules row, its slug. */
function placeOf(db: DB, w: WireChange): { ulid: string | null; module: string | null } {
  const pk = Buffer.from(w.pk, 'base64');
  if (w.table === 'modules') {
    const r = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
    return { ulid: null, module: r ? String(r.cell) : null };
  }
  const ulid = entryUlidOf(db, w.table, pk);
  if (!ulid) return { ulid: null, module: null };
  const e = db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(ulid) as { module: string | null } | undefined;
  return { ulid, module: e?.module ?? null };
}

/** A laptop with one notebook and one sent/received bookmark PER OFFICE. */
function node(dev: string) {
  const h = laptop();
  const sent = new Map<string, number>();
  const recv = new Map<string, number>();
  /** courier push(): own changes after this office's bookmark whose note's primary module is in the office's set; whole note on a move in. */
  const selectFor = (o: Office, since: number) => {
    const out = new Map<string, WireChange>();
    const moved = new Set<string>(), created = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(h.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, module } = placeOf(h.db, w);
      if (!module || !o.modules.has(module)) continue;
      out.set(changeKey(w), w);
      if (w.table === 'entries' && ulid) {
        if (w.cid === 'created_at') created.add(ulid);
        if (w.cid === 'module') moved.add(ulid);
      }
    }
    for (const u of created) moved.delete(u);
    if (moved.size > 0) {
      for (const w of readOwnChanges(h.db, 0)) {
        if (w.db_version > top) continue;
        const { ulid } = placeOf(h.db, w);
        if (ulid && moved.has(ulid)) out.set(changeKey(w), w);
      }
    }
    return { batch: [...out.values()], top };
  };
  return {
    ...h, dev, sent, selectFor,
    push(o: Office) {
      const { batch, top } = selectFor(o, sent.get(o.name) ?? 0);
      const r = acceptChanges(o.store, dev, batch);
      sent.set(o.name, top);
      return { ...r, sentCount: batch.length };
    },
    pull(o: Office) {
      let after = recv.get(o.name) ?? 0;
      for (;;) {
        const r = fetchDeliveries(o.store, dev, after, 1000);
        if (r.changes.length) h.db.transaction(() => reindexFts(h.db, applyChanges(h.db, r.changes.map(decodeChange)).entryUlids))();
        after = r.lastSeq;
        if (!r.more) break;
      }
      recv.set(o.name, after);
    },
  };
}

function office(name: string, modules: string[]): Office {
  return { ...tempStore(), name, modules: new Set(modules) };
}

let nextNo = 0;
async function note(db: DB, title: string, module: string | null, extra: Record<string, unknown> = {}) {
  const r = await addEntryAsync(db, { type: 'decision', title, summary: `${title} summary`, description: `${title} body`, ...(module ? { module } : {}), ...extra } as any);
  const ulid = ownerOf(db, r.id)!.ulid as string;
  return { id: r.id, ulid };
}

// ---- queries the assertions are made with ----
const titles = (db: DB | Store) =>
  (db.prepare(`SELECT title FROM entries ORDER BY title`).all() as Array<{ title: string }>).map((r) => r.title);
const entryModules = (db: DB | Store) =>
  (db.prepare(`SELECT DISTINCT module FROM entries ORDER BY module`).all() as Array<{ module: string | null }>).map((r) => r.module);
const linkModules = (db: DB | Store) =>
  (db.prepare(`SELECT DISTINCT module FROM entry_modules ORDER BY module`).all() as Array<{ module: string }>).map((r) => r.module);
const moduleSlugs = (db: DB | Store) =>
  (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
/** Side-table rows whose entry_ulid has no entries row here (an orphan = information about a note this place doesn't hold). */
const orphans = (db: DB | Store) => ({
  refs: (db.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid NOT IN (SELECT ulid FROM entries)`).get() as any).n,
  entry_modules: (db.prepare(`SELECT COUNT(*) n FROM entry_modules WHERE entry_ulid NOT IN (SELECT ulid FROM entries)`).get() as any).n,
  entry_revisions: (db.prepare(`SELECT COUNT(*) n FROM entry_revisions WHERE entry_ulid NOT IN (SELECT ulid FROM entries)`).get() as any).n,
});
const rowOf = (db: DB | Store, ulid: string) =>
  db.prepare(`SELECT id, title, summary, description, module, deleted_at FROM entries WHERE ulid = ?`).get(ulid) as any;

function world() {
  nextNo = 0;
  setAllocator({ allocate: async () => ++nextNo });
  const A = office('A', ['alpha']);
  const B = office('B', ['beta']);
  const L1 = node('dev-l1'), L2 = node('dev-l2'), L3 = node('dev-l3');
  for (const slug of ['alpha', 'beta', 'private']) upsertModule(L1.db, { slug, name: slug });
  return {
    A, B, L1, L2, L3,
    done() { setAllocator(null); for (const x of [L1, L2, L3]) x.cleanup(); A.cleanup(); B.cleanup(); },
  };
}

test('S2-1 isolation: each office holds only its own module; members pull only that', async () => {
  const w = world();
  try {
    const { A, B, L1, L2, L3 } = w;
    const a = await note(L1.db, 'a1', 'alpha', { refs: [{ ref_type: 'file', ref_value: 'src/a.ts' }] });
    const b = await note(L1.db, 'b1', 'beta', { refs: [{ ref_type: 'file', ref_value: 'src/b.ts' }] });
    const p = await note(L1.db, 'p1', 'private', { refs: [{ ref_type: 'file', ref_value: 'src/p.ts' }] });
    for (const n of [a, b, p]) updateEntry(L1.db, { id: n.id, description: 'edited' }); // entry_revisions rows
    L1.push(A); L1.push(B);

    assert.deepEqual(titles(A.store), ['a1']);
    assert.deepEqual(entryModules(A.store), ['alpha']);
    assert.deepEqual(linkModules(A.store), ['alpha']);
    assert.deepEqual(moduleSlugs(A.store), ['alpha']);
    assert.deepEqual(orphans(A.store), { refs: 0, entry_modules: 0, entry_revisions: 0 });
    assert.equal((A.store.prepare(`SELECT COUNT(*) n FROM refs`).get() as any).n, 1);
    assert.ok((A.store.prepare(`SELECT COUNT(*) n FROM entry_revisions WHERE entry_ulid = ?`).get(a.ulid) as any).n >= 2);

    assert.deepEqual(titles(B.store), ['b1']);
    assert.deepEqual(entryModules(B.store), ['beta']);
    assert.deepEqual(linkModules(B.store), ['beta']);
    assert.deepEqual(moduleSlugs(B.store), ['beta']);
    assert.deepEqual(orphans(B.store), { refs: 0, entry_modules: 0, entry_revisions: 0 });

    for (const s of [A.store, B.store]) assert.equal(rowOf(s, p.ulid), undefined, 'the private note reaches no office');

    L2.pull(A); L3.pull(B);
    assert.deepEqual(titles(L2.db), ['a1']);
    assert.deepEqual(moduleSlugs(L2.db), ['alpha']);
    assert.deepEqual(orphans(L2.db), { refs: 0, entry_modules: 0, entry_revisions: 0 });
    assert.deepEqual(titles(L3.db), ['b1']);
    assert.deepEqual(moduleSlugs(L3.db), ['beta']);
    assert.deepEqual(orphans(L3.db), { refs: 0, entry_modules: 0, entry_revisions: 0 });
  } finally { w.done(); }
});

test('S2-2 edits both ways converge and nothing crosses; received changes are never re-sent', async () => {
  const w = world();
  try {
    const { A, B, L1, L2, L3 } = w;
    const a = await note(L1.db, 'a1', 'alpha');
    const b = await note(L1.db, 'b1', 'beta');
    L1.push(A); L1.push(B); L2.pull(A); L3.pull(B);

    updateEntry(L2.db, { id: a.id, description: 'alpha edited on L2' });
    L2.push(A);
    L1.pull(A);
    assert.equal(rowOf(L1.db, a.ulid).description, 'alpha edited on L2');
    // L1 now holds L2's change, but it is not L1's own: neither office gets it from L1.
    assert.equal(L1.push(A).sentCount, 0);
    assert.equal(L1.push(B).sentCount, 0);

    updateEntry(L1.db, { id: b.id, description: 'beta edited on L1' });
    L1.push(A); L1.push(B);
    L3.pull(B); L2.pull(A);
    assert.equal(rowOf(L3.db, b.ulid).description, 'beta edited on L1');

    for (const [db, want] of [[A.store, ['a1']], [L2.db, ['a1']], [B.store, ['b1']], [L3.db, ['b1']]] as const) {
      assert.deepEqual(titles(db as any), want);
      assert.deepEqual(orphans(db as any), { refs: 0, entry_modules: 0, entry_revisions: 0 });
    }
    for (const db of [A.store, L2.db, L1.db]) assert.equal(rowOf(db, a.ulid).description, 'alpha edited on L2');
    for (const db of [B.store, L3.db, L1.db]) assert.equal(rowOf(db, b.ulid).description, 'beta edited on L1');
  } finally { w.done(); }
});

test('S2-3 bookmarks: a per-office "sent up to" loses nothing; a single shared one would skip the other team (observed)', async () => {
  const w = world();
  try {
    const { A, B, L1 } = w;
    await note(L1.db, 'x1', 'alpha'); await note(L1.db, 'y1', 'beta');
    await note(L1.db, 'x2', 'alpha'); await note(L1.db, 'y2', 'beta');
    L1.push(A);
    const aMark = L1.sent.get('A')!;
    await note(L1.db, 'y3', 'beta'); await note(L1.db, 'x3', 'alpha');
    L1.push(A);

    // Contrast: had B used A's bookmark (one bookmark for the notebook), y1/y2 would never be sent.
    const shared = L1.selectFor(B, aMark).batch;
    const sharedTitles = new Set(shared.filter((c) => c.table === 'entries' && c.cid === 'title').map((c) => c.val));
    assert.deepEqual([...sharedTitles].sort(), ['y3'], 'observed: a shared bookmark skips y1 and y2');

    L1.push(B); // B's own bookmark is still 0
    assert.deepEqual(titles(B.store), ['y1', 'y2', 'y3']);
    assert.deepEqual(titles(A.store), ['x1', 'x2', 'x3']);
    const again = L1.push(B);
    assert.equal(again.sentCount, 0, 're-pushing sends nothing');
    assert.equal(again.accepted, 0);
    assert.equal(L1.push(A).sentCount, 0);
  } finally { w.done(); }
});

test('S2-4 (observed): an alpha note\'s refs and secondary tags carry beta/private identifiers into office A', async () => {
  const w = world();
  try {
    const { A, B, L1, L2 } = w;
    const p = await note(L1.db, 'p4', 'private');
    const b = await note(L1.db, 'b4', 'beta');
    const a = await note(L1.db, 'a4', 'alpha', {
      modules: ['beta'], // secondary tag in team B's module
      refs: [{ ref_type: 'entry', ref_value: `E-${p.id}` }, { ref_type: 'entry', ref_value: `E-${b.id}` }],
    });
    L1.push(A); L1.push(B);

    // No beta/private NOTE reaches A (entries rows, their revisions, refs, module rows).
    assert.deepEqual(titles(A.store), ['a4']);
    assert.deepEqual(moduleSlugs(A.store), ['alpha']);
    assert.deepEqual(orphans(A.store), { refs: 0, entry_modules: 0, entry_revisions: 0 });

    // But rows OWNED by the alpha note carry the other notes' identities and B's slug:
    const refs = A.store.prepare(`SELECT ref_value, target_ulid FROM refs WHERE entry_ulid = ? ORDER BY ref_value`).all(a.ulid) as any[];
    assert.deepEqual(refs, [
      { ref_value: `E-${p.id}`, target_ulid: p.ulid },
      { ref_value: `E-${b.id}`, target_ulid: b.ulid },
    ].sort((x, y) => x.ref_value.localeCompare(y.ref_value)), 'observed: private and beta note numbers + ULIDs reach A');
    const tags = A.store.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY module`).all(a.ulid);
    assert.deepEqual(tags, [{ module: 'alpha', is_primary: 1 }, { module: 'beta', is_primary: 0 }], 'observed: the slug "beta" reaches A');

    // B learns nothing about a4 (its rows follow a4's primary module, alpha).
    assert.equal((B.store.prepare(`SELECT COUNT(*) n FROM entry_modules WHERE entry_ulid = ?`).get(a.ulid) as any).n, 0);
    assert.equal((B.store.prepare(`SELECT COUNT(*) n FROM refs WHERE entry_ulid = ?`).get(a.ulid) as any).n, 0);

    // A member of A only: the link arrives, its target does not.
    L2.pull(A);
    const l2refs = L2.db.prepare(`SELECT r.target_ulid, e.ulid AS present FROM refs r LEFT JOIN entries e ON e.ulid = r.target_ulid WHERE r.entry_ulid = ?`).all(a.ulid) as any[];
    assert.equal(l2refs.length, 2);
    assert.ok(l2refs.every((r) => r.target_ulid && r.present === null), 'targets are named but absent on L2');
    assert.deepEqual(linkModules(L2.db), ['alpha', 'beta']);
    assert.deepEqual(moduleSlugs(L2.db), ['alpha'], 'no modules row for beta: only the tag');
  } finally { w.done(); }
});

test('S2-5a (observed) move alpha->beta of L1\'s own note: A keeps a stale alpha copy, B gets the whole note', async () => {
  const w = world();
  try {
    const { A, B, L1, L2, L3 } = w;
    const m = await note(L1.db, 'm5', 'alpha');
    L1.push(A); L1.push(B); L2.pull(A);
    reassignModule(L1.db, [m.id], 'beta');
    const toA = L1.push(A), toB = L1.push(B);
    assert.equal(toA.sentCount, 0, 'observed: A is told nothing about the move');
    assert.ok(toB.sentCount > 0);

    const atA = rowOf(A.store, m.ulid);
    assert.equal(atA.module, 'alpha', 'observed: A still files m5 under alpha');
    assert.deepEqual(A.store.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ?`).all(m.ulid), [{ module: 'alpha', is_primary: 1 }]);
    L2.pull(A);
    assert.equal(rowOf(L2.db, m.ulid).module, 'alpha', 'observed: team A members keep the stale copy');

    const atB = rowOf(B.store, m.ulid);
    assert.deepEqual([atB.title, atB.summary, atB.description, atB.module, atB.id], ['m5', 'm5 summary', 'm5 body', 'beta', m.id]);
    L3.pull(B);
    assert.equal(rowOf(L3.db, m.ulid).title, 'm5');
    // Later edits on L1 go to B only.
    updateEntry(L1.db, { id: m.id, description: 'after the move' });
    assert.equal(L1.push(A).sentCount, 0);
    L1.push(B);
    assert.equal(rowOf(B.store, m.ulid).description, 'after the move');
    assert.equal(rowOf(A.store, m.ulid).description, 'm5 body');
  } finally { w.done(); }
});

test('S2-5b (observed) move alpha->beta of a note WRITTEN BY L2: B gets only L1\'s own cells (a hollow note)', async () => {
  const w = world();
  try {
    const { A, B, L1, L2, L3 } = w;
    upsertModule(L2.db, { slug: 'alpha', name: 'alpha' });
    L2.push(A); L1.pull(A);
    const n = await note(L2.db, 'n5', 'alpha');
    L2.push(A); L1.pull(A);
    assert.equal(rowOf(L1.db, n.ulid).title, 'n5');
    reassignModule(L1.db, [n.id], 'beta');
    L1.push(A); L1.push(B);
    const atB = rowOf(B.store, n.ulid);
    assert.ok(atB, 'a row arrives at B');
    assert.deepEqual([atB.title, atB.summary, atB.description, atB.module, atB.id], ['', '', null, 'beta', null],
      'observed: title/summary/description/id were written by L2, so L1 never sends them; B holds a hollow beta note');
    L3.pull(B);
    assert.equal(rowOf(L3.db, n.ulid).title, '');
  } finally { w.done(); }
});

test('S2-6 a tombstone made by L3 travels via B to L1 and never to A; L1 does not relay it', async () => {
  const w = world();
  try {
    const { A, B, L1, L3 } = w;
    const b = await note(L1.db, 'b6', 'beta');
    L1.push(A); L1.push(B); L3.pull(B);
    deleteEntry(L3.db, b.id);
    assert.ok(L3.push(B).sentCount > 0);
    L1.pull(B);
    assert.ok(rowOf(L1.db, b.ulid).deleted_at, 'the delete applied on L1');
    // The change on L1 carries L3's site id, so it is not L1's own: nothing goes to A.
    const l3site = (L3.db.prepare(`SELECT crsql_site_id() s`).get() as any).s as Buffer;
    const del = L1.db.prepare(`SELECT site_id FROM crsql_changes WHERE "table" = 'entries' AND cid = 'deleted_at'`).get() as any;
    assert.ok(Buffer.compare(del.site_id, l3site) === 0);
    assert.equal(L1.push(A).sentCount, 0);
    assert.equal(rowOf(A.store, b.ulid), undefined);
  } finally { w.done(); }
});

test('S2-6b (observed) a HARD delete (causal length) cannot be placed by the module filter and is never sent', async () => {
  const w = world();
  try {
    const { B, L1, L3 } = w;
    const b = await note(L1.db, 'b6h', 'beta');
    L1.push(B); L3.pull(B);
    L3.db.prepare(`DELETE FROM entries WHERE ulid = ?`).run(b.ulid);
    const own = readOwnChanges(L3.db, L3.sent.get('B') ?? 0);
    assert.ok(own.some((c) => c.table === 'entries' && c.cid === '-1' && c.cl % 2 === 0), 'cr-sqlite records the delete (even causal length)');
    assert.equal(L3.push(B).sentCount, 0, 'observed: the row is gone, so placeOf finds no module and the delete is dropped');
    L1.pull(B);
    assert.ok(rowOf(L1.db, b.ulid), 'observed: L1 still has the note');
  } finally { w.done(); }
});
