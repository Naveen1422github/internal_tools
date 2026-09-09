import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import type { RefInput } from "./add.js";

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

// ------------------------------------------------------------
// updateEntryRefs — add/remove structured refs on an EXISTING entry
//
// Fills a real gap: addEntry sets refs once at creation and updateEntry does NOT
// touch them, so there was no way to wire a link after the fact (e.g. link a new
// decision into the roadmap Index hub it extends). Without this, retro-wiring
// falls back to prose mentions, which no machine/lint can traverse.
//
// Idempotent by design: add uses INSERT OR IGNORE (re-adding an existing ref is a
// no-op), remove is a plain DELETE (removing a missing ref is a no-op). The
// returned added/removed lists report what ACTUALLY changed, not what was asked —
// so callers can tell a real edit from a no-op.
// ------------------------------------------------------------
export interface UpdateEntryRefsArgs {
  id: number;
  add?: RefInput[];
  remove?: RefInput[];
}

export interface UpdateEntryRefsResult {
  id: number;
  added: RefInput[];
  removed: RefInput[];
}

export function updateEntryRefs(db: DB, args: UpdateEntryRefsArgs): UpdateEntryRefsResult {
  if (!Number.isInteger(args.id) || args.id < 1) {
    throw new Error("id must be a positive integer");
  }
  const toAdd = args.add ?? [];
  const toRemove = args.remove ?? [];
  if (toAdd.length === 0 && toRemove.length === 0) {
    throw new Error("nothing to do: provide at least one ref in 'add' or 'remove'");
  }

  const exists = db.prepare(`SELECT 1 FROM entries WHERE id = ?`).get(args.id);
  if (!exists) throw new Error(`no entry found with id ${args.id}`);

  const added: RefInput[] = [];
  const removed: RefInput[] = [];

  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)`
  );
  const deleteRef = db.prepare(
    `DELETE FROM refs WHERE entry_id = ? AND ref_type = ? AND ref_value = ?`
  );

  const tx = db.transaction(() => {
    for (const r of toRemove) {
      const info = deleteRef.run(args.id, r.ref_type, r.ref_value);
      if (info.changes > 0) removed.push(r);
    }
    for (const r of toAdd) {
      const info = insertRef.run(args.id, r.ref_type, r.ref_value);
      if (info.changes > 0) added.push(r);
    }
  });
  tx();

  return { id: args.id, added, removed };
}
