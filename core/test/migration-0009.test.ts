// file: core/test/migration-0009.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb, dbVersion } from './helpers/sync.js';
import { migrate, migrateTo, latestMigration } from '../src/db.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { searchEntries } from '../src/ops/search.js';
import { setAllocator } from '../src/sync/allocator.js';
import { hasSeries } from '../src/schema.js';

const cols = (db: Database.Database, t: string) =>
  db.prepare(`SELECT name, dflt_value, "notnull" nn FROM pragma_table_info(?)`).all(t) as Array<{ name: string; dflt_value: string | null; nn: number }>;
const find = (db: Database.Database, q: string) =>
  searchEntries(db, { query: q, kind: 'any', include_deprecated: false, limit: 50 } as any).results.map((r) => r.id).sort();
const trigger = (db: Database.Database, name: string) =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string } | undefined)?.sql;

const OUR_TRIGGERS = [
  'trg_entries_fill_superseded_ulid', 'trg_entries_fts_ad', 'trg_entries_fts_ai', 'trg_entries_fts_au',
  'trg_entries_ulid_immutable', 'trg_entries_updated_at', 'trg_refs_cascade_delete', 'trg_entry_modules_cascade_delete',
];

test('fresh notebook: projects table, entries.series/project_ulid, dispatches.entry_ulid, latest = 0009', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0009_projects');
    assert.deepEqual(cols(t.db, 'projects').map((c) => c.name).sort(),
      ['code', 'created_at', 'mode', 'name', 'team', 'ulid', 'updated_at']);
    const e = cols(t.db, 'entries');
    const series = e.find((c) => c.name === 'series');
    assert.ok(series, 'entries.series');
    assert.equal(series!.dflt_value, "'E'");
    assert.equal(series!.nn, 1);
    assert.ok(e.some((c) => c.name === 'project_ulid'), 'entries.project_ulid');
    assert.ok(cols(t.db, 'dispatches').some((c) => c.name === 'entry_ulid'), 'dispatches.entry_ulid');
    assert.equal(hasSeries(t.db), true);
  } finally { t.cleanup(); }
});

test('a 0008 notebook with 3 notes migrates: every note is series E, no project, still found by search', () => {
  const t = freshDb();
  try {
    migrateTo(t.db, '0008');
    assert.equal(hasSeries(t.db), false);
    const ids = [0, 1, 2].map((i) => addEntry(t.db, { type: 'decision', title: `old ${i}`, summary: 's', description: `pumpkin ${i}`, module: 'm' }).id);
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0009_projects');
    const rows = t.db.prepare(`SELECT series, project_ulid FROM entries`).all() as Array<{ series: string; project_ulid: string | null }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.series === 'E' && r.project_ulid === null));
    assert.deepEqual(find(t.db, 'pumpkin'), ids.sort());
  } finally { t.cleanup(); }
});

test('a SYNC-ENABLED 0008 notebook migrates: no tracked change, our triggers present, ref trigger guarded', async () => {
  const t = freshDb({ shared: true });
  let next = 100;
  setAllocator({ allocate: async () => ++next });
  try {
    migrateTo(t.db, '0008');
    for (let i = 0; i < 3; i++) await addEntryAsync(t.db, { type: 'decision', title: `n ${i}`, summary: 's', module: 'm' });
    const v0 = dbVersion(t.db);
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0009_projects');
    assert.equal(dbVersion(t.db), v0, 'the migration itself writes no tracked change (S3-1)');
    for (const n of OUR_TRIGGERS) assert.ok(trigger(t.db, n), `trigger ${n}`);
    const sql = trigger(t.db, 'trg_refs_fill_target_ulid');
    assert.ok(sql && sql.includes('crsql_internal_sync_bit'), 'guarded ref trigger');
    assert.ok(sql!.includes('series'), 'series-aware ref trigger');
    assert.ok((t.db.prepare(`SELECT series FROM entries`).all() as any[]).every((r) => r.series === 'E'));
  } finally { setAllocator(null); t.cleanup(); }
});
