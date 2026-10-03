import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { loadCrsqlite } from "./extension.js";
import { hasSyncState, isSyncEnabled, setSyncValue } from "./state.js";

// Spec D5: notes only. tasks, FTS, local_counters and sync_state stay local.
export const SYNCED_TABLES = ["entries", "refs", "entry_modules", "entry_revisions", "modules"] as const;

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
    setSyncValue(db, "enabled", "1");
  });
  tx();
  return { alreadyEnabled: false, tables: [...SYNCED_TABLES], backup };
}
