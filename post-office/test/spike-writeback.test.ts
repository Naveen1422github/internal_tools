// RnR S2 spike (Task 1): the office writes its own value back to a sender with a
// FORCED cr-sqlite col_version (R6), and deletes rows it never had with a row
// tombstone. Kept as a regression test of the mechanism S2 builds on: mechanism
// (b), an INSERT INTO crsql_changes under the office's own crsql_site_id().
// Findings: docs/superpowers/plans/2026-10-18-collab-rnr-s2-spike.md
import { test } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  addEntryAsync, updateEntry, updateEntryRefs, setAllocator, readOwnChanges, applyChanges, decodeChange,
  revisionsOf, headsOf, rootRevId, type RawChange,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries, firstTextCell, OFFICE_ORIGIN } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

type DB = Database.Database | Store;
const COLS = `"table", pk, cid, val, col_version, db_version, site_id, cl, seq`;
const dbVersion = (db: DB) => (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
const officeSite = (db: Store) => (db.prepare(`SELECT crsql_site_id() s`).get() as { s: Buffer }).s;
const packPk = (db: DB, ...cells: string[]) =>
  (db.prepare(`SELECT crsql_pack_columns(${cells.map(() => '?').join(', ')}) pk`).get(...cells) as { pk: Buffer }).pk;
/** The cell's clock as cr-sqlite reports it. */
function clock(db: DB, table: string, pk: Buffer, cid: string) {
  return db.prepare(`SELECT val, col_version, db_version, site_id, cl FROM crsql_changes WHERE "table" = ? AND pk = ? AND cid = ?`)
    .get(table, pk, cid) as { val: unknown; col_version: number; db_version: number; site_id: Buffer; cl: number } | undefined;
}
const member = (s: Store, id: string) =>
  s.prepare(`INSERT INTO po_members (device_id, name, joined_at) VALUES (?, ?, datetime('now'))`).run(id, id);
/** Fetch everything for `device` after `after` and apply it, as the courier does. */
function receive(s: Store, db: Database.Database, device: string, after = 0): number {
  const got = fetchDeliveries(s, device, after, 5000);
  db.transaction(() => applyChanges(db, got.changes.map(decodeChange)))();
  return got.lastSeq;
}

/**
 * THE WRITE-BACK (mechanism b): the office's current value re-inserted through
 * crsql_changes under its own site id at `colVersion`. db_version = the office's
 * current one: cr-sqlite stores max(passed, next), so a larger number would jump
 * the office's clock (seen: 999 -> clock 999). Sync bit is 1, so no
 * trg_entries_updated_at side cell.
 */
function writeBack(s: Store, cells: Array<{ table: string; pk: Buffer; cid: string; colVersion: number; cl?: number }>): void {
  const ins = s.prepare(`INSERT INTO crsql_changes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const site = officeSite(s);
  s.transaction(() => {
    const dv = dbVersion(s);
    cells.forEach((c, seq) => {
      if (c.cid === '-1') {
        // Row tombstone: the sentinel cell, col_version = cl = (sender's cl) + 1 (even = deleted).
        ins.run(c.table, c.pk, '-1', null, c.cl, dv, site, c.cl, seq);
      } else {
        const cur = clock(s, c.table, c.pk, c.cid)!;
        ins.run(c.table, c.pk, c.cid, cur.val, c.colVersion, dv, site, cur.cl, seq);
      }
    });
  })();
}

test('(b) forced col_version: the office value wins over 3 offline edits, recordOwnChanges delivers it, a second write-back works', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop(), b = laptop();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    setAllocator({ allocate: async () => 1 });
    const r = await addEntryAsync(a.db, { type: 'decision', title: 'office title', summary: 'office summary', module: 'm' });
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    let bSeq = receive(store, b.db, 'd-b');
    const pk = packPk(store, r.ulid);
    assert.equal(clock(store, 'entries', pk, 'title')!.col_version, 1, 'the office holds version 1');

    for (const t of ['x1', 'x2', 'x3']) updateEntry(a.db, { ulid: r.ulid, title: t, summary: t });
    assert.equal(clock(a.db, 'entries', pk, 'title')!.col_version, 4, 'three offline edits: the laptop is at 4');
    // (the laptop's batch is refused: nothing of it reaches the office)

    const seq0 = fetchDeliveries(store, 'd-a', 0, 5000).lastSeq;
    writeBack(store, [{ table: 'entries', pk, cid: 'title', colVersion: 5 }, { table: 'entries', pk, cid: 'summary', colVersion: 5 }]);
    const t = clock(store, 'entries', pk, 'title')!;
    assert.equal(t.col_version, 5);
    assert.equal(t.val, 'office title');
    assert.ok(t.site_id.equals(officeSite(store)), 'stored under the office site: an own change');
    assert.ok(t.db_version > 1, 'db_version comes from the office clock');

    // The real accept path records it: recordOwnChanges (site_id = crsql_site_id()) sees it.
    const acc = acceptChanges(store, 'd-x', []);
    assert.equal(acc.officeWrote, true);
    const rec = store.prepare(`SELECT origin, cid, col_version FROM po_deliveries WHERE seq > ? ORDER BY seq`).all(seq0) as Array<{ origin: string; cid: string; col_version: number }>;
    assert.deepEqual(rec.map((x) => [x.origin, x.cid, x.col_version]).sort(), [[OFFICE_ORIGIN, 'summary', 5], [OFFICE_ORIGIN, 'title', 5]]);

    // The sender gets it like any delivery and reverts.
    const aBefore = dbVersion(a.db);
    receive(store, a.db, 'd-a', seq0);
    const back = a.db.prepare(`SELECT title, summary FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string; summary: string };
    assert.deepEqual(back, { title: 'office title', summary: 'office summary' });
    assert.equal(clock(a.db, 'entries', pk, 'title')!.col_version, 5);
    assert.deepEqual(readOwnChanges(a.db, aBefore), [], 'the revert is not an own change: the laptop never re-sends it');

    // Another member (holding the office value at 1): value unchanged, clock to 5, no echo.
    const bBefore = dbVersion(b.db);
    bSeq = receive(store, b.db, 'd-b', bSeq);
    assert.equal((b.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string }).title, 'office title');
    assert.equal(clock(b.db, 'entries', pk, 'title')!.col_version, 5);
    assert.deepEqual(readOwnChanges(b.db, bBefore), []);

    // A second refusal of the same cell later: written back again at (refused max) + 1.
    updateEntry(a.db, { ulid: r.ulid, title: 'y' });
    assert.equal(clock(a.db, 'entries', pk, 'title')!.col_version, 6);
    const seq1 = fetchDeliveries(store, 'd-a', 0, 5000).lastSeq;
    writeBack(store, [{ table: 'entries', pk, cid: 'title', colVersion: 7 }]);
    acceptChanges(store, 'd-x', []);
    const again = store.prepare(`SELECT cid, col_version, db_version FROM po_deliveries WHERE seq > ?`).all(seq1) as Array<{ cid: string; col_version: number; db_version: number }>;
    assert.deepEqual(again.map((x) => [x.cid, x.col_version]), [['title', 7]], 'recorded, not dropped as a duplicate');
    receive(store, a.db, 'd-a', seq1);
    assert.equal((a.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string }).title, 'office title');

    // The office's next normal write gets a fresh db_version after the write-backs.
    const top = dbVersion(store);
    store.prepare(`UPDATE entries SET description = 'later' WHERE ulid = ?`).run(r.ulid);
    assert.equal(clock(store, 'entries', pk, 'description')!.db_version, top + 1);
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); cleanup(); }
});

test('(a) a dedicated write-back site id also forces the version, but recordOwnChanges does not see it', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop();
  try {
    member(store, 'd-a');
    setAllocator({ allocate: async () => 1 });
    const r = await addEntryAsync(a.db, { type: 'decision', title: 'office title', summary: 's', module: 'm' });
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    for (const t of ['x1', 'x2', 'x3']) updateEntry(a.db, { ulid: r.ulid, title: t });
    const pk = packPk(store, r.ulid);
    const wb = randomBytes(16);
    const before = fetchDeliveries(store, 'd-a', 0, 5000).lastSeq;
    store.prepare(`INSERT INTO crsql_changes (${COLS}) VALUES ('entries', ?, 'title', 'office title', 5, ?, ?, 1, 0)`).run(pk, dbVersion(store), wb);
    const c = clock(store, 'entries', pk, 'title')!;
    assert.equal(c.col_version, 5);
    assert.ok(c.site_id.equals(wb));
    assert.equal(acceptChanges(store, 'd-x', []).officeWrote, false, 'not an own change: it must be recorded by hand');
    assert.equal(fetchDeliveries(store, 'd-a', before, 5000).changes.length, 0);
    // Shipped by hand it works the same on the laptop.
    const raw = store.prepare(`SELECT ${COLS} FROM crsql_changes WHERE "table" = 'entries' AND pk = ? AND cid = 'title'`).get(pk) as RawChange;
    a.db.transaction(() => applyChanges(a.db, [raw]))();
    assert.equal((a.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string }).title, 'office title');
  } finally { setAllocator(null); a.cleanup(); cleanup(); }
});

test('row tombstone: refs and entry_revisions rows the office never had are deleted on the sender; harmless for others', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop(), b = laptop();
  try {
    for (const d of ['d-a', 'd-b']) member(store, d);
    setAllocator({ allocate: async () => 1 });
    const r = await addEntryAsync(a.db, { type: 'decision', title: 't0', summary: 's', module: 'm' });
    updateEntry(a.db, { ulid: r.ulid, title: 't1' }); // root + r1: the office has both
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    let bSeq = receive(store, b.db, 'd-b');
    const officeHeads = headsOf(revisionsOf(store, r.ulid)).map((h) => h.rev_id);
    assert.equal(officeHeads.length, 1);

    // Refused group: a new revision and a new ref (cl = 1 on the laptop).
    const v0 = dbVersion(a.db);
    updateEntry(a.db, { ulid: r.ulid, title: 't2' });
    updateEntryRefs(a.db, { ulid: r.ulid, add: [{ ref_type: 'file', ref_value: 'x.ts' }] });
    const refused = readOwnChanges(a.db, v0).map(decodeChange);
    const rowsOf = (t: string) => [...new Map(refused.filter((c) => c.table === t).map((c) => [c.pk.toString('hex'), c])).values()];
    const [rev] = rowsOf('entry_revisions'), [ref] = rowsOf('refs');
    assert.ok(rev && ref);
    assert.equal(rev.cl, 1);
    assert.equal(ref.cl, 1);
    assert.equal(clock(store, 'entry_revisions', rev.pk, 'title'), undefined, 'the office never had the revision');

    // The office's undo: title back at 4 (laptop is at 3), both rows tombstoned at cl + 1.
    const seq0 = fetchDeliveries(store, 'd-a', 0, 5000).lastSeq;
    writeBack(store, [
      { table: 'entries', pk: packPk(store, r.ulid), cid: 'title', colVersion: clock(a.db, 'entries', packPk(a.db, r.ulid), 'title')!.col_version + 1 },
      { table: 'entry_revisions', pk: rev.pk, cid: '-1', colVersion: 0, cl: rev.cl + 1 },
      { table: 'refs', pk: ref.pk, cid: '-1', colVersion: 0, cl: ref.cl + 1 },
    ]);
    const tomb = clock(store, 'refs', ref.pk, '-1')!;
    assert.deepEqual([tomb.val, tomb.col_version, tomb.cl], [null, 2, 2]);
    assert.ok(tomb.site_id.equals(officeSite(store)), 'an own change of the office, so recordOwnChanges carries it');
    acceptChanges(store, 'd-x', []);
    const rec = store.prepare(`SELECT tbl, cid, cl FROM po_deliveries WHERE seq > ? ORDER BY seq`).all(seq0) as Array<{ tbl: string; cid: string; cl: number }>;
    assert.deepEqual(rec.map((x) => `${x.tbl}.${x.cid}@${x.cl}`).sort(), ['entries.title@1', 'entry_revisions.-1@2', 'refs.-1@2']);
    assert.equal((store.prepare(`SELECT project_ulid p FROM po_deliveries WHERE seq > ? AND tbl = 'refs'`).get(seq0) as { p: string | null }).p, null,
      'a no-project note: the tombstone is stamped like its note (R3 resolves the ref pk to the entry)');

    // R3 cannot resolve a revision the office never had (no entry_revisions row to read
    // entry_ulid from): its tombstone is held ('?') and would go to nobody, forever.
    // Task 4 must record it with the note's stamp itself; emulated here (no-project note = NULL).
    const held = store.prepare(`SELECT seq, project_ulid p FROM po_deliveries WHERE seq > ? AND tbl = 'entry_revisions'`).get(seq0) as { seq: number; p: string | null };
    assert.equal(held.p, '?', 'held by R3');
    store.prepare(`UPDATE po_deliveries SET project_ulid = NULL WHERE seq = ?`).run(held.seq);

    receive(store, a.db, 'd-a', seq0);
    assert.equal(a.db.prepare(`SELECT 1 FROM refs WHERE entry_ulid = ? AND ref_value = 'x.ts'`).get(r.ulid), undefined, 'ref gone on the sender');
    assert.equal(a.db.prepare(`SELECT 1 FROM entry_revisions WHERE rev_id = ?`).get(firstTextCell(rev.pk)), undefined, 'revision gone on the sender');
    assert.equal((a.db.prepare(`SELECT title FROM entries WHERE ulid = ?`).get(r.ulid) as { title: string }).title, 't1');
    assert.deepEqual(headsOf(revisionsOf(a.db, r.ulid)).map((h) => h.rev_id), officeHeads, "the sender's head is the office's head again");

    // Another member: no row before, none after; a late resend of the original insert does not revive it.
    const bBefore = dbVersion(b.db);
    bSeq = receive(store, b.db, 'd-b', bSeq);
    assert.equal(b.db.prepare(`SELECT 1 FROM refs WHERE ref_value = 'x.ts'`).get(), undefined);
    assert.deepEqual(readOwnChanges(b.db, bBefore), []);
    b.db.transaction(() => applyChanges(b.db, refused))();
    assert.equal(b.db.prepare(`SELECT 1 FROM refs WHERE ref_value = 'x.ts'`).get(), undefined, 'cl 1 loses to the cl 2 tombstone');
    assert.equal(b.db.prepare(`SELECT 1 FROM entry_revisions WHERE rev_id = ?`).get(firstTextCell(rev.pk)), undefined);
    // ...and a member who HAS the tombstone can still add the same ref later (cl 3 beats it).
    const bv = dbVersion(b.db);
    updateEntryRefs(b.db, { ulid: r.ulid, add: [{ ref_type: 'file', ref_value: 'x.ts' }] });
    const again = readOwnChanges(b.db, bv).map(decodeChange).find((c) => c.table === 'refs')!;
    assert.equal(again.cl, 3);
  } finally { setAllocator(null); a.cleanup(); b.cleanup(); cleanup(); }
});

test('hazard: a tombstone on a deterministic pk (the root revision) swallows a later legitimate insert from an unsynced member', async () => {
  const { store, cleanup } = tempStore();
  const a = laptop(), c = laptop();
  try {
    for (const d of ['d-a', 'd-c']) member(store, d);
    setAllocator({ allocate: async () => 1 });
    const r = await addEntryAsync(a.db, { type: 'decision', title: 't0', summary: 's', module: 'm' });
    acceptChanges(store, 'd-a', readOwnChanges(a.db, 0));
    receive(store, c.db, 'd-c');
    const rootPk = packPk(store, rootRevId(r.ulid));
    // a's first edit (root + r1) is refused and the office (wrongly) tombstones the root too.
    writeBack(store, [{ table: 'entry_revisions', pk: rootPk, cid: '-1', colVersion: 0, cl: 2 }]);
    acceptChanges(store, 'd-x', []);
    // c, not synced since, makes the first edit legitimately: its root is cl 1 and loses at the office.
    const cv = dbVersion(c.db);
    updateEntry(c.db, { ulid: r.ulid, title: 'c edit' });
    acceptChanges(store, 'd-c', readOwnChanges(c.db, cv));
    assert.equal(store.prepare(`SELECT 1 FROM entry_revisions WHERE rev_id = ?`).get(rootRevId(r.ulid)), undefined,
      'the root never reaches the office: never tombstone a pk the office could hold later (Task 4 must skip `${ulid}.0`)');
  } finally { setAllocator(null); a.cleanup(); c.cleanup(); cleanup(); }
});

