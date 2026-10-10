import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { type InsertedEntry } from "../entry-write.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { formatNoteRef } from "../entry-ref.js";
import type { NoteRef } from "../ulid.js";
import { ownerOfKey, type NoteKey } from "./get.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface SupersedeArgs {
  /** Entries being replaced: a bare number = E (stage B1); `{ ulid }` reaches a pending note (stage C). */
  ids: Array<number | NoteKey>;
  by: number | NoteKey;         // the entry that replaces them
}

export interface SupersedeResult {
  superseded: Array<number | null>; // null = a pending note (stage C)
  by: number | null;
}

const asKey = (v: number | NoteKey): NoteKey => (typeof v === "number" ? { series: "E", id: v } : v);
const keyOf = (k: NoteKey) => ("ulid" in k ? `ulid:${k.ulid}` : `${k.series}:${k.id}`);
const labelOf = (k: NoteKey) => ("ulid" in k ? k.ulid : formatNoteRef(k as NoteRef));

// ------------------------------------------------------------
// supersede — mark old entries as replaced by a newer one.
//
// Sets superseded_by = by AND deprecated = 1 on each id, so the originals drop
// out of default retrieval (include_deprecated=false hides them) but stay as
// history. The existing FTS update trigger keeps the index in sync. The
// replacement is written by its ULID (superseded_by_ulid); the integer
// superseded_by stays a label.
// ------------------------------------------------------------
export function supersede(db: DB, args: SupersedeArgs): SupersedeResult {
  ensureCrsqlite(db);
  const { ids } = args;

  if (!ids || ids.length === 0) {
    throw new Error("supersede requires a non-empty 'ids' array");
  }
  const by = asKey(args.by);

  // 'by' must exist (and not be tombstoned). Resolved via ownerOfRef: at 0006
  // an E-number may be shared, and the lowest live ulid owns it (F3). A ULID
  // reaches a pending note (stage C).
  const byOwner = ownerOfKey(db, by);
  if (!byOwner) {
    throw new Error(`'by' entry ${labelOf(by)} does not exist`);
  }

  // Every id must exist.
  const keys = ids.map(asKey);
  const unique = [...new Map(keys.map((k) => [keyOf(k), k])).values()];
  const owners = new Map<string, InsertedEntry | null>(unique.map((k) => [keyOf(k), ownerOfKey(db, k)]));

  // 'by' must not supersede itself (by key, or the same note named two ways).
  if (unique.some((k) => keyOf(k) === keyOf(by) || (byOwner.ulid !== null && owners.get(keyOf(k))?.ulid === byOwner.ulid))) {
    throw new Error(`'by' (${labelOf(by)}) cannot be one of the superseded 'ids'`);
  }

  const missing = unique.filter((k) => owners.get(keyOf(k)) === null);
  if (missing.length > 0) {
    throw new Error(
      `the following 'ids' do not exist: ${missing.map(labelOf).join(", ")}`,
    );
  }

  // Write the ULID twin ourselves; 0006's trigger only repairs legacy writers.
  // At 0006 the target row is addressed by its ulid (F3); before, by id (unique).
  const byUlid = hasUlidPrimaryKey(db);
  const withTwin = hasUlidColumns(db);
  const update = db.prepare(
    `UPDATE entries SET superseded_by = @by${withTwin ? ", superseded_by_ulid = @byUlid" : ""}, deprecated = 1
      WHERE ${byUlid ? "ulid = @ulid" : "id = @id"}`,
  );
  const tx = db.transaction((targets: NoteKey[]) => {
    for (const k of targets) {
      const target = owners.get(keyOf(k))!;
      update.run({
        by: byOwner.id,
        ...(withTwin ? { byUlid: byOwner.ulid } : {}),
        ...(byUlid ? { ulid: target.ulid } : { id: target.id }),
      });
    }
  });
  tx(unique);

  return { superseded: unique.map((k) => owners.get(keyOf(k))!.id), by: byOwner.id };
}
