import type { DB } from "../db.js";

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
  refs: EntryRef[];
}

export function getEntry(db: DB, id: number): EntryFull | null {
  // `modules` is not a column — it's assembled from entry_modules below.
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ?`)
    .get(id) as Omit<EntryFull, "refs" | "modules"> | undefined;
  if (!row) return null;

  const refs = db
    .prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_id = ? ORDER BY ref_type, ref_value`)
    .all(id) as EntryRef[];

  const moduleRows = db
    .prepare(
      `SELECT module FROM entry_modules WHERE entry_id = ? ORDER BY is_primary DESC, module ASC`,
    )
    .all(id) as Array<{ module: string }>;
  const modules = moduleRows.map((m) => m.module);

  return { ...row, modules, refs };
}
