import type { DB } from "../db.js";

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
  const { ids, by } = args;

  if (!ids || ids.length === 0) {
    throw new Error("supersede requires a non-empty 'ids' array");
  }

  // 'by' must exist.
  const byRow = db.prepare(`SELECT id FROM entries WHERE id = ?`).get(by) as
    | { id: number }
    | undefined;
  if (!byRow) {
    throw new Error(`'by' entry ${toEntryId(by)} does not exist`);
  }

  // 'by' must not supersede itself.
  if (ids.includes(by)) {
    throw new Error(`'by' (${toEntryId(by)}) cannot be one of the superseded 'ids'`);
  }

  // Every id must exist.
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id FROM entries WHERE id IN (${placeholders})`)
    .all(...uniqueIds) as Array<{ id: number }>;
  const foundSet = new Set(found.map((r) => r.id));
  const missing = uniqueIds.filter((id) => !foundSet.has(id));
  if (missing.length > 0) {
    throw new Error(
      `the following 'ids' do not exist: ${missing.map(toEntryId).join(", ")}`,
    );
  }

  const update = db.prepare(
    `UPDATE entries SET superseded_by = ?, deprecated = 1 WHERE id = ?`,
  );
  const tx = db.transaction((targetIds: number[]) => {
    for (const id of targetIds) {
      update.run(by, id);
    }
  });
  tx(uniqueIds);

  return { superseded: uniqueIds, by };
}
