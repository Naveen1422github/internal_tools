// file: core/test/ref-trigger-series.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';

function seed(db: Database.Database) {
  const ins = db.prepare(`INSERT INTO entries (ulid, id, series, type, kind, title, summary, module, category)
                          VALUES (?, ?, ?, 'decision', 'signal', ?, 's', 'm', 'Reference')`);
  ins.run('01B00000000000000000000001', 1, 'E', 'E-1');
  ins.run('01A00000000000000000000001', 1, 'SH', 'SH-1');   // lower ulid than E-1
  ins.run('01A00000000000000000000012', 12, 'SH', 'SH-12');
  ins.run('01C00000000000000000000000', 2, 'E', 'source');
}

function targetOf(db: Database.Database, value: string): string | null {
  db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value) VALUES ('01C00000000000000000000000', 'entry', ?)`).run(value);
  return (db.prepare(`SELECT target_ulid t FROM refs WHERE entry_ulid = '01C00000000000000000000000' AND ref_value = ?`).get(value) as { t: string | null }).t;
}

for (const shared of [false, true]) {
  test(`ref trigger reads the series (${shared ? 'sync-enabled' : 'unsynced'} notebook)`, () => {
    const t = freshDb({ shared });
    try {
      migrate(t.db);
      seed(t.db);
      for (const v of ['1', '#1', 'E-00001']) assert.equal(targetOf(t.db, v), '01B00000000000000000000001', v);
      for (const v of ['SH-12', 'sh-0012']) assert.equal(targetOf(t.db, v), '01A00000000000000000000012', v);
      for (const v of ['SH12', 'S-1', 'X-1']) assert.equal(targetOf(t.db, v), null, v);
    } finally { t.cleanup(); }
  });
}
