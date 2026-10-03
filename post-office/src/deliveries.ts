// file: post-office/src/deliveries.ts
import { decodeChange, encodeChange, applyChanges, type RawChange, type WireChange } from "@collab-mcp/core";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { divergentStatusOrType, flagNeedsMerge, mergeEntries } from "./merge.js";

export const OFFICE_ORIGIN = "post-office";

const RECORD = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function lastSeq(db: Store): number {
  return (db.prepare(`SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries`).get() as { s: number }).s;
}

/** The office's own new writes (merges, needs_merge flags) become deliveries too. */
function recordOwnChanges(db: Store): number {
  const since = Number(getMeta(db, "self_db_version") ?? 0);
  const own = db
    .prepare(
      `SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes
        WHERE site_id = crsql_site_id() AND db_version > ? ORDER BY db_version, seq`,
    )
    .all(since) as RawChange[];
  const rec = db.prepare(RECORD);
  let n = 0;
  let top = since;
  for (const r of own) {
    n += rec.run(OFFICE_ORIGIN, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq).changes;
    top = Math.max(top, r.db_version);
  }
  setMeta(db, "self_db_version", String(top));
  return n;
}

export interface AcceptResult { accepted: number; duplicates: number; lastSeq: number; officeWrote: boolean }

/**
 * One batch from one member, in ONE transaction: record (de-duplicated by the
 * change's cr-sqlite identity), apply, merge forked edits, flag diverging
 * status/type, record the office's own writes. A resend changes nothing.
 */
export function acceptChanges(db: Store, origin: string, wire: WireChange[]): AcceptResult {
  if (!Array.isArray(wire)) throw new StoreError("changes must be a list");
  let raws: RawChange[];
  try {
    raws = wire.map(decodeChange);
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  return db.transaction(() => {
    const rec = db.prepare(RECORD);
    const fresh: RawChange[] = [];
    for (const r of raws) {
      if (rec.run(origin, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq).changes === 1) fresh.push(r);
    }
    const diverged = new Set<string>();
    let applied: ReturnType<typeof applyChanges>;
    try {
      applied = applyChanges(db, fresh, {
        before: (r) => {
          const u = divergentStatusOrType(db, r);
          if (u) diverged.add(u);
        },
      });
    } catch (e) {
      throw new StoreError((e as Error).message);
    }
    mergeEntries(db, applied.revisedUlids);
    for (const u of diverged) flagNeedsMerge(db, u);
    const officeWrote = recordOwnChanges(db) > 0;
    return { accepted: fresh.length, duplicates: raws.length - fresh.length, lastSeq: lastSeq(db), officeWrote };
  }).immediate();
}

export interface FetchResult { changes: WireChange[]; lastSeq: number; more: boolean }

/** Deliveries after `after` except the caller's own. `after` = what the caller has applied (its bookmark). */
export function fetchDeliveries(db: Store, deviceId: string, after: number, limit = 2000): FetchResult {
  if (!Number.isInteger(after) || after < 0) throw new StoreError("after must be a whole number >= 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError("limit must be 1..5000");
  const rows = db
    .prepare(
      `SELECT seq, origin, tbl AS "table", pk, cid, val, col_version, db_version, site_id, cl, ch_seq AS ch
         FROM po_deliveries WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(after, limit) as Array<RawChange & { seq: number; origin: string; ch: number }>;
  db.prepare(`UPDATE po_members SET receive_bookmark = MAX(receive_bookmark, ?) WHERE device_id = ?`).run(after, deviceId);
  const changes = rows
    .filter((r) => r.origin !== deviceId)
    .map((r) => encodeChange({ ...r, seq: r.ch }));
  return { changes, lastSeq: rows.length ? rows[rows.length - 1].seq : after, more: rows.length === limit };
}
