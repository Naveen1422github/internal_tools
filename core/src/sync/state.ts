import type { DB } from "../db.js";

// sync_state is LOCAL-ONLY (never a CRR): this machine's sharing settings.
export function hasSyncState(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'`).get();
}
export function getSyncValue(db: DB, key: string): string | null {
  if (!hasSyncState(db)) return null;
  const r = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setSyncValue(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
/** Sharing is on for this DB: E-numbers must come from the post office (spec D7, E-708). */
export function isSyncEnabled(db: DB): boolean {
  return getSyncValue(db, "enabled") === "1";
}
