import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { hasUlidPrimaryKey } from "../schema.js";

/** The note at the other end of a link, found by its ULID (J17). */
export interface LinkTarget {
  ulid: string;
  id: number | null;       // null when the note isn't on this laptop
  title: string | null;
  deleted: boolean;        // tombstoned (D5b): still opens, labelled deleted
  present: boolean;        // false = ULID set, no such row here (not shared with you / not synced yet)
}

export interface EntryRef {
  ref_type: string;
  ref_value: string;
  /** ref_type 'entry', 0005+: the linked note, followed by ULID (J17). null = unresolved or pre-0005. */
  target?: LinkTarget | null;
}

export interface EntryFull {
  id: number;
  type: string;
  kind: string;
  title: string;
  summary: string;
  description: string | null;
  status: string;
  agent: string | null;
  module: string | null;       // PRIMARY module (back-compat)
  modules: string[];           // all modules via entry_modules (source of truth)
  category: string;            // Index | Reference | Activity
  superseded_by: number | null;
  task_id: string | null;
  tokens_estimate: number;
  rollup_of_task: string | null;
  deprecated: number;       // 0 or 1
  created_at: string;
  updated_at: string;
  ulid?: string;
  deleted_at?: string | null;   // 0006+: set on a tombstone (D5b)
  /** 0005+: the note at superseded_by_ulid, followed by ULID (J17). null = not superseded or pre-0005. */
  superseded_target?: LinkTarget | null;
  refs: EntryRef[];
}

type EntryRow = Omit<EntryFull, "refs" | "modules" | "superseded_target"> & { ulid: string; superseded_by_ulid?: string | null };

export function getEntry(db: DB, id: number): EntryFull | null {
  // A tombstoned entry is still returned, with deleted_at set (decision D5b):
  // links like E-214 keep showing what they pointed at. If an E-number is
  // ever shared, prefer the live entry, then the lowest ulid. (deleted_at only
  // exists from 0006 on.)
  const order = hasUlidPrimaryKey(db) ? "ORDER BY deleted_at IS NOT NULL, ulid" : "";
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ? ${order} LIMIT 1`)
    .get(id) as EntryRow | undefined;
  return row ? assemble(db, row) : null;
}

/** The note with this ULID (tombstones included, D5b), or null. 0005+ only. */
export function getEntryByUlid(db: DB, ulid: string): EntryFull | null {
  if (!hasUlidColumns(db)) return null;
  const row = db.prepare(`SELECT * FROM entries WHERE ulid = ?`).get(ulid) as EntryRow | undefined;
  return row ? assemble(db, row) : null;
}

function assemble(db: DB, row: EntryRow): EntryFull {
  const byUlid = hasUlidColumns(db); // 0005+: refs.target_ulid, entries.superseded_by_ulid
  const deletedCol = hasUlidPrimaryKey(db) ? "t.deleted_at IS NOT NULL" : "0"; // deleted_at: 0006+

  // `modules` is not a column; it is assembled from entry_modules below.
  let refs: EntryRef[];
  if (byUlid) {
    const rows = db
      .prepare(
        `SELECT r.ref_type, r.ref_value, r.target_ulid, t.ulid AS t_ulid, t.id AS t_id, t.title AS t_title, ${deletedCol} AS t_deleted
           FROM refs r LEFT JOIN entries t ON t.ulid = r.target_ulid
          WHERE r.entry_ulid = ? ORDER BY r.ref_type, r.ref_value`,
      )
      .all(row.ulid) as Array<EntryRef & { target_ulid: string | null } & TargetCols>;
    refs = rows.map((r) => {
      const ref: EntryRef = { ref_type: r.ref_type, ref_value: r.ref_value };
      if (r.ref_type === "entry" && r.target_ulid) ref.target = toTarget(r.target_ulid, r);
      return ref;
    });
  } else {
    // Pre-0005: no ULIDs anywhere; side tables are keyed by the number.
    refs = db
      .prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_id = ? ORDER BY ref_type, ref_value`)
      .all(row.id) as EntryRef[];
  }

  const [key, val] = byUlid ? ["entry_ulid", row.ulid] : ["entry_id", row.id];
  const modules = (
    db
      .prepare(`SELECT module FROM entry_modules WHERE ${key} = ? ORDER BY is_primary DESC, module ASC`)
      .all(val) as Array<{ module: string }>
  ).map((m) => m.module);

  const full: EntryFull = { ...row, modules, refs };
  if (byUlid) {
    const s = row.superseded_by_ulid ?? null;
    full.superseded_target = s === null ? null : toTarget(s,
      db.prepare(`SELECT t.ulid AS t_ulid, t.id AS t_id, t.title AS t_title, ${deletedCol} AS t_deleted FROM entries t WHERE t.ulid = ?`)
        .get(s) as TargetCols | undefined);
  }
  return full;
}

interface TargetCols { t_ulid: string | null; t_id: number | null; t_title: string | null; t_deleted: number | null }

function toTarget(ulid: string, r: TargetCols | undefined): LinkTarget {
  if (!r || r.t_ulid === null) return { ulid, id: null, title: null, deleted: false, present: false };
  return { ulid, id: r.t_id, title: r.t_title, deleted: r.t_deleted === 1, present: true };
}
