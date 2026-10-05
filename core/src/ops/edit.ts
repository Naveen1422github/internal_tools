import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { KIND_BY_TYPE, type RefType } from "../constants.js";
import { validateEntryInput } from "../validate.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOfRef, replaceLinks, insertEntryModules } from "../entry-write.js";
import type { NoteRef } from "../ulid.js";
import { formatEntryRef } from "../entry-ref.js";
import { snapshotForRevision, finishRevision } from "../revisions.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { NeedsMergeError } from "./merge.js";

// The REST server's note writes, moved here unchanged (collab E-720): every
// write to a synced table goes through core (revisions, checks, future rules).

export class EntryNotFoundError extends Error {
  constructor(id: number, series = "E") {
    super(`entry ${series === "E" ? id : formatEntryRef(id, series)} not found`);
    this.name = "EntryNotFoundError";
  }
}

export interface EditEntryArgs {
  id: number;
  /** The note's series (stage B1): omitted = E. */
  series?: string;
  type: string;
  title: string;
  summary: string;
  description?: string | null;
  agent?: string | null;
  module?: string | null;
  modules?: string[];
  category?: string;
  task_id?: string | null;
  refs?: Array<{ ref_type?: string; ref_value?: string; type?: string; value?: string }>;
}

/** Rewrite an entry's fields and replace ALL its refs and module rows (the REST upsert's edit semantics). */
export function editEntry(db: DB, args: EditEntryArgs): { id: number } {
  ensureCrsqlite(db);
  const { id, type, title, summary, description, agent, module, modules, category, task_id, refs } = args;
  const v = validateEntryInput({ type, title, summary, category });
  if (!v.ok) throw new Error(v.errors[0]);
  const kind = KIND_BY_TYPE[type as keyof typeof KIND_BY_TYPE];
  const resolvedCategory = v.category!;

  const moduleCandidates = [
    ...(module ? [module] : []),
    ...(Array.isArray(modules) ? modules : []),
  ];
  const orderedModules: string[] = [];
  for (const m of moduleCandidates) {
    const cleaned = typeof m === "string" ? m.trim() : "";
    if (cleaned && !orderedModules.includes(cleaned)) orderedModules.push(cleaned);
  }
  const primaryModule = orderedModules.length ? orderedModules[0] : null;
  const normRefs = (Array.isArray(refs) ? refs : []).map((r) => ({
    ref_type: (r.ref_type || r.type) as RefType,
    ref_value: (r.ref_value || r.value) as string,
  }));

  // Resolve the E-number to its owner (lowest live ulid at 0006, where id is
  // not unique; F3) and write by the level's real key.
  const series = args.series ?? "E";
  const owner = ownerOfRef(db, { series, id: Number(id) });
  if (!owner) throw new EntryNotFoundError(id, series);
  const byUlid = hasUlidPrimaryKey(db);
  const tokens = estimateTokens(description);
  const tx = db.transaction(() => {
    // Spec "Edits write revisions" (0007+; no-op below 0007).
    const before = byUlid ? snapshotForRevision(db, owner.ulid as string) : null;
    if (before?.needs_merge === 1) throw new NeedsMergeError(owner.id); // V9
    db.prepare(`
      UPDATE entries SET type=?, kind=?, title=?, summary=?, description=?, agent=?, module=?, task_id=?, tokens_estimate=?, category=?
      WHERE ${byUlid ? "ulid = ?" : "id = ?"}
    `).run(type, kind, title, summary, description, agent, primaryModule, task_id, tokens, resolvedCategory, byUlid ? owner.ulid : owner.id);
    replaceLinks(db, owner, orderedModules, primaryModule, normRefs);
    finishRevision(db, before);
  });
  tx();
  return { id: owner.id };
}

/** Make `module` the primary module of each entry in `ids`. Unknown ids are skipped. */
export function reassignModule(db: DB, ids: Array<number | NoteRef>, module: string): { updated: number } {
  ensureCrsqlite(db);
  const exists = db.prepare("SELECT slug FROM modules WHERE slug = ?").get(module);
  if (!exists) throw new Error(`target module '${module}' does not exist`);

  // Works at 0005 and 0006: no ON CONFLICT(entry_id, module) (that PK is gone
  // at 0006). Writes key on the level's real key, as entry-write.ts does (F3):
  // ulid at 0006; id / entry_id at 0005, where a link row's entry_ulid is only
  // trigger-filled and may be NULL.
  const byUlid = hasUlidPrimaryKey(db);
  const entryKey = byUlid ? "ulid" : "id";
  const linkKey = byUlid ? "entry_ulid" : "entry_id";
  const setPrimary = db.prepare(`UPDATE entries SET module = ? WHERE ${entryKey} = ?`);
  const clearOld = db.prepare(`DELETE FROM entry_modules WHERE ${linkKey} = ? AND is_primary = 1`);
  const promote = db.prepare(`UPDATE entry_modules SET is_primary = 1 WHERE ${linkKey} = ? AND module = ?`);
  // A bare number means E (stage B1); a NoteRef can name a project note.
  const refs = ids.map((v): NoteRef => (typeof v === "object" && v !== null ? v : { series: "E", id: Number(v) }));
  const uniqueRefs = [...new Map(refs.map((r) => [`${r.series}:${r.id}`, r])).values()];
  let updated = 0;
  const tx = db.transaction(() => {
    for (const ref of uniqueRefs) {
      const owner = ownerOfRef(db, ref);
      if (!owner) continue;
      const key = byUlid ? owner.ulid : owner.id;
      setPrimary.run(module, key);
      clearOld.run(key);
      // Promote an existing secondary membership, or add a new primary one.
      if (promote.run(key, module).changes === 0) insertEntryModules(db, owner, [module], module);
      updated += 1;
    }
  });
  tx();
  return { updated };
}
