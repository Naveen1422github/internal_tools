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
  module: string | null;
  task_id: string | null;
  tokens_estimate: number;
  rollup_of_task: string | null;
  deprecated: number;       // 0 or 1
  created_at: string;
  updated_at: string;
  refs: EntryRef[];
}

export function getEntry(db: DB, id: number): EntryFull | null {
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ?`)
    .get(id) as Omit<EntryFull, "refs"> | undefined;
  if (!row) return null;

  const refs = db
    .prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_id = ? ORDER BY ref_type, ref_value`)
    .all(id) as EntryRef[];

  return { ...row, refs };
}
