import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import type { RefInput } from "./add.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOf, ownerOfRef, ownerOfUlid, insertRefs, deleteRef } from "../entry-write.js";
import { snapshotForRevision, finishRevision } from "../revisions.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { assertHeads, NeedsMergeError } from "./merge.js";
import { formatEntryRef } from "../entry-ref.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface UpdateEntryArgs {
  /** The note's number; omitted when `ulid` names the note. */
  id?: number;
  /** The note's series (stage B1): omitted = E, so `id` alone keeps meaning E-<id>. */
  series?: string;
  /** The note's ULID instead of its number: reaches a pending note too (stage C, spec P6). */
  ulid?: string;
  title?: string;
  summary?: string;       // <= 200 chars; enforced here (DB also CHECKs)
  description?: string;
}

export interface UpdateEntryResult {
  id: number | null; // null = the note is pending (stage C)
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
  if (args.ulid === undefined && (!Number.isInteger(args.id) || (args.id as number) < 1)) {
    throw new Error("id must be a positive integer");
  }

  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id: args.id ?? null };
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
  const series = args.series ?? "E";
  const label = args.ulid !== undefined ? args.ulid : series === "E" ? String(args.id) : formatEntryRef(args.id, series);
  if ((series !== "E" || args.ulid !== undefined) && !hasUlidPrimaryKey(db)) throw new Error(`no entry found with id ${label}`);
  let ownerId: number | null = args.id ?? null;
  if (hasUlidPrimaryKey(db)) {
    const owner = args.ulid !== undefined ? ownerOfUlid(db, args.ulid) : ownerOfRef(db, { series, id: args.id as number });
    if (!owner) throw new Error(`no entry found with id ${label}`);
    params.ulid = owner.ulid as string;
    ownerId = owner.id;
    where = "ulid = @ulid";
  }

  // Spec "Edits write revisions": the snapshot/finish pair records the revision
  // in the same transaction as the edit (0007+; below 0007 the trigger does it).
  const tx = db.transaction(() => {
    const before = params.ulid ? snapshotForRevision(db, params.ulid as string) : null;
    // V9: an ordinary edit would settle the conflict without seeing the other version.
    if (before?.needs_merge === 1) throw new NeedsMergeError(ownerId as number);
    const info = db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE ${where}`).run(params);
    if (info.changes === 0) throw new Error(`no entry found with id ${label}`);
    finishRevision(db, before);
  });
  tx();

  return { id: ownerId, updated_fields: updated };
}

/**
 * Spec D8: a person settles a needs_merge note while keeping its current text
 * (to change the text, use resolveWithText). `expectedHeads` are the versions the
 * person saw; if the set changed meanwhile, nothing is written (VersionsChangedError).
 * Folds every pending head into one revision and clears the flag; replicates like any edit.
 */
export function resolveNeedsMerge(db: DB, id: number, expectedHeads: string[]): { id: number } {
  ensureCrsqlite(db);
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  db.transaction(() => {
    const before = snapshotForRevision(db, owner.ulid as string);
    if (!before || before.needs_merge !== 1) throw new Error(`${formatEntryRef(id)} is not waiting for a merge`);
    assertHeads(db, id, owner.ulid as string, expectedHeads);
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
  /** The note's number; omitted when `ulid` names the note. */
  id?: number;
  /** The note's series (stage B1): omitted = E. */
  series?: string;
  /** The note's ULID instead of its number: reaches a pending note too (stage C, spec P6). */
  ulid?: string;
  add?: RefInput[];
  remove?: RefInput[];
}

export interface UpdateEntryRefsResult {
  id: number | null; // null = the note is pending (stage C)
  added: RefInput[];
  removed: RefInput[];
}

export function updateEntryRefs(db: DB, args: UpdateEntryRefsArgs): UpdateEntryRefsResult {
  ensureCrsqlite(db);
  if (args.ulid === undefined && (!Number.isInteger(args.id) || (args.id as number) < 1)) {
    throw new Error("id must be a positive integer");
  }
  const toAdd = args.add ?? [];
  const toRemove = args.remove ?? [];
  if (toAdd.length === 0 && toRemove.length === 0) {
    throw new Error("nothing to do: provide at least one ref in 'add' or 'remove'");
  }

  // Owner by E-number (F3): lowest live ulid at 0006; tombstones refused.
  const series = args.series ?? "E";
  const owner = args.ulid !== undefined ? ownerOfUlid(db, args.ulid) : ownerOfRef(db, { series, id: args.id as number });
  if (!owner) {
    throw new Error(`no entry found with id ${args.ulid ?? (series === "E" ? args.id : formatEntryRef(args.id, series))}`);
  }

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

  return { id: owner.id, added, removed };
}
