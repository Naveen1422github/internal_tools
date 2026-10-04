// file: core/test/migrate-0008.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb, ship, dbVersion } from './helpers/sync.js';
import { migrate, latestMigration } from '../src/db.js';
import { enableSync } from '../src/sync/enable.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { setAllocator } from '../src/sync/allocator.js';
import { updateEntry } from '../src/ops/update.js';
import { revisionsOf, hasRevisionAuthor } from '../src/revisions.js';
import { ensureCrsqlite } from '../src/sync/extension.js';

const ok = { type: 'decision' as const, title: 't', summary: 's', module: 'm' };
const author = (db: Database.Database, ulid: string) =>
  (db.prepare('SELECT author FROM entry_revisions WHERE entry_ulid = ? ORDER BY created_at, rev_id').all(ulid) as Array<{ author: string | null }>).map((r) => r.author);

test('0008 on a SHARED notebook: column added through cr-sqlite, edits replicate with their author', async () => {
  const a = freshDb({ shared: true });
  const b = freshDb({ shared: true });
  try {
    for (const t of [a, b]) migrate(t.db);
    assert.equal(latestMigration(a.db), '0008_revision_author');
    assert.ok(hasRevisionAuthor(a.db));
    process.env.COLLAB_AUTHOR = 'naveen';
    setAllocator({ allocate: async () => 7 }); // a shared notebook takes its numbers from the post office
    const { id } = await addEntryAsync(a.db, ok);
    updateEntry(a.db, { id, summary: 'edited on a' });
    const ulid = (a.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    ship(a.db, b.db);
    assert.deepEqual(author(b.db, ulid), ['naveen', 'naveen'], 'root takes the note author; the edit records its author; both arrive on b');
    const before = dbVersion(b.db);
    process.env.COLLAB_AUTHOR = 'rinku';
    updateEntry(b.db, { id, summary: 'edited on b' });
    ship(b.db, a.db, before);
    assert.deepEqual(author(a.db, ulid), ['naveen', 'naveen', 'rinku']);
  } finally { delete process.env.COLLAB_AUTHOR; setAllocator(null); a.cleanup(); b.cleanup(); }
});

test('0008 on an unshared notebook works without cr-sqlite', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.ok(hasRevisionAuthor(t.db));
    const { id } = addEntry(t.db, ok);
    updateEntry(t.db, { id, summary: 'x' });
    const ulid = (t.db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;
    assert.equal(revisionsOf(t.db, ulid).length, 2);
  } finally { t.cleanup(); }
});

test('an edit on a 0007 notebook (new code, migration not run yet) still works', () => {
  const t = freshDb(); // freshDb stops at 0007
  try {
    assert.equal(hasRevisionAuthor(t.db), false);
    const { id } = addEntry(t.db, ok);
    updateEntry(t.db, { id, summary: 'x' });
  } finally { t.cleanup(); }
});

test('0008 is atomic: a failure leaves no half-applied state', () => {
  const t = freshDb({ shared: true });
  try {
    ensureCrsqlite(t.db);
    t.db.exec('ALTER TABLE entry_revisions RENAME TO entry_revisions_gone'); // force the ALTER to fail
    assert.throws(() => migrate(t.db));
    assert.equal(latestMigration(t.db), '0007_sync_prep');
  } finally { t.cleanup(); }
});
