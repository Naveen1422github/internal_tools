import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate as migrateProd, migrateTo } from '../src/db.js';

// Tests exercise the staged 0005; production callers never pass includeStaged.
const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
// Mirrors db.ts's MIGRATIONS_DIR/STAGED_DIR resolution (core/test is a sibling
// of core/src, so the relative depth to mcp/migrations is the same).
const MIGRATIONS_DIR = join(__dirname, '../../mcp/migrations');
const STAGED_DIR = join(MIGRATIONS_DIR, 'staged');

export function tempDb(): { db: Database.Database; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0005-'));
  const path = join(dir, 'collab.db');
  return { db: new Database(path), dir, path };
}

// Stays `todo` until Task 3 adds the 0005 file (with nothing pending, no backup is due).
test('migrate backs up an existing DB before applying pending migrations', { todo: 'needs 0005 (Task 3)' }, () => {
  const { db, dir } = tempDb();
  try {
    migrateTo(db, '0004');   // a pre-0005 DB...
    db.prepare(`INSERT INTO entries (type, kind, title, summary) VALUES ('decision', 'signal', 't', 's')`).run();
    migrate(db);             // ...upgraded: must snapshot first
    const baks = readdirSync(dir).filter((f) => f.startsWith('collab.db.bak-0005_ulid_expand-'));
    assert.equal(baks.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate does not back up a brand-new empty DB', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain migrate() never applies staged migrations', () => {
  const { db, dir } = tempDb();
  try {
    migrateProd(db);
    const staged = db.prepare(`SELECT version FROM schema_migrations WHERE version LIKE '0005%'`).all();
    assert.deepEqual(staged, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate is idempotent', () => {
  const { db, dir } = tempDb();
  try {
    migrate(db);
    assert.deepEqual(migrate(db), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate refuses a version that exists in both migrations/ and staged/', () => {
  const { db, dir } = tempDb();
  const dupName = '0999_dup_probe.sql';
  const corePath = join(MIGRATIONS_DIR, dupName);
  const stagedPath = join(STAGED_DIR, dupName);
  const stagedDirExisted = existsSync(STAGED_DIR);
  try {
    if (!stagedDirExisted) mkdirSync(STAGED_DIR, { recursive: true });
    writeFileSync(corePath, 'SELECT 1;\n');
    writeFileSync(stagedPath, 'SELECT 1;\n');

    assert.throws(() => migrate(db), /0999_dup_probe/);
    const rows = db.prepare(`SELECT version FROM schema_migrations`).all();
    assert.deepEqual(rows, []);

    // Plain migrate() never scans staged/, so the same duplicate is invisible to it.
    assert.doesNotThrow(() => migrateProd(db));
  } finally {
    rmSync(corePath, { force: true });
    rmSync(stagedPath, { force: true });
    if (!stagedDirExisted) rmSync(STAGED_DIR, { recursive: true, force: true });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
