import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo, getDb, closeDb } from '../src/db.js';
import { crsqlitePath, hasCrrTables, loadCrsqlite, isCrsqliteLoaded, CrsqliteMissingError } from '../src/sync/extension.js';

/** Fresh on-disk DB at 0007 (0007 is staged, so includeStaged). */
export function db0007(): { db: Database.Database; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-sync-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  migrateTo(db, '0007', { includeStaged: true });
  return { db, path, cleanup: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test('the cr-sqlite extension is available (run npm run fetch:crsqlite)', () => {
  assert.ok(crsqlitePath(), 'vendor/crsqlite missing: run `npm run fetch:crsqlite`');
});

test('a plain DB has no CRR tables and loads without the extension', () => {
  const { db, cleanup } = db0007();
  try {
    assert.equal(hasCrrTables(db), false);
    assert.equal(isCrsqliteLoaded(db), false);
  } finally { cleanup(); }
});

test('loadCrsqlite makes crsql functions available', () => {
  const { db, cleanup } = db0007();
  try {
    loadCrsqlite(db);
    assert.equal(isCrsqliteLoaded(db), true);
  } finally { db.prepare('SELECT crsql_finalize()').get(); cleanup(); }
});

test('getDb refuses a CRR database when the extension cannot be found', () => {
  const { db, path, cleanup } = db0007();
  try {
    loadCrsqlite(db);
    db.prepare(`SELECT crsql_as_crr('modules')`).get();
    db.prepare('SELECT crsql_finalize()').get();
    db.close();
    const saved = process.env.COLLAB_CRSQLITE_PATH;
    process.env.COLLAB_CRSQLITE_PATH = join(tmpdir(), 'definitely-not-here', 'crsqlite');
    try {
      assert.throws(() => getDb(path), CrsqliteMissingError);
    } finally {
      if (saved === undefined) delete process.env.COLLAB_CRSQLITE_PATH; else process.env.COLLAB_CRSQLITE_PATH = saved;
      closeDb();
    }
    const again = getDb(path); // default path finds vendor/ -> loads fine
    assert.equal(isCrsqliteLoaded(again), true);
    closeDb(); // must finalize without throwing
  } finally { cleanup(); }
});
