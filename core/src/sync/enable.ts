import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { loadCrsqlite, hasCrrTables } from "./extension.js";
import { hasSyncState, isSyncEnabled, setSyncValue } from "./state.js";

// Spec D5: notes only. tasks, FTS, local_counters and sync_state stay local.
export const SYNCED_TABLES = ["entries", "refs", "entry_modules", "entry_revisions", "modules"] as const;

// Triggers that write rows on their own. While cr-sqlite applies a REMOTE
// change its sync bit is 1 and their writes would be untracked (never
// replicated), so the receiver would silently diverge. FTS triggers are NOT
// here: the search index is local and must follow received rows (D15).
const GUARDED_TRIGGERS_SQL: Array<[name: string, sql: string]> = [
  ["trg_entries_updated_at", `CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category,
                superseded_by, deleted_at
ON entries FOR EACH ROW WHEN crsql_internal_sync_bit() = 0
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE ulid = OLD.ulid;
END`],
  ["trg_modules_updated_at", `CREATE TRIGGER trg_modules_updated_at
AFTER UPDATE ON modules FOR EACH ROW WHEN crsql_internal_sync_bit() = 0
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END`],
  ["trg_entries_fill_superseded_ulid", `CREATE TRIGGER trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
WHEN crsql_internal_sync_bit() = 0
 AND NEW.superseded_by IS NOT OLD.superseded_by
 AND NEW.superseded_by_ulid IS OLD.superseded_by_ulid
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = NEW.superseded_by ORDER BY e.ulid LIMIT 1)
   WHERE ulid = NEW.ulid;
END`],
  ["trg_refs_fill_target_ulid", `CREATE TRIGGER trg_refs_fill_target_ulid
AFTER INSERT ON refs
WHEN crsql_internal_sync_bit() = 0 AND NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
BEGIN
  UPDATE refs SET target_ulid = (
    SELECT e.ulid FROM entries e WHERE e.id = (
      SELECT CAST(d AS INTEGER) FROM (
        SELECT CASE
          WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
          WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
          WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
          ELSE s
        END AS d
        FROM (SELECT upper(trim(NEW.ref_value, ' ' || char(9,10,11,12,13,160))) AS s)
      )
      WHERE d <> '' AND d NOT GLOB '*[^0-9]*' AND CAST(d AS INTEGER) > 0
    )
    ORDER BY e.ulid LIMIT 1
  )
  WHERE entry_ulid = NEW.entry_ulid AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END`],
  ["trg_refs_cascade_delete", `CREATE TRIGGER trg_refs_cascade_delete
AFTER DELETE ON entries WHEN crsql_internal_sync_bit() = 0
BEGIN
  DELETE FROM refs WHERE entry_ulid = old.ulid;
END`],
  ["trg_entry_modules_cascade_delete", `CREATE TRIGGER trg_entry_modules_cascade_delete
AFTER DELETE ON entries WHEN crsql_internal_sync_bit() = 0
BEGIN
  DELETE FROM entry_modules WHERE entry_ulid = old.ulid;
END`],
];

export function enableSync(
  db: DB,
  opts: { backup?: boolean } = {},
): { alreadyEnabled: boolean; tables: string[]; backup: string | null } {
  if (!hasUlidPrimaryKey(db)) throw new Error("enableSync needs migration 0006 (ULID primary key)");
  if (!hasSyncState(db)) throw new Error("enableSync needs migration 0007_sync_prep");
  if (isSyncEnabled(db)) return { alreadyEnabled: true, tables: [...SYNCED_TABLES], backup: null };

  let backup: string | null = null;
  if (opts.backup) {
    backup = `${db.name}.bak-sync-enable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    db.prepare("VACUUM INTO ?").run(backup);
  }
  loadCrsqlite(db);
  const tx = db.transaction(() => {
    for (const t of SYNCED_TABLES) db.prepare(`SELECT crsql_as_crr(?)`).get(t);
    for (const [name, sql] of GUARDED_TRIGGERS_SQL) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(sql);
    }
    setSyncValue(db, "enabled", "1");
  });
  tx();
  return { alreadyEnabled: false, tables: [...SYNCED_TABLES], backup };
}

/** The guarded trigger SQL with its guard removed: the 0006 body again. */
function unguard(sql: string): string {
  return sql
    .replace(/WHEN crsql_internal_sync_bit\(\) = 0\s+AND /g, "WHEN ")
    .replace(/\s*WHEN crsql_internal_sync_bit\(\) = 0\n/g, "\n");
}

/**
 * Undo enableSync (`collab sync uninstall`). The shared tables become plain
 * tables again (cr-sqlite's crsql_as_table drops its clocks and triggers), the
 * bookkeeping triggers get their 0006 bodies back, every sync_state key goes
 * (the machine key with it) and `enabled` becomes '0': new notes get local
 * numbers again. Notes are untouched. The DB then opens without cr-sqlite.
 */
export function disableSync(db: DB): { wasEnabled: boolean } {
  if (!hasSyncState(db)) return { wasEnabled: false };
  const wasEnabled = isSyncEnabled(db);
  if (!wasEnabled && !hasCrrTables(db)) return { wasEnabled };
  loadCrsqlite(db);
  db.transaction(() => {
    for (const t of SYNCED_TABLES) db.prepare(`SELECT crsql_as_table(?)`).get(t);
    for (const [name, sql] of GUARDED_TRIGGERS_SQL) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(unguard(sql));
    }
    db.prepare(`DELETE FROM sync_state WHERE key <> 'enabled'`).run();
    setSyncValue(db, "enabled", "0");
  })();
  return { wasEnabled };
}
