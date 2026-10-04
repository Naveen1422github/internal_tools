import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import type { RefInput } from "./add.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOf, insertRefs, deleteRef } from "../entry-write.js";
import { snapshotForRevision, finishRevision } from "../revisions.js";
import { ensureCrsqlite } from "../sync/extension.js";

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
  ensureCrsqlite(db);
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

  // At 0006 id is not unique (E-648): resolve the owner (lowest live ulid;
  // tombstones never own) and write by ulid (F3). Before 0006 id is the PK.
  let where = "id = @id";
  if (hasUlidPrimaryKey(db)) {
    const owner = ownerOf(db, args.id);
    if (!owner) throw new Error(`no entry found with id ${args.id}`);
    params.ulid = owner.ulid as string;
    where = "ulid = @ulid";
  }

  // Spec "Edits write revisions": the snapshot/finish pair records the revision
  // in the same transaction as the edit (0007+; below 0007 the trigger does it).
  const tx = db.transaction(() => {
    const before = params.ulid ? snapshotForRevision(db, params.ulid as string) : null;
    const info = db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE ${where}`).run(params);
    if (info.changes === 0) throw new Error(`no entry found with id ${args.id}`);
    finishRevision(db, before);
  });
  tx();

  return { id: args.id, updated_fields: updated };
}

/**
 * Spec D8: a person settles a needs_merge note while keeping its current text
 * (to change the text, just edit it: any edit settles it). Folds every pending
 * head into one revision and clears the flag; replicates like any edit.
 */
export function resolveNeedsMerge(db: DB, id: number): { id: number } {
  ensureCrsqlite(db);
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  db.transaction(() => {
    const before = snapshotForRevision(db, owner.ulid as string);
    if (!before || before.needs_merge !== 1) throw new Error(`E-${id} is not waiting for a merge`);
    finishRevision(db, before);
  })();
  return { id };
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
  ensureCrsqlite(db);
  if (!Number.isInteger(args.id) || args.id < 1) {
    throw new Error("id must be a positive integer");
  }
  const toAdd = args.add ?? [];
  const toRemove = args.remove ?? [];
  if (toAdd.length === 0 && toRemove.length === 0) {
    throw new Error("nothing to do: provide at least one ref in 'add' or 'remove'");
  }

  // Owner by E-number (F3): lowest live ulid at 0006; tombstones refused.
  const owner = ownerOf(db, args.id);
  if (!owner) throw new Error(`no entry found with id ${args.id}`);

  const added: RefInput[] = [];
  const removed: RefInput[] = [];

  const tx = db.transaction(() => {
    for (const r of toRemove) {
      if (deleteRef(db, owner, r) > 0) removed.push(r);
    }
    for (const r of toAdd) {
      if (insertRefs(db, owner, [r]) > 0) added.push(r);
    }
  });
  tx();

  return { id: args.id, added, removed };
}
