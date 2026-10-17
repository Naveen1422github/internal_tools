// file: post-office/src/deliveries.ts
import { performance } from "node:perf_hooks";
import { decodeChange, encodeChange, applyChanges, type RawChange, type WireChange } from "@collab-mcp/core";
import type Database from "better-sqlite3";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { divergentStatusOrType, flagNeedsMerge, mergeEntries } from "./merge.js";
import { memberProjects } from "./access.js";

export const OFFICE_ORIGIN = "post-office";

const RECORD = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// R3: a member's change is recorded with its guessed project; stampProjects corrects it before commit.
const RECORD_STAMPED = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, project_ulid)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function lastSeq(db: Store): number {
  return (db.prepare(`SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries`).get() as { s: number }).s;
}

/** The office's own new writes (merges, needs_merge flags) become deliveries too. Returns the recorded rows. */
function recordOwnChanges(db: Store): DeliveryRow[] {
  const since = Number(getMeta(db, "self_db_version") ?? 0);
  const own = db
    .prepare(
      `SELECT "table", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes
        WHERE site_id = crsql_site_id() AND db_version > ? ORDER BY db_version, seq`,
    )
    .all(since) as RawChange[];
  const rec = db.prepare(RECORD);
  const rows: DeliveryRow[] = [];
  let top = since;
  for (const r of own) {
    const x = rec.run(OFFICE_ORIGIN, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq);
    if (x.changes === 1) rows.push({ seq: Number(x.lastInsertRowid), tbl: r.table, pk: r.pk, origin: OFFICE_ORIGIN, held: 0 });
    top = Math.max(top, r.db_version);
  }
  setMeta(db, "self_db_version", String(top));
  return rows;
}

// ---------------------------------------------------------------- R3: delivery by project
/**
 * First cell of a cr-sqlite packed pk when it is text, else null. Decoded here
 * because crsql_unpack_columns can't take a column of an outer query, and one
 * query per change would break the 5 ms budget (spec rule 6). Layout: [count]
 * then per cell [(lenBytes << 3) | type][length, big-endian][bytes]; text = 3.
 */
export function firstTextCell(pk: Buffer): string | null {
  if (pk.length < 2 || pk[0] < 1) return null;
  const tag = pk[1], n = tag >> 3;
  if ((tag & 7) !== 3 || n < 1 || n > 4 || pk.length < 2 + n) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + pk[2 + i];
  const at = 2 + n;
  return pk.length < at + len ? null : pk.toString("utf8", at, at + len);
}

/** A delivery to stamp. `stamp` = what its project_ulid holds now (undefined = NULL); `key` = firstTextCell(pk) when known. */
export interface DeliveryRow { seq: number; tbl: string; pk: Buffer; origin: string; held: number; stamp?: string | null; key?: string | null }
/** What a batch says about itself before it is applied: revision -> entry, entry -> project. */
interface Hints { rev: Map<string, string>; project: Map<string, string | null> }
interface Resolved { seq: number; tbl: string; origin: string; held: number; key: string | null; ulid: string | null; stamp: string | null }

// Prepared once per store: compiling the same SQL on every batch costs a share of the 5 ms budget.
const STMTS = new WeakMap<Store, Map<string, Database.Statement>>();
function prep(db: Store, sql: string): Database.Statement {
  let m = STMTS.get(db);
  if (!m) STMTS.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
}

const ENTRY_PROJECTS = `
SELECT e.ulid, e.project_ulid,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'project_ulid') AS hp,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'series') AS hs
  FROM entries e JOIN entries__crsql_pks p ON p.ulid = e.ulid
 WHERE e.ulid IN (SELECT value FROM json_each(?))`;

/** Each row's owning entry and stamp: two queries for any number of rows. `hints` overlay the store (pre-apply guess). */
function resolve(db: Store, rows: DeliveryRow[], hints?: Hints): Resolved[] {
  // A batch carries each pk once per cell: decode a pk only when it differs from the previous one.
  let lastPk: Buffer | null = null, lastKey: string | null = null;
  const keys = rows.map((r) => {
    if (r.tbl === "modules") return null;
    if (r.key !== undefined) return r.key;
    if (!lastPk || !lastPk.equals(r.pk)) { lastPk = r.pk; lastKey = firstTextCell(r.pk); }
    return lastKey;
  });
  // With hints (the pre-apply guess) the store is asked only what the batch doesn't say.
  const revSet = new Set<string>();
  rows.forEach((r, i) => { const k = keys[i]; if (r.tbl === "entry_revisions" && k && !hints?.rev.has(k)) revSet.add(k); });
  const revIds = [...revSet];
  const revEntry = new Map<string, string>();
  if (revIds.length) {
    for (const x of prep(db, `SELECT rev_id, entry_ulid FROM entry_revisions WHERE rev_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(revIds)) as Array<{ rev_id: string; entry_ulid: string }>) revEntry.set(x.rev_id, x.entry_ulid);
  }
  if (hints) for (const [r, u] of hints.rev) revEntry.set(r, u);
  const ulids = rows.map((r, i) => {
    const k = keys[i];
    if (!k) return null;
    switch (r.tbl) {
      case "entries": case "refs": case "entry_modules": return k;
      case "entry_revisions": return revEntry.get(k) ?? null;
      default: return null; // an unknown table is held, never sent to everyone
    }
  });
  // An entry's project is known only once the office holds its project_ulid cell (clock row).
  // No project cell but a series cell = a note whose cells are still arriving: held ('?').
  // Neither cell = a note written before 0009 (crsql_commit_alter gives old rows no clock
  // for new columns): it has no project (rule 2). The courier sends all of one note's
  // entries cells in one POST, so a fresh insert cut before `series` does not reach here.
  const project = new Map<string, string | null>();
  const wanted = [...new Set(ulids.filter((u): u is string => u !== null && !hints?.project.has(u)))];
  if (wanted.length) {
    for (const e of prep(db, ENTRY_PROJECTS).all(JSON.stringify(wanted)) as Array<{ ulid: string; project_ulid: string | null; hp: number; hs: number }>) {
      project.set(e.ulid, e.hp ? e.project_ulid : e.hs ? "?" : null);
    }
  }
  if (hints) for (const [u, p] of hints.project) project.set(u, p);
  return rows.map((r, i) => {
    const u = ulids[i];
    const stamp = r.tbl === "modules" ? null : u === null || !project.has(u) ? "?" : (project.get(u) as string | null);
    return { seq: r.seq, tbl: r.tbl, origin: r.origin, held: r.held, key: keys[i], ulid: u, stamp };
  });
}

/** One UPDATE per distinct stamp, not per row. */
function writeStamps(db: Store, rows: Resolved[]): void {
  const by = new Map<string | null, number[]>();
  for (const r of rows) {
    const list = by.get(r.stamp);
    if (list) list.push(r.seq); else by.set(r.stamp, [r.seq]);
  }
  const up = prep(db, `UPDATE po_deliveries SET project_ulid = ? WHERE seq IN (SELECT value FROM json_each(?))`);
  for (const [stamp, seqs] of by) up.run(stamp, JSON.stringify(seqs));
}

/**
 * The stamp each change will most likely get, from the store plus the batch's
 * own cells, so acceptChanges can record it with the row. stampProjects checks
 * it after the apply, in the same transaction: a wrong guess costs one UPDATE,
 * never a leak.
 */
function guessStamps(db: Store, raws: RawChange[]): Resolved[] {
  const hints: Hints = { rev: new Map(), project: new Map() };
  for (const r of raws) {
    if (r.table === "entry_revisions" && r.cid === "entry_ulid" && typeof r.val === "string") {
      const k = firstTextCell(r.pk);
      if (k) hints.rev.set(k, r.val);
    } else if (r.table === "entries" && r.cid === "project_ulid") {
      const k = firstTextCell(r.pk);
      if (k) hints.project.set(k, typeof r.val === "string" && r.val !== "" ? r.val : null);
    }
  }
  return resolve(db, raws.map((r) => ({ seq: 0, tbl: r.table, pk: r.pk, origin: "", held: 0 })), hints);
}

/**
 * R3, inside acceptChanges: stamp each new delivery with its entry's project
 * (NULL = no project, every member; '?' = entry not held yet, nobody). Rows held
 * earlier whose entry is now here are released at a NEW seq, so members whose
 * bookmark already passed them still get them. R4: the first `entries` row from
 * a member records the note's owner (the authenticated origin, never `author`).
 * `inHand` = rows acceptChanges just recorded (with the stamp it guessed), so
 * the batch is not read back.
 */
export function stampProjects(db: Store, seqs: number[], inHand?: DeliveryRow[]): void {
  if (!seqs.length) return;
  let fresh = inHand;
  if (!fresh) {
    // One batch's seqs are one ascending run: a primary-key range, then the exact set.
    const asked = new Set(seqs);
    fresh = (db
      .prepare(`SELECT seq, tbl, pk, origin, 0 AS held, project_ulid AS stamp FROM po_deliveries WHERE seq BETWEEN ? AND ?`)
      .all(Math.min(...seqs), Math.max(...seqs)) as DeliveryRow[]).filter((r) => asked.has(r.seq));
  }
  const mine = new Set(fresh.map((r) => r.seq));
  const held = (prep(db, `SELECT seq, tbl, pk, origin, 1 AS held FROM po_deliveries WHERE project_ulid = '?' ORDER BY seq`).all() as DeliveryRow[])
    .filter((r) => !mine.has(r.seq)); // a row of this batch guessed '?' is checked as fresh
  const all = [...held, ...fresh];
  const rows = resolve(db, all);
  writeStamps(db, rows.filter((r, i) => !r.held && r.stamp !== (all[i].stamp ?? null)));

  const owners = new Map<string, string>();
  for (const r of rows) {
    if (r.tbl === "entries" && r.stamp !== "?" && r.ulid && r.origin !== OFFICE_ORIGIN && !owners.has(r.ulid)) owners.set(r.ulid, r.origin);
  }
  if (owners.size) {
    prep(db,
      `INSERT OR IGNORE INTO po_note_owners (ulid, device_id)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`,
    ).run(JSON.stringify([...owners]));
  }

  const released = rows.filter((r) => r.held && r.stamp !== "?");
  if (!released.length) return;
  const get = prep(db, `SELECT * FROM po_deliveries WHERE seq = ?`);
  const del = prep(db, `DELETE FROM po_deliveries WHERE seq = ?`);
  const ins = prep(db, 
    `INSERT INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, received_at, project_ulid)
     VALUES (@origin, @tbl, @pk, @cid, @val, @col_version, @db_version, @site_id, @cl, @ch_seq, @received_at, @project_ulid)`,
  );
  for (const r of released) {
    const { seq: _s, ...row } = get.get(r.seq) as Record<string, unknown>;
    del.run(r.seq);
    ins.run({ ...row, project_ulid: r.stamp });
  }
}

/** R3 upgrade, once per store: stamp the deliveries recorded before RnR (openStore, after seedAccess). */
export function backfillProjectStamps(db: Store): void {
  if (getMeta(db, "deliveries_stamped")) return;
  db.transaction(() => {
    writeStamps(db, resolve(db, db.prepare(`SELECT seq, tbl, pk, origin, 0 AS held FROM po_deliveries`).all() as DeliveryRow[]).filter((r) => r.stamp !== null));
    setMeta(db, "deliveries_stamped", new Date().toISOString());
  }).immediate();
}

export interface AcceptResult { accepted: number; duplicates: number; lastSeq: number; officeWrote: boolean }

/**
 * One batch from one member, in ONE transaction: record (de-duplicated by the
 * change's cr-sqlite identity), apply, merge forked edits, flag diverging
 * status/type, record the office's own writes, stamp projects (R3). A resend
 * changes nothing. `opts` exists for the timing test only: `stamp: false`
 * skips R3, `timing.stampMs` receives the time R3 took.
 */
export function acceptChanges(
  db: Store, origin: string, wire: WireChange[], opts: { stamp?: boolean; timing?: { stampMs: number } } = {},
): AcceptResult {
  if (!Array.isArray(wire)) throw new StoreError("changes must be a list");
  let raws: RawChange[];
  try {
    raws = wire.map(decodeChange);
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  return db.transaction(() => {
    const stamp = opts.stamp !== false;
    let t0 = performance.now();
    const guess = stamp ? guessStamps(db, raws) : null;
    let stampMs = performance.now() - t0;
    const rec = prep(db, RECORD_STAMPED);
    const fresh: RawChange[] = [];
    const stamped: DeliveryRow[] = [];
    raws.forEach((r, i) => {
      const p = guess ? guess[i].stamp : null;
      const x = rec.run(origin, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq, p);
      if (x.changes === 1) {
        fresh.push(r);
        stamped.push({ seq: Number(x.lastInsertRowid), tbl: r.table, pk: r.pk, origin, held: 0, stamp: p, key: guess ? guess[i].key : undefined });
      }
    });
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
    const own = recordOwnChanges(db);
    t0 = performance.now();
    if (stamp) { const all = [...stamped, ...own]; stampProjects(db, all.map((r) => r.seq), all); }
    stampMs += performance.now() - t0;
    if (opts.timing) opts.timing.stampMs = stampMs;
    const officeWrote = own.length > 0;
    return { accepted: fresh.length, duplicates: raws.length - fresh.length, lastSeq: lastSeq(db), officeWrote };
  }).immediate();
}

export interface FetchResult { changes: WireChange[]; lastSeq: number; more: boolean }

/**
 * Deliveries after `after` except the caller's own and (R3) other projects':
 * a row goes out when it has no project or the caller holds note.view in it;
 * held ('?') rows go to nobody. `after` = what the caller has applied (its
 * bookmark); `lastSeq` still moves past filtered rows.
 */
export function fetchDeliveries(db: Store, deviceId: string, after: number, limit = 2000): FetchResult {
  if (!Number.isInteger(after) || after < 0) throw new StoreError("after must be a whole number >= 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError("limit must be 1..5000");
  const rows = db
    .prepare(
      `SELECT seq, origin, tbl AS "table", pk, cid, val, col_version, db_version, site_id, cl, ch_seq AS ch, project_ulid
         FROM po_deliveries WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(after, limit) as Array<RawChange & { seq: number; origin: string; ch: number; project_ulid: string | null }>;
  const mine = new Set(memberProjects(db, deviceId));
  db.prepare(`UPDATE po_members SET receive_bookmark = MAX(receive_bookmark, ?) WHERE device_id = ?`).run(after, deviceId);
  const changes = rows
    .filter((r) => r.origin !== deviceId && (r.project_ulid === null || mine.has(r.project_ulid)))
    .map(({ project_ulid: _p, ...r }) => encodeChange({ ...r, seq: r.ch }));
  return { changes, lastSeq: rows.length ? rows[rows.length - 1].seq : after, more: rows.length === limit };
}
