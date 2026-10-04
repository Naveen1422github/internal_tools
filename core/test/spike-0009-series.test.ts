// SPIKE S3 (docs/superpowers/plans/2026-10-05-collab-join-spikes.md): the candidate
// migration 0009 alter on the shared `entries` CRR, run through a copy of the
// CRR_ALTERS block of core/src/db.ts applyMigrations. No file under mcp/migrations.
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { migrate, latestMigration } from '../src/db.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { updateEntry } from '../src/ops/update.js';
import { searchEntries } from '../src/ops/search.js';
import { setAllocator } from '../src/sync/allocator.js';
import { ensureCrsqlite } from '../src/sync/extension.js';

export const SERIES_SQL = `ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';`;

/** Copy of the CRR_ALTERS path in core/src/db.ts applyMigrations (0008's path), for 'entries'. */
export function alterEntries(db: Database.Database, sql: string): void {
  const crr = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get('entries__crsql_clock');
  if (crr) ensureCrsqlite(db);
  db.transaction(() => {
    if (crr) db.prepare(`SELECT crsql_begin_alter(?)`).get('entries');
    db.exec(sql);
    if (crr) db.prepare(`SELECT crsql_commit_alter(?)`).get('entries');
  })();
}

const hasSeries = (db: Database.Database) =>
  (db.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as Array<{ name: string }>).some((c) => c.name === 'series');
const triggers = (db: Database.Database) =>
  db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'entries' ORDER BY name`).all() as Array<{ name: string; sql: string }>;
const find = (db: Database.Database, q: string) =>
  searchEntries(db, { query: q, kind: 'any', include_deprecated: false, limit: 50 } as any).results.map((r) => r.id).sort();

/** The entries triggers 0006_ulid_contract creates (trg_entries_revision is dropped by 0007: revisions are written in code). */
const TRIGGERS_0006 = [
  'trg_entries_fill_superseded_ulid', 'trg_entries_fts_ad', 'trg_entries_fts_ai', 'trg_entries_fts_au',
  'trg_entries_ulid_immutable', 'trg_entries_updated_at', 'trg_refs_cascade_delete', 'trg_entry_modules_cascade_delete',
];

async function sharedWithNotes(n = 3) {
  const t = freshDb({ shared: true });
  migrate(t.db); // to the newest released migration (0008), as a real laptop is
  let next = 100;
  setAllocator({ allocate: async () => ++next });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await addEntryAsync(t.db, { type: 'decision', title: `old note ${i}`, summary: 's', description: `pumpkin ${i}`, module: 'm' })).id);
  return { ...t, ids, done: () => { setAllocator(null); t.cleanup(); } };
}

test('S3-1 the alter succeeds on a shared notebook with notes; every existing row has series E', async () => {
  const t = await sharedWithNotes();
  try {
    assert.equal(latestMigration(t.db), '0008_revision_author');
    const v0 = (t.db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
    alterEntries(t.db, SERIES_SQL);
    assert.ok(hasSeries(t.db));
    // The alter itself writes no changes: the default 'E' is filled locally on every laptop, never sent.
    assert.equal((t.db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v, v0);
    assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM crsql_changes WHERE db_version > ?`).get(v0) as { n: number }).n, 0);
    const rows = t.db.prepare(`SELECT series FROM entries`).all() as Array<{ series: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.series === 'E'));
    // cr-sqlite tracks the new column: an own change on it shows up in crsql_changes.
    t.db.prepare(`UPDATE entries SET series = 'ACME' WHERE id = ?`).run(t.ids[0]);
    const ch = t.db.prepare(`SELECT val FROM crsql_changes WHERE "table" = 'entries' AND cid = 'series'`).all() as any[];
    assert.deepEqual(ch.map((c) => c.val), ['ACME']);
  } finally { t.done(); }
});

test('S3-2 FTS and every entries trigger survive the alter', async () => {
  const t = await sharedWithNotes();
  try {
    const before = triggers(t.db);
    for (const n of TRIGGERS_0006) assert.ok(before.some((x) => x.name === n), `before: ${n}`);
    alterEntries(t.db, SERIES_SQL);
    const after = triggers(t.db);
    // Our triggers are untouched byte for byte; cr-sqlite's own (entries__crsql_*) are recreated by commit_alter.
    const ours = (xs: typeof before) => xs.filter((x) => !x.name.startsWith('entries__crsql_'));
    assert.deepEqual(ours(after), ours(before));
    assert.deepEqual(after.map((x) => x.name), before.map((x) => x.name));

    const { id: fresh } = await addEntryAsync(t.db, { type: 'decision', title: 'new note', summary: 's', description: 'watermelon', module: 'm' });
    assert.deepEqual(find(t.db, 'watermelon'), [fresh], 'a new note is found');
    updateEntry(t.db, { id: t.ids[1], description: 'zucchini' });
    assert.deepEqual(find(t.db, 'zucchini'), [t.ids[1]], 'an edited old note is found by its new text');
    assert.deepEqual(find(t.db, 'pumpkin'), [t.ids[0], t.ids[2]].sort(), 'and no longer by its old text');
    // updated_at trigger still fires (sync bit 0) and the edit is a tracked own change.
    assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM entry_revisions WHERE entry_ulid = (SELECT ulid FROM entries WHERE id = ?)`).get(t.ids[1]) as any).n, 2);
  } finally { t.done(); }
});

test('S3-3 atomic: a failing statement after the ALTER leaves the notebook unchanged', async () => {
  const t = await sharedWithNotes();
  try {
    const before = triggers(t.db);
    const clockCols = t.db.prepare(`SELECT COUNT(*) n FROM entries__crsql_clock`).get();
    assert.throws(() => alterEntries(t.db, `${SERIES_SQL}\nSELECT no_such_function();`), /no such function/);
    assert.equal(hasSeries(t.db), false, 'no series column');
    assert.deepEqual(triggers(t.db), before, 'every trigger (ours and cr-sqlite\'s) intact');
    assert.deepEqual(t.db.prepare(`SELECT COUNT(*) n FROM entries__crsql_clock`).get(), clockCols);
    // Still a working shared notebook: a write is recorded as a change and found by search.
    const { id } = await addEntryAsync(t.db, { type: 'decision', title: 'after failure', summary: 's', description: 'radish', module: 'm' });
    assert.deepEqual(find(t.db, 'radish'), [id]);
    assert.ok((t.db.prepare(`SELECT COUNT(*) n FROM crsql_changes WHERE "table" = 'entries' AND cid = 'title' AND val = 'after failure'`).get() as any).n === 1);
    // And the real alter still works afterwards.
    alterEntries(t.db, SERIES_SQL);
    assert.ok(hasSeries(t.db));
  } finally { t.done(); }
});

test('S3-1b the same path on an UNSHARED notebook (no cr-sqlite) adds the column too', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    addEntry(t.db, { type: 'decision', title: 'x', summary: 's', module: 'm' });
    alterEntries(t.db, SERIES_SQL);
    assert.deepEqual(t.db.prepare(`SELECT series FROM entries`).all(), [{ series: 'E' }]);
  } finally { t.cleanup(); }
});
