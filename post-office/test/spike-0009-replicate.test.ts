// SPIKE S3, two-laptop part (docs/superpowers/plans/2026-10-05-collab-join-spikes.md):
// does the candidate 0009 column `entries.series` replicate through a post office,
// and what happens when only some machines have it. Evidence, not product code.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  addEntryAsync, setAllocator, ensureCrsqlite, readOwnChanges, applyChanges, decodeChange, reindexFts, ownerOf,
} from '@collab-mcp/core';
import { tempStore, laptop } from './helpers.js';
import { acceptChanges, fetchDeliveries } from '../src/deliveries.js';
import type { Store } from '../src/store.js';

const SERIES_SQL = `ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';`;

/** Copy of the CRR_ALTERS path in core/src/db.ts applyMigrations, for 'entries'. */
function alterEntries(db: Database.Database): void {
  const crr = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries__crsql_clock'`).get();
  if (crr) ensureCrsqlite(db);
  db.transaction(() => {
    if (crr) db.prepare(`SELECT crsql_begin_alter(?)`).get('entries');
    db.exec(SERIES_SQL);
    if (crr) db.prepare(`SELECT crsql_commit_alter(?)`).get('entries');
  })();
}

function machine(dev: string) {
  const h = laptop();
  let sent = 0, recv = 0;
  return {
    ...h, dev,
    push(s: Store) { const w = readOwnChanges(h.db, sent); const r = acceptChanges(s, dev, w); sent = Math.max(sent, ...w.map((c) => c.db_version)); return r; },
    pull(s: Store) {
      for (;;) {
        const r = fetchDeliveries(s, dev, recv, 1000);
        if (r.changes.length) h.db.transaction(() => reindexFts(h.db, applyChanges(h.db, r.changes.map(decodeChange)).entryUlids))();
        recv = r.lastSeq;
        if (!r.more) break;
      }
    },
  };
}

const seriesOf = (db: Database.Database, ulid: string) =>
  (db.prepare(`SELECT series FROM entries WHERE ulid = ?`).get(ulid) as { series: string } | undefined)?.series;
const hasSeries = (db: Database.Database) =>
  (db.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as Array<{ name: string }>).some((c) => c.name === 'series');

async function acmeNote(db: Database.Database, title: string) {
  const { id } = await addEntryAsync(db, { type: 'decision', title, summary: 's', description: 'd', module: 'm' });
  const ulid = ownerOf(db, id)!.ulid as string;
  db.prepare(`UPDATE entries SET series = 'ACME' WHERE ulid = ?`).run(ulid);
  return { id, ulid };
}

function setup() {
  let n = 0;
  setAllocator({ allocate: async () => ++n });
  const s = tempStore();
  const L1 = machine('d-1'), L2 = machine('d-2');
  return { s, L1, L2, done() { setAllocator(null); L1.cleanup(); L2.cleanup(); s.cleanup(); } };
}

test('S3-4 replication: office and both laptops altered; series ACME written on L1 arrives on the office and L2', async () => {
  const w = setup();
  try {
    const { s, L1, L2 } = w;
    // A note from before the alter, already on everyone.
    const { id: oldId } = await addEntryAsync(L1.db, { type: 'decision', title: 'old', summary: 's', module: 'm' });
    L1.push(s.store); L2.pull(s.store);
    for (const db of [s.store, L1.db, L2.db]) alterEntries(db);
    const oldUlid = ownerOf(L1.db, oldId)!.ulid as string;
    for (const db of [s.store, L1.db, L2.db]) assert.equal(seriesOf(db, oldUlid), 'E');

    const n = await acmeNote(L1.db, 'acme note');
    const plain = await addEntryAsync(L1.db, { type: 'decision', title: 'plain', summary: 's', module: 'm' });
    L1.push(s.store); L2.pull(s.store);
    assert.equal(seriesOf(s.store, n.ulid), 'ACME');
    assert.equal(seriesOf(L2.db, n.ulid), 'ACME');
    assert.equal(seriesOf(L2.db, ownerOf(L1.db, plain.id)!.ulid as string), 'E', 'an untouched series arrives as the default');

    // And back: L2 changes the old note's series, L1 receives it.
    L2.db.prepare(`UPDATE entries SET series = 'ACME' WHERE ulid = ?`).run(oldUlid);
    L2.push(s.store); L1.pull(s.store);
    assert.equal(seriesOf(L1.db, oldUlid), 'ACME');
  } finally { w.done(); }
});

test('S3-5a (observed) mixed versions: office + L1 altered, L2 not; L2 applying a series change', async () => {
  const w = setup();
  try {
    const { s, L1, L2 } = w;
    alterEntries(s.store); alterEntries(L1.db);
    const n = await acmeNote(L1.db, 'acme note');
    L1.push(s.store);
    assert.equal(seriesOf(s.store, n.ulid), 'ACME');
    let err: Error | null = null;
    try { L2.pull(s.store); } catch (e) { err = e as Error; }
    assert.equal(hasSeries(L2.db), false);
    assert.ok(err, 'observed: applyChanges on the un-altered laptop throws');
    assert.equal(err!.message, 'SQL logic error', 'observed: a bare SQLite error that does not name the column');
    // The pull's transaction rolled back: L2 did not receive even the note's other columns.
    assert.equal((L2.db.prepare(`SELECT COUNT(*) n FROM entries`).get() as any).n, 0);
    console.log(`# S3-5a observed L2 error: ${err!.message}`);
  } finally { w.done(); }
});

test('S3-5b (observed) mixed versions: L1 altered, office not; the office accepting a series change', async () => {
  const w = setup();
  try {
    const { s, L1 } = w;
    alterEntries(L1.db);
    await acmeNote(L1.db, 'acme note');
    let err: Error | null = null;
    try { L1.push(s.store); } catch (e) { err = e as Error; }
    assert.ok(err, 'observed: acceptChanges on the un-altered office throws');
    assert.equal(err!.message, 'SQL logic error');
    console.log(`# S3-5b observed office error: ${err!.constructor.name}: ${err!.message}`);
    assert.equal((s.store.prepare(`SELECT COUNT(*) n FROM entries`).get() as any).n, 0, 'nothing applied');
    assert.equal((s.store.prepare(`SELECT COUNT(*) n FROM po_deliveries`).get() as any).n, 0, 'nothing recorded (one transaction)');
  } finally { w.done(); }
});
