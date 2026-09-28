import type { DB } from "./db.js";

export interface BackfillReport {
  entries: number;
  refs: number;
  entryModules: number;
  superseded: number;
  authors: number;
  unresolvedEntryRefs: Array<{ entry_id: number; ref_value: string }>;
  skippedEntries: Array<{ id: number; created_at: string; error: string }>;
}

export function backfillUlids(_db: DB): BackfillReport {
  return { entries: 0, refs: 0, entryModules: 0, superseded: 0, authors: 0, unresolvedEntryRefs: [], skippedEntries: [] };
}
