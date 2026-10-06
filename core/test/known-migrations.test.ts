// file: core/test/known-migrations.test.ts
// E-793: a build refuses migrations it was not written against, and doctor
// sees the damage a plain run of one leaves on a synced notebook.
import { test } from 'node:test';
import assert from 'node:assert';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { KNOWN_MIGRATIONS, migrate, UnknownMigrationError } from '../src/db.js';
import { installRoot } from '../src/install-root.js';
import { doctor } from '../src/ops/doctor.js';

const MIGRATIONS = join(installRoot(), 'mcp', 'migrations');
const versionsIn = (dir: string) => {
  try { return readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')); } catch { return []; }
};

test('every migration file (released and staged) is in KNOWN_MIGRATIONS', () => {
  const missing = [...versionsIn(MIGRATIONS), ...versionsIn(join(MIGRATIONS, 'staged'))].filter((v) => !KNOWN_MIGRATIONS.has(v));
  assert.deepEqual(missing, [], 'add these to KNOWN_MIGRATIONS in core/src/db.ts');
});

test('a migration file newer than the build is refused before anything runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-known-'));
  const db = new Database(':memory:');
  try {
    const migrationsDir = join(dir, 'migrations');
    mkdirSync(migrationsDir);
    for (const v of versionsIn(MIGRATIONS)) copyFileSync(join(MIGRATIONS, `${v}.sql`), join(migrationsDir, `${v}.sql`));
    writeFileSync(join(migrationsDir, '0999_future.sql'), 'CREATE TABLE future (x);');
    assert.throws(
      () => migrate(db, { migrationsDir, knownVersions: KNOWN_MIGRATIONS }),
      (e: unknown) => e instanceof UnknownMigrationError && e.where === 'folder' && e.versions.join() === '0999_future',
    );
    const applied = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as { n: number };
    assert.equal(applied.n, 0, 'not even 0001 may run');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a notebook already upgraded by a newer build is refused', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.prepare(`INSERT INTO schema_migrations (version) VALUES ('0999_future')`).run();
    assert.throws(
      () => migrate(db),
      (e: unknown) => e instanceof UnknownMigrationError && e.where === 'notebook' && e.versions.join() === '0999_future',
    );
  } finally { db.close(); }
});

test('doctor: a correctly migrated synced notebook passes both sync checks', () => {
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    const checks = doctor(t.db, { env: {} }).checks;
    assert.equal(checks.find((c) => c.name === 'sync.trigger_guards')?.severity, 'ok');
    assert.equal(checks.find((c) => c.name === 'sync.tracked_columns')?.severity, 'ok');
  } finally { t.cleanup(); }
});

test('doctor: an unguarded bookkeeping trigger is an error', () => {
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    // What 0009's SQL alone leaves behind (E-793): the trigger without its sync guard.
    t.db.exec(`DROP TRIGGER trg_entries_fill_superseded_ulid`);
    t.db.exec(`CREATE TRIGGER trg_entries_fill_superseded_ulid AFTER UPDATE OF superseded_by ON entries BEGIN SELECT 1; END`);
    const c = doctor(t.db, { env: {} }).checks.find((x) => x.name === 'sync.trigger_guards')!;
    assert.equal(c.severity, 'error');
    assert.deepEqual(c.items, ['trg_entries_fill_superseded_ulid']);
  } finally { t.cleanup(); }
});

test('doctor: a column added without crsql_begin_alter is reported as untracked', () => {
  const t = freshDb({ shared: true });
  try {
    migrate(t.db);
    t.db.exec(`ALTER TABLE entries ADD COLUMN plain_added TEXT`);
    const c = doctor(t.db, { env: {} }).checks.find((x) => x.name === 'sync.tracked_columns')!;
    assert.equal(c.severity, 'error');
    assert.deepEqual(c.items, ['entries.plain_added']);
  } finally { t.cleanup(); }
});
