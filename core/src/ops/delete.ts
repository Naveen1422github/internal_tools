import type { DB } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";
import { ownerOf } from "../entry-write.js";

/**
 * After 0006: a tombstone (deleted_at). The row, its refs and its module rows
 * stay, so the delete can travel as data when sync lands (D5a). The E-number is
 * resolved to its owner (lowest live ulid) and the write keys on that ulid,
 * because id is not unique at 0006 (E-648, F3). A tombstone is never an owner,
 * so deleting an already-deleted number throws.
 *
 * Before 0006: the legacy hard delete by id (unique there); the cascade
 * triggers remove refs/module rows.
 */
export function deleteEntry(db: DB, id: number): { id: number; tombstoned: boolean } {
  if (!Number.isInteger(id) || id < 1) throw new Error("id must be a positive integer");
  if (hasUlidPrimaryKey(db)) {
    const owner = ownerOf(db, id);
    if (!owner) throw new Error(`no entry found with id ${id}`);
    db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE ulid = ? AND deleted_at IS NULL`).run(owner.ulid);
    return { id, tombstoned: true };
  }
  const info = db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
  if (info.changes === 0) throw new Error(`no entry found with id ${id}`);
  return { id, tombstoned: false };
}
