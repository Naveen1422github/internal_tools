// file: core/src/sync/changes.ts
import type { DB } from "../db.js";
import { SYNCED_TABLES } from "./enable.js";

// The unit of sharing is one crsql_changes row (spec D2). RawChange is the row
// as SQLite returns it; WireChange is its JSON form for HTTPS (blobs base64).

export interface RawChange {
  table: string; pk: Buffer; cid: string; val: unknown;
  col_version: number; db_version: number; site_id: Buffer; cl: number; seq: number;
}
export type WireVal = null | number | string | { b64: string };
export interface WireChange {
  table: string; pk: string; cid: string; val: WireVal;
  col_version: number; db_version: number; site_id: string; cl: number; seq: number;
}

const COLS = `"table", pk, cid, val, col_version, db_version, site_id, cl, seq`;

function encodeVal(v: unknown): WireVal {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) return { b64: v.toString("base64") };
  throw new Error(`cannot share a value of type ${typeof v}`);
}
function decodeVal(v: WireVal): unknown {
  if (v !== null && typeof v === "object") {
    if (typeof v.b64 !== "string") throw new Error("malformed change: bad blob value");
    return Buffer.from(v.b64, "base64");
  }
  return v;
}

export function encodeChange(r: RawChange): WireChange {
  return {
    table: r.table, pk: r.pk.toString("base64"), cid: r.cid, val: encodeVal(r.val),
    col_version: r.col_version, db_version: r.db_version, site_id: r.site_id.toString("base64"), cl: r.cl, seq: r.seq,
  };
}

const isInt = (x: unknown): x is number => Number.isInteger(x);
export function decodeChange(w: WireChange): RawChange {
  if (
    !w || typeof w.table !== "string" || typeof w.pk !== "string" || typeof w.cid !== "string" ||
    typeof w.site_id !== "string" || !isInt(w.col_version) || !isInt(w.db_version) || !isInt(w.cl) || !isInt(w.seq) ||
    !(w.val === null || ["number", "string", "object"].includes(typeof w.val))
  ) {
    throw new Error("malformed change");
  }
  return {
    table: w.table, pk: Buffer.from(w.pk, "base64"), cid: w.cid, val: decodeVal(w.val),
    col_version: w.col_version, db_version: w.db_version, site_id: Buffer.from(w.site_id, "base64"), cl: w.cl, seq: w.seq,
  };
}

/** This machine's OWN changes after `since` (never ones it received), in commit order. */
export function readOwnChanges(db: DB, since: number): WireChange[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM crsql_changes WHERE site_id = crsql_site_id() AND db_version > ? ORDER BY db_version, seq`)
    .all(since) as RawChange[];
  return rows.map(encodeChange);
}

/** The entry a change belongs to (null for modules rows or an unknown revision). */
export function entryUlidOf(db: DB, table: string, pk: Buffer): string | null {
  // .get() = the first cell. No LIMIT: cr-sqlite 0.16 rejects a LIMIT on this table-valued function.
  const first = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
  if (!first) return null;
  switch (table) {
    case "entries":
    case "refs":
    case "entry_modules":
      return String(first.cell);
    case "entry_revisions": {
      const r = db.prepare(`SELECT entry_ulid FROM entry_revisions WHERE rev_id = ?`).get(first.cell) as { entry_ulid: string } | undefined;
      return r?.entry_ulid || null;
    }
    default:
      return null;
  }
}

const SHARED = new Set<string>(SYNCED_TABLES);

/**
 * Apply received changes through cr-sqlite (the caller owns the transaction).
 * Re-applying a change is a no-op. Returns the entries touched, and those that
 * received revision rows (candidates for a merge on the post office).
 */
export function applyChanges(
  db: DB,
  raws: RawChange[],
  opts: { before?: (raw: RawChange) => void } = {},
): { entryUlids: Set<string>; revisedUlids: Set<string> } {
  for (const r of raws) {
    if (!SHARED.has(r.table)) throw new Error(`refusing a change to ${r.table}: it is not shared (notes only, D5)`);
  }
  const ins = db.prepare(`INSERT INTO crsql_changes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of raws) {
    opts.before?.(r);
    ins.run(r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq);
  }
  // Resolve ulids after ALL rows landed: a revision's entry_ulid may arrive after its key.
  const entryUlids = new Set<string>();
  const revisedUlids = new Set<string>();
  for (const r of raws) {
    const u = entryUlidOf(db, r.table, r.pk);
    if (!u) continue;
    entryUlids.add(u);
    if (r.table === "entry_revisions") revisedUlids.add(u);
  }
  return { entryUlids, revisedUlids };
}

/** D15: rebuild the FTS rows of these entries from entries (search must find what arrived). */
export function reindexFts(db: DB, ulids: Iterable<string>): void {
  const del = db.prepare(
    `DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?) AND ulid = ?`,
  );
  const ins = db.prepare(
    `INSERT INTO entries_fts (ulid, title, summary, description) SELECT ulid, title, summary, description FROM entries WHERE ulid = ?`,
  );
  for (const u of ulids) {
    del.run(`ulid:"${u.replace(/"/g, '""')}"`, u);
    ins.run(u);
  }
}
