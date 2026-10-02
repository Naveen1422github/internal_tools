import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../../src/db.js';

// Dual-level fixture (0006 Task 3). Later tasks run every changed read/write
// through testAtEachLevel. Stable API: Level, LEVELS, dbAt, testAtEachLevel,
// assertFtsIntact.

export type Level = '0005' | '0006';
export const LEVELS: Level[] = ['0005', '0006'];

/**
 * A fresh on-disk DB migrated to exactly `level`. 0005 is released; 0006 is
 * staged, so includeStaged is always passed and migrateTo's prefix cap keeps
 * a '0005' DB at 0005.
 */
export function dbAt(level: Level): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `collab-${level}-`));
  const db = new Database(join(dir, 'collab.db'));
  migrateTo(db, level, { includeStaged: true });
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * One test per schema level. The merged branch runs on the live 0005 DB until
 * 0006 goes live, so every changed read/write must pass at BOTH levels
 * (0005's worst review bug was an insert that threw on the older schema).
 */
export function testAtEachLevel(name: string, fn: (db: Database.Database, level: Level) => void): void {
  for (const level of LEVELS) {
    test(`${name} [${level}]`, () => {
      const { db, cleanup } = dbAt(level);
      try { fn(db, level); } finally { cleanup(); }
    });
  }
}

/** E-684 rule: every test that writes through FTS ends with this. Throws if the FTS index is corrupt. */
export function assertFtsIntact(db: Database.Database): void {
  db.prepare(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`).run();
}
