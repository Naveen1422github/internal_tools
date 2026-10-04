import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOf, type InsertedEntry } from "../entry-write.js";
import { ensureCrsqlite } from "../sync/extension.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface SupersedeArgs {
  ids: number[]; // entries being replaced
  by: number;    // the entry that replaces them
}

export interface SupersedeResult {
  superseded: number[];
  by: number;
}

function toEntryId(id: number): string {
  return `E-${String(id).padStart(5, "0")}`;
}

// ------------------------------------------------------------
// supersede — mark old entries as replaced by a newer one.
//
// Sets superseded_by = by AND deprecated = 1 on each id, so the originals drop
// out of default retrieval (include_deprecated=false hides them) but stay as
// history. The existing FTS update trigger keeps the index in sync.
// ------------------------------------------------------------
export function supersede(db: DB, args: SupersedeArgs): SupersedeResult {
  ensureCrsqlite(db);
  const { ids, by } = args;

  if (!ids || ids.length === 0) {
    throw new Error("supersede requires a non-empty 'ids' array");
  }

  // 'by' must exist (and not be tombstoned). Resolved via ownerOf: at 0006
  // an E-number may be shared, and the lowest live ulid owns it (F3).
  const byOwner = ownerOf(db, by);
  if (!byOwner) {
    throw new Error(`'by' entry ${toEntryId(by)} does not exist`);
  }

  // 'by' must not supersede itself.
  if (ids.includes(by)) {
    throw new Error(`'by' (${toEntryId(by)}) cannot be one of the superseded 'ids'`);
  }

  // Every id must exist.
  const uniqueIds = [...new Set(ids)];
  const owners = new Map<number, InsertedEntry | null>(uniqueIds.map((id) => [id, ownerOf(db, id)]));
  const missing = uniqueIds.filter((id) => owners.get(id) === null);
  if (missing.length > 0) {
    throw new Error(
      `the following 'ids' do not exist: ${missing.map(toEntryId).join(", ")}`,
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
  const tx = db.transaction((targetIds: number[]) => {
    for (const id of targetIds) {
      const target = owners.get(id)!;
      update.run({
        by,
        ...(withTwin ? { byUlid: byOwner.ulid } : {}),
        ...(byUlid ? { ulid: target.ulid } : { id }),
      });
    }
  });
  tx(uniqueIds);

  return { superseded: uniqueIds, by };
}
