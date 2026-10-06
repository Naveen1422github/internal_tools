import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOfRef, type InsertedEntry } from "../entry-write.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { formatNoteRef } from "../entry-ref.js";
import type { NoteRef } from "../ulid.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface SupersedeArgs {
  ids: Array<number | NoteRef>; // entries being replaced (a bare number = E, stage B1)
  by: number | NoteRef;         // the entry that replaces them
}

export interface SupersedeResult {
  superseded: number[];
  by: number;
}

const asRef = (v: number | NoteRef): NoteRef => (typeof v === "number" ? { series: "E", id: v } : v);
const keyOf = (r: NoteRef) => `${r.series}:${r.id}`;

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
  const by = asRef(args.by);

  // 'by' must exist (and not be tombstoned). Resolved via ownerOfRef: at 0006
  // an E-number may be shared, and the lowest live ulid owns it (F3).
  const byOwner = ownerOfRef(db, by);
  if (!byOwner) {
    throw new Error(`'by' entry ${formatNoteRef(by)} does not exist`);
  }

  // 'by' must not supersede itself.
  const refs = ids.map(asRef);
  if (refs.some((r) => keyOf(r) === keyOf(by))) {
    throw new Error(`'by' (${formatNoteRef(by)}) cannot be one of the superseded 'ids'`);
  }

  // Every id must exist.
  const unique = [...new Map(refs.map((r) => [keyOf(r), r])).values()];
  const owners = new Map<string, InsertedEntry | null>(unique.map((r) => [keyOf(r), ownerOfRef(db, r)]));
  const missing = unique.filter((r) => owners.get(keyOf(r)) === null);
  if (missing.length > 0) {
    throw new Error(
      `the following 'ids' do not exist: ${missing.map((r) => formatNoteRef(r)).join(", ")}`,
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
  const tx = db.transaction((targets: NoteRef[]) => {
    for (const r of targets) {
      const target = owners.get(keyOf(r))!;
      update.run({
        by: by.id,
        ...(withTwin ? { byUlid: byOwner.ulid } : {}),
        ...(byUlid ? { ulid: target.ulid } : { id: r.id }),
      });
    }
  });
  tx(unique);

  return { superseded: unique.map((r) => r.id), by: by.id };
}
