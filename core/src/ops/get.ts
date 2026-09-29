import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";

export interface EntryRef {
  ref_type: string;
  ref_value: string;
}

export interface EntryFull {
  id: number;
  type: string;
  kind: string;
  title: string;
  summary: string;
  description: string | null;
  status: string;
  agent: string | null;
  module: string | null;       // PRIMARY module (back-compat)
  modules: string[];           // all modules via entry_modules (source of truth)
  category: string;            // Index | Reference | Activity
  superseded_by: number | null;
  task_id: string | null;
  tokens_estimate: number;
  rollup_of_task: string | null;
  deprecated: number;       // 0 or 1
  created_at: string;
  updated_at: string;
  ulid?: string;
  deleted_at?: string | null;   // 0006+: set on a tombstone (D5b)
  refs: EntryRef[];
}

export function getEntry(db: DB, id: number): EntryFull | null {
  // A tombstoned entry is still returned, with deleted_at set (decision D5b):
  // links like E-214 keep showing what they pointed at. If an E-number is
  // ever shared, prefer the live entry, then the lowest ulid. (deleted_at only
  // exists from 0006 on.)
  const order = hasUlidPrimaryKey(db) ? "ORDER BY deleted_at IS NOT NULL, ulid" : "";
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ? ${order} LIMIT 1`)
    .get(id) as (Omit<EntryFull, "refs" | "modules"> & { ulid: string }) | undefined;
  if (!row) return null;

  // `modules` is not a column; it is assembled from entry_modules below.
  const refs = db
    .prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_ulid = ? ORDER BY ref_type, ref_value`)
    .all(row.ulid) as EntryRef[];

  const modules = (
    db
      .prepare(`SELECT module FROM entry_modules WHERE entry_ulid = ? ORDER BY is_primary DESC, module ASC`)
      .all(row.ulid) as Array<{ module: string }>
  ).map((m) => m.module);

  return { ...row, modules, refs };
}
