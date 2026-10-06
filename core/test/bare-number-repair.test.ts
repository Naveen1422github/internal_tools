// file: core/test/bare-number-repair.test.ts
// Stage B1: the repair paths (startup backfill, supersede trigger) read a bare
// number as series E only. When E-15 is not on this laptop, nothing that says
// "15" may land on the project note SH-15.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { backfillUlids } from '../src/backfill.js';

const SRC = '01C00000000000000000000000';
const SH15 = '01A00000000000000000000015';
const E15 = '01B00000000000000000000015';
const SH20 = '01A00000000000000000000020';

function note(db: Database.Database, ulid: string, id: number, series: string) {
  db.prepare(`INSERT INTO entries (ulid, id, series, type, kind, title, summary, module, category)
              VALUES (?, ?, ?, 'decision', 'signal', ?, 's', 'm', 'Reference')`).run(ulid, id, series, `${series}-${id}`);
}
const targetOf = (db: Database.Database, v: string) =>
  (db.prepare(`SELECT target_ulid t FROM refs WHERE entry_ulid = ? AND ref_value = ?`).get(SRC, v) as { t: string | null }).t;
const supersededUlid = (db: Database.Database) =>
  (db.prepare(`SELECT superseded_by_ulid u FROM entries WHERE ulid = ?`).get(SRC) as { u: string | null }).u;

for (const shared of [false, true]) {
  const label = shared ? 'sync-enabled' : 'unsynced';

  test(`backfill: a waiting link "15" never lands on SH-15; it connects once E-15 arrives (${label})`, () => {
    const t = freshDb({ shared });
    try {
      migrate(t.db);
      note(t.db, SRC, 1, 'E');
      note(t.db, SH15, 15, 'SH');
      t.db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value) VALUES (?, 'entry', '15')`).run(SRC);
      backfillUlids(t.db);
      assert.equal(targetOf(t.db, '15'), null, 'E-15 is not here: the link must keep waiting');
      note(t.db, E15, 15, 'E');
      backfillUlids(t.db);
      assert.equal(targetOf(t.db, '15'), E15);
    } finally { t.cleanup(); }
  });

  test(`backfill: a waiting link "SH-20" connects once SH-20 exists (${label})`, () => {
    const t = freshDb({ shared });
    try {
      migrate(t.db);
      note(t.db, SRC, 1, 'E');
      t.db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value) VALUES (?, 'entry', 'SH-20')`).run(SRC);
      note(t.db, SH20, 20, 'SH');
      backfillUlids(t.db);
      assert.equal(targetOf(t.db, 'SH-20'), SH20);
    } finally { t.cleanup(); }
  });

  test(`supersede trigger: superseded_by = 15 never fills SH-15's ulid (${label})`, () => {
    const t = freshDb({ shared });
    try {
      migrate(t.db);
      note(t.db, SRC, 1, 'E');
      note(t.db, SH15, 15, 'SH');
      t.db.prepare(`UPDATE entries SET superseded_by = 15 WHERE ulid = ?`).run(SRC);
      assert.equal(supersededUlid(t.db), null, 'trigger must not pick SH-15');
      backfillUlids(t.db);
      assert.equal(supersededUlid(t.db), null, 'backfill must not pick SH-15');
      note(t.db, E15, 15, 'E');
      backfillUlids(t.db);
      assert.equal(supersededUlid(t.db), E15);
    } finally { t.cleanup(); }
  });
}
