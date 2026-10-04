// file: core/test/helpers/sync.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../../src/db.js';
import { enableSync } from '../../src/sync/enable.js';
import { isCrsqliteLoaded } from '../../src/sync/extension.js';

export type TestDb = { db: Database.Database; path: string; cleanup: () => void };

/** A fresh on-disk DB at 0007 (staged); `shared` also runs enableSync. */
export function freshDb(opts: { shared?: boolean } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'collab-sync-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  migrateTo(db, '0007', { includeStaged: true });
  if (opts.shared) enableSync(db);
  return {
    db, path,
    cleanup: () => {
      try { if (isCrsqliteLoaded(db)) db.prepare('SELECT crsql_finalize()').get(); db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Test stand-in for the post office: copy every change `from` holds after db_version `since` into `to`. */
export function ship(from: Database.Database, to: Database.Database, since = 0): number {
  const rows = from.prepare(
    `SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`,
  ).all(since) as any[];
  const ins = to.prepare(
    `INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  to.transaction(() => { for (const r of rows) ins.run(r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq); })();
  return rows.length;
}

export const dbVersion = (db: Database.Database): number =>
  (db.prepare('SELECT crsql_db_version() v').get() as { v: number }).v;

/** Changes this DB made itself (not ones it received). */
export const ownChanges = (db: Database.Database): Array<{ t: string; cid: string }> =>
  db.prepare(`SELECT "table" t, cid FROM crsql_changes WHERE site_id = crsql_site_id()`).all() as any[];
