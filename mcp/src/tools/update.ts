import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface UpdateEntryArgs {
  id: number;
  title?: string;
  summary?: string;       // <= 200 chars; enforced here (DB also CHECKs)
  description?: string;
}

export interface UpdateEntryResult {
  id: number;
  updated_fields: string[];
}

// ------------------------------------------------------------
// updateEntry
// ------------------------------------------------------------
// Edits an existing entry's title/summary/description in place. The FTS index
// stays consistent automatically via the AFTER UPDATE trigger (trg_entries_fts_au),
// and updated_at is refreshed by trg_entries_updated_at — so a plain UPDATE is safe.
//
// Scope is deliberately minimal: refs are NOT mutated here (delete+reinsert is a
// future extension). Use this to correct/clarify durable entries, not to churn them.
export function updateEntry(db: DB, args: UpdateEntryArgs): UpdateEntryResult {
  if (!Number.isInteger(args.id) || args.id < 1) {
    throw new Error("id must be a positive integer");
  }

  const sets: string[] = [];
  const params: Record<string, string | number> = { id: args.id };
  const updated: string[] = [];

  if (args.title !== undefined) {
    if (args.title.trim().length === 0) throw new Error("title cannot be blank");
    sets.push("title = @title");
    params.title = args.title;
    updated.push("title");
  }

  if (args.summary !== undefined) {
    if (args.summary.trim().length === 0) throw new Error("summary cannot be blank");
    if (args.summary.length > 200) {
      throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
    }
    sets.push("summary = @summary");
    params.summary = args.summary;
    updated.push("summary");
  }

  if (args.description !== undefined) {
    sets.push("description = @description", "tokens_estimate = @tokens_estimate");
    params.description = args.description;
    params.tokens_estimate = estimateTokens(args.description);
    updated.push("description");
  }

  if (sets.length === 0) {
    throw new Error("nothing to update: provide at least one of title/summary/description");
  }

  const info = db
    .prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = @id`)
    .run(params);

  if (info.changes === 0) {
    throw new Error(`no entry found with id ${args.id}`);
  }

  return { id: args.id, updated_fields: updated };
}
