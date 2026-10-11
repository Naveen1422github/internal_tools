import type { DB } from "./db.js";

/**
 * True once migration 0006 has made entries.ulid the primary key.
 * Deliberately NOT cached (same reason as hasUlidColumns): migrate() can run
 * between two calls on one open handle.
 */
export function hasUlidPrimaryKey(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'ulid' AND pk = 1`).get();
}

/**
 * True once migration 0009 has added `entries.series` (and `project_ulid`).
 * Not cached, for the same reason as hasUlidPrimaryKey.
 */
export function hasSeries(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'series'`).get();
}

/**
 * True once migration 0010 has added `projects.left_at` (stage B2, P11).
 * Not cached, for the same reason as hasUlidPrimaryKey.
 */
export function hasProjectLeft(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name = 'left_at'`).get();
}

/** True once migration 0011 has created the local `project_modules` table (module -> project binding). */
export function hasProjectModules(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_modules'`).get();
}

/** SQL predicate that hides tombstoned entries. Before 0006 there is no deleted_at column. */
export function liveEntry(db: DB, alias = "e"): string {
  return hasUlidPrimaryKey(db) ? `${alias}.deleted_at IS NULL` : "1 = 1";
}

/**
 * JOIN from entries_fts to entries: by ulid (0006 own-copy FTS, where ulid is
 * an indexed FTS column) or by rowid = id (0005 external-content FTS).
 */
export function ftsJoin(db: DB, alias = "e"): string {
  return hasUlidPrimaryKey(db)
    ? `JOIN entries ${alias} ON ${alias}.ulid = entries_fts.ulid`
    : `JOIN entries ${alias} ON ${alias}.id = entries_fts.rowid`;
}
