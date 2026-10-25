// file: post-office/src/deliveries.ts
import { performance } from "node:perf_hooks";
import { decodeChange, encodeChange, applyChanges, type RawChange, type WireChange } from "@collab-mcp/core";
import type Database from "better-sqlite3";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { divergentStatusOrType, flagNeedsMerge, mergeEntries } from "./merge.js";
import { memberProjects } from "./access.js";
import { classify, REFUSED_BEFORE, type Refusal, type Verdict } from "./classify.js";
import { writeBack } from "./writeback.js";
import { eStamp, isEAdoptedOffice } from "./e-adopt.js";

export const OFFICE_ORIGIN = "post-office";
/**
 * Fix round 1 (ruling a): an office write-back for a refused change the sender can't
 * view by stamp (a non-member's edit of an E note it already holds) is recorded with
 * origin `post-office>{sender}`: it goes to that sender whatever its stamp, and to
 * the stamp's members as usual. No schema change. Every other office row keeps OFFICE_ORIGIN.
 */
export const WRITEBACK_TO = `${OFFICE_ORIGIN}>`;
export const isOfficeOrigin = (origin: string) => origin === OFFICE_ORIGIN || origin.startsWith(WRITEBACK_TO);

const RECORD = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// R3: a member's change is recorded with its guessed project; stampProjects corrects it before commit.
export const RECORD_STAMPED = `INSERT OR IGNORE INTO po_deliveries (origin, tbl, pk, cid, val, col_version, db_version, site_id, cl, ch_seq, project_ulid)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function lastSeq(db: Store): number {
  return (db.prepare(`SELECT COALESCE(MAX(seq), 0) s FROM po_deliveries`).get() as { s: number }).s;
}

/** The office's own new writes (merges, needs_merge flags) become deliveries too. Returns the recorded rows. */
export function recordOwnChanges(db: Store): DeliveryRow[] {
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

/**
 * Every cell of a packed pk when all are text (refs: entry_ulid, ref_type,
 * ref_value), else null. Same layout as firstTextCell.
 */
export function textCells(pk: Buffer): string[] | null {
  if (pk.length < 1) return null;
  const out: string[] = [];
  let at = 1;
  for (let c = 0; c < pk[0]; c++) {
    if (at >= pk.length) return null;
    const tag = pk[at], n = tag >> 3;
    if ((tag & 7) !== 3 || n < 1 || n > 4 || pk.length < at + 1 + n) return null;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + pk[at + 1 + i];
    at += 1 + n;
    if (pk.length < at + len) return null;
    out.push(pk.toString("utf8", at, at + len));
    at += len;
  }
  return out;
}

/**
 * A delivery to stamp. `stamp` = what its project_ulid holds now (undefined = NULL); `key` = firstTextCell(pk)
 * and `ulid` = its note, when known (R-29: no second lookup). `final` = the stamp is the note's held project
 * (the office had its project cell before this batch, and S2-1 refuses a move): not checked again.
 * `owned` = po_note_owners already names its note's owner.
 */
export interface DeliveryRow { seq: number; tbl: string; pk: Buffer; origin: string; held: number; stamp?: string | null; key?: string | null; ulid?: string | null; final?: boolean; owned?: boolean }
/** What a batch says about itself before it is applied: revision -> entry, entry -> project. */
export interface Hints { rev: Map<string, string>; project: Map<string, string | null> }
interface Resolved { seq: number; tbl: string; origin: string; held: number; key: string | null; ulid: string | null; stamp: string | null }

// Prepared once per store: compiling the same SQL on every batch costs a share of the 5 ms budget.
const STMTS = new WeakMap<Store, Map<string, Database.Statement>>();
export function prep(db: Store, sql: string): Database.Statement {
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

/** revision id -> its entry, as the office holds it: one query for any number. */
export function revisionEntries(db: Store, revIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!revIds.length) return out;
  for (const x of prep(db, `SELECT rev_id, entry_ulid FROM entry_revisions WHERE rev_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(revIds)) as Array<{ rev_id: string; entry_ulid: string }>) out.set(x.rev_id, x.entry_ulid);
  return out;
}

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
  rows.forEach((r, i) => { const k = keys[i]; if (r.tbl === "entry_revisions" && r.ulid === undefined && k && !hints?.rev.has(k)) revSet.add(k); });
  const revEntry = revisionEntries(db, [...revSet]);
  if (hints) for (const [r, u] of hints.rev) revEntry.set(r, u);
  const ulids = rows.map((r, i) => {
    if (r.ulid !== undefined) return r.ulid;
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
  const wanted = [...new Set(ulids.filter((u, i): u is string => u !== null && !rows[i].final && !hints?.project.has(u)))];
  if (wanted.length) {
    for (const e of prep(db, ENTRY_PROJECTS).all(JSON.stringify(wanted)) as Array<{ ulid: string; project_ulid: string | null; hp: number; hs: number }>) {
      project.set(e.ulid, e.hp ? e.project_ulid : e.hs ? "?" : null);
    }
  }
  if (hints) for (const [u, p] of hints.project) project.set(u, p);
  // Task 4: once the office adopted E, a note with no project is delivered as E (modules rows stay NULL).
  const adopted = isEAdoptedOffice(db);
  return rows.map((r, i) => {
    const u = ulids[i];
    const stamp = r.final ? r.stamp ?? null : r.tbl === "modules" ? null : u === null || !project.has(u) ? "?" : (project.get(u) as string | null);
    return { seq: r.seq, tbl: r.tbl, origin: r.origin, held: r.held, key: keys[i], ulid: u, stamp: eStamp(adopted, r.tbl, stamp) };
  });
}

/** resolve() for adoptE's restamp: each row's seq and the stamp its note gets now. */
export function resolveStamps(db: Store, rows: DeliveryRow[]): Array<{ seq: number; stamp: string | null }> {
  return resolve(db, rows).map((r) => ({ seq: r.seq, stamp: r.stamp }));
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
function guessStamps(db: Store, raws: RawChange[]): Array<Resolved & { final: boolean; owned?: boolean }> {
  return resolve(db, raws.map((r) => ({ seq: 0, tbl: r.table, pk: r.pk, origin: "", held: 0 })), batchHints(raws)).map((r) => ({ ...r, final: false }));
}

/**
 * R-29: the same guess from classify's own reading, for a batch it accepted whole
 * (a refused group's cells must not hint, so a partly refused batch takes the path
 * above). No second pk decode, hints pass or office query. A note the office held
 * with its project cell keeps that project (S2-1 refuses a move): its stamp is final.
 */
function guessFromVerdict(raws: RawChange[], v: Verdict, adopted: boolean): Array<Resolved & { final: boolean; owned?: boolean }> {
  return raws.map((r, i) => {
    const u = v.ulids[i];
    let stamp: string | null = "?", final = false, owned = false;
    if (r.table === "modules") stamp = null;
    else if (u !== null) {
      if (v.hints.project.has(u)) stamp = v.hints.project.get(u)!;
      else {
        const h = v.held.get(u);
        if (h) { stamp = h.hp ? h.project_ulid : h.hs ? "?" : null; final = !!h.hp; owned = h.owner !== null; }
      }
    }
    return { seq: 0, tbl: r.table, origin: "", held: 0, key: r.table === "modules" ? null : v.keys[i], ulid: u, stamp: eStamp(adopted, r.table, stamp), final, owned };
  });
}

/** The batch's own revision -> entry and entry -> project cells (the last project cell wins). */
export function batchHints(raws: RawChange[]): Hints {
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
  return hints;
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
  // R-29: a final stamp is the guess, already recorded: only the other rows are resolved again.
  const open = fresh.some((r) => r.final) ? all.filter((r) => !r.final) : all;
  const rows = resolve(db, open);
  writeStamps(db, rows.filter((r, i) => !r.held && r.stamp !== (open[i].stamp ?? null)));

  const owners = new Map<string, string>();
  const own = (tbl: string, stamp: string | null, ulid: string | null, origin: string) => {
    if (tbl === "entries" && stamp !== "?" && ulid && !isOfficeOrigin(origin) && !owners.has(ulid)) owners.set(ulid, origin);
  };
  for (const r of rows) own(r.tbl, r.stamp, r.ulid, r.origin);
  if (open !== all) for (const r of fresh) if (r.final && !r.owned) own(r.tbl, r.stamp ?? null, r.ulid ?? null, r.origin);
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

/** R3: every delivery up to this seq was stamped by an RnR office (acceptChanges moves it). */
const STAMPED_UPTO = "deliveries_stamped_upto";
const SET_STAMPED_UPTO = `INSERT INTO po_meta (key, value) VALUES ('${STAMPED_UPTO}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * R3 upgrade, on every open (after seedAccess): stamp the deliveries past the
 * watermark. They were recorded before RnR, or by an older office binary run
 * after it (a rollback), so their NULL means "never stamped", not "no project".
 * A store stamped by the first RnR binary (boolean meta only) counts as
 * stamped up to its last seq.
 */
export function backfillProjectStamps(db: Store): void {
  db.transaction(() => {
    const top = lastSeq(db);
    const upto = getMeta(db, STAMPED_UPTO);
    const from = upto !== null ? Number(upto) : getMeta(db, "deliveries_stamped") ? top : 0;
    if (from < top) {
      const rows = db.prepare(`SELECT seq, tbl, pk, origin, 0 AS held FROM po_deliveries WHERE seq > ? AND project_ulid IS NULL`).all(from) as DeliveryRow[];
      writeStamps(db, resolve(db, rows).filter((r) => r.stamp !== null));
    }
    if (upto === null || Number(upto) !== top) prep(db, SET_STAMPED_UPTO).run(String(top));
    // Kept for an older RnR binary, which checks only this.
    if (!getMeta(db, "deliveries_stamped")) setMeta(db, "deliveries_stamped", new Date().toISOString());
  }).immediate();
}

export interface AcceptResult { accepted: number; duplicates: number; lastSeq: number; officeWrote: boolean; refused: Refusal[] }
export interface AcceptTiming { stampMs: number; classifyMs?: number; writeBackMs?: number }

const SAME_DELIVERY = `SELECT 1 FROM po_deliveries WHERE site_id = ? AND db_version = ? AND ch_seq = ? AND tbl = ? AND pk = ? AND cid = ?`;

/**
 * R7: a refused creation is recorded once, and the held ('?') rows of its note are
 * deleted, never released: a creation cut across batches is judged in the half
 * carrying its project cell, so the first half is already held here.
 */
function refuseCreations(db: Store, origin: string, dead: Map<string, Refusal>): void {
  const ins = prep(db, `INSERT OR IGNORE INTO po_refused_notes (ulid, device_id, key, reason) VALUES (?, ?, ?, ?)`);
  for (const [u, r] of dead) ins.run(u, origin, r.key, r.reason);
  const held = prep(db, `SELECT seq, tbl, pk FROM po_deliveries WHERE project_ulid = '?'`).all() as Array<{ seq: number; tbl: string; pk: Buffer }>;
  if (!held.length) return;
  const keys = held.map((h) => firstTextCell(h.pk));
  const revs = revisionEntries(db, held.flatMap((h, i) => (h.tbl === "entry_revisions" && keys[i] ? [keys[i]!] : [])));
  const gone = held.filter((h, i) => {
    const k = keys[i];
    if (!k || h.tbl === "modules") return false;
    return dead.has(h.tbl === "entry_revisions" ? revs.get(k) ?? "" : k);
  });
  if (gone.length) prep(db, `DELETE FROM po_deliveries WHERE seq IN (SELECT value FROM json_each(?))`).run(JSON.stringify(gone.map((h) => h.seq)));
}

/**
 * One batch from one member, in ONE transaction: judge it (R4/R5), record (de-
 * duplicated by the change's cr-sqlite identity) and apply only the groups its
 * role allows, merge forked edits, flag diverging status/type, write the office's
 * value back over refused groups (R6), record the office's own writes, stamp
 * projects (R3). A resend changes nothing: a refused group gets the same refusal
 * and no second write-back. `opts` exists for the timing test only: `stamp: false`
 * skips R3, `timing` receives the time R3, R4 and R6 took.
 */
export function acceptChanges(
  db: Store, origin: string, wire: WireChange[], opts: { stamp?: boolean; timing?: AcceptTiming; oldStampPath?: boolean } = {},
): AcceptResult {
  if (!Array.isArray(wire)) throw new StoreError("changes must be a list");
  let all: RawChange[];
  try {
    all = wire.map(decodeChange);
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  return db.transaction(() => {
    const stamp = opts.stamp !== false;
    // R4/R5: only allowed groups go on. A refused group already recorded is a resend of
    // what was accepted before (the role changed since): a duplicate, not a refusal.
    let t0 = performance.now();
    const verdict = classify(db, origin, all);
    let raws = all, out: RawChange[] = [], dupes = 0;
    const refused: Refusal[] = [];
    const dead = new Map<string, Refusal>();
    if ([...verdict.groups.values()].some((r) => r !== null)) {
      const same = prep(db, SAME_DELIVERY);
      const resent = new Map<string, boolean>();
      const outGroup: string[] = [];
      raws = [];
      all.forEach((r, i) => {
        const g = verdict.groupOf[i];
        if (!verdict.groups.get(g)) { raws.push(r); return; }
        if (resent.get(g) !== false) resent.set(g, !!same.get(r.site_id, r.db_version, r.seq, r.table, r.pk, r.cid));
        out.push(r); outGroup.push(g);
      });
      out = out.filter((_, i) => (resent.get(outGroup[i]) ? (dupes++, false) : true));
      for (const [u, g] of verdict.creations) {
        const r = verdict.groups.get(g);
        if (r && !resent.get(g)) dead.set(u, r);
      }
      // R7: every group of a note refused at creation (now or before) names the key
      // its creation was refused for, so a resend gets the same refusal.
      const first = prep(db, `SELECT key, reason FROM po_refused_notes WHERE ulid = ?`);
      for (const [g, r] of verdict.groups) {
        if (!r || resent.get(g)) continue;
        if (r.reason === REFUSED_BEFORE && r.ulid) {
          const now = dead.get(r.ulid);
          const was = now && now.reason !== REFUSED_BEFORE ? now : (first.get(r.ulid) as { key: string | null; reason: string | null } | undefined);
          if (was?.reason) { refused.push({ ...r, key: was.key, reason: was.reason }); continue; }
        }
        refused.push(r);
      }
    }
    const classifyMs = performance.now() - t0;

    t0 = performance.now();
    // `oldStampPath`: the equivalence test's reference (R-29), never set in production.
    const guess = !stamp ? null : raws === all && !opts.oldStampPath ? guessFromVerdict(raws, verdict, isEAdoptedOffice(db)) : guessStamps(db, raws);
    let stampMs = performance.now() - t0;
    const rec = prep(db, RECORD_STAMPED);
    const fresh: RawChange[] = [];
    const stamped: DeliveryRow[] = [];
    raws.forEach((r, i) => {
      const p = guess ? guess[i].stamp : null;
      const x = rec.run(origin, r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq, p);
      if (x.changes === 1) {
        fresh.push(r);
        const gi = guess?.[i];
        stamped.push(gi && !opts.oldStampPath
          ? { seq: Number(x.lastInsertRowid), tbl: r.table, pk: r.pk, origin, held: 0, stamp: p, key: gi.key, ulid: gi.ulid, final: gi.final, owned: gi.owned }
          : { seq: Number(x.lastInsertRowid), tbl: r.table, pk: r.pk, origin, held: 0, stamp: p, key: gi?.key });
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
    // R6/R7: refused creations first (writeBack skips their notes), then the write-backs,
    // recorded and stamped by writeBack itself before recordOwnChanges.
    t0 = performance.now();
    if (dead.size) refuseCreations(db, origin, dead);
    const wb = writeBack(db, out, verdict.noteProjects, origin);
    const writeBackMs = performance.now() - t0;
    const own = recordOwnChanges(db);
    t0 = performance.now();
    const mine = [...stamped, ...own];
    if (stamp) stampProjects(db, mine.map((r) => r.seq), mine);
    const seq = lastSeq(db);
    if (stamp && (mine.length || wb.length)) prep(db, SET_STAMPED_UPTO).run(String(seq)); // R3 watermark: stamped up to here
    stampMs += performance.now() - t0;
    if (opts.timing) Object.assign(opts.timing, { stampMs, classifyMs, writeBackMs });
    // Review Focus 2: any office write (merge, flag, write-back) rings the sender too.
    const officeWrote = own.length + wb.length > 0;
    return { accepted: fresh.length, duplicates: raws.length - fresh.length + dupes, lastSeq: seq, officeWrote, refused };
  }).immediate();
}

export interface FetchResult { changes: WireChange[]; lastSeq: number; more: boolean }

const DELIVERY_COLS = `seq, origin, tbl AS "table", pk, cid, val, col_version, db_version, site_id, cl, ch_seq AS ch`;
type DeliveryWire = RawChange & { seq: number; origin: string; ch: number };
const toWire = ({ seq: _s, origin: _o, ...r }: DeliveryWire): WireChange => encodeChange({ ...r, seq: r.ch });

/**
 * Deliveries after `after` except the caller's own and (R3) other projects':
 * a row goes out when it has no project or the caller holds note.view in it;
 * held ('?') rows go to nobody. `after` = what the caller has applied (its
 * bookmark); `lastSeq` still moves past filtered rows.
 */
export function fetchDeliveries(db: Store, deviceId: string, after: number, limit = 2000): FetchResult {
  if (!Number.isInteger(after) || after < 0) throw new StoreError("after must be a whole number >= 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError("limit must be 1..5000");
  return db.transaction((): FetchResult => {
    const rows = db
      .prepare(
        `SELECT ${DELIVERY_COLS}, project_ulid
           FROM po_deliveries WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(after, limit) as Array<DeliveryWire & { project_ulid: string | null }>;
    const mine = new Set(memberProjects(db, deviceId));
    // R14 barrier: a project owed a replay goes only through the replay, so an edit of an
    // old note cannot reach the laptop before the note itself.
    const owed = new Set(
      (db.prepare(`SELECT project_ulid FROM po_replays WHERE device_id = ?`).all(deviceId) as Array<{ project_ulid: string }>).map((r) => r.project_ulid),
    );
    db.prepare(`UPDATE po_members SET receive_bookmark = MAX(receive_bookmark, ?) WHERE device_id = ?`).run(after, deviceId);
    const top = rows.length ? rows[rows.length - 1].seq : after;
    const withheld = new Set<string>();
    const forMe = WRITEBACK_TO + deviceId;
    const changes = rows
      .filter((r) => {
        if (r.origin === forMe) return true; // the undo of this device's own refused change (ruling a)
        if (r.origin === deviceId || (r.project_ulid !== null && !mine.has(r.project_ulid))) return false;
        if (r.project_ulid !== null && owed.has(r.project_ulid)) { withheld.add(r.project_ulid); return false; }
        return true;
      })
      .map(({ project_ulid: _p, ...r }) => toWire(r));
    // lastSeq moves past the withheld rows, so the replay must now reach them.
    const raise = db.prepare(`UPDATE po_replays SET upto_seq = MAX(upto_seq, ?) WHERE device_id = ? AND project_ulid = ?`);
    for (const p of withheld) raise.run(top, deviceId, p);
    return { changes, lastSeq: top, more: rows.length === limit };
  }).immediate();
}

export interface ReplayResult { changes: WireChange[]; last_seq: number; more: boolean; done: boolean }

/**
 * R14: the project's past changes, once, for a device newly given note.view (the
 * normal bookmark already passed them). Only rows stamped with this project, up
 * to the seq the grant happened at; NULL rows already went to everyone and held
 * ('?') rows are released at a new seq. The po_replays row goes only on the
 * confirming call (after >= upto_seq), so a crash mid-replay just resumes.
 */
export function fetchReplay(db: Store, deviceId: string, projectUlid: string, after: number, limit = 2000): ReplayResult {
  if (!Number.isInteger(after) || after < 0) throw new StoreError("after must be a whole number >= 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError("limit must be 1..5000");
  const finish = (): ReplayResult => ({ changes: [], last_seq: after, more: false, done: true });
  return db.transaction(() => {
    const rep = db.prepare(`SELECT upto_seq FROM po_replays WHERE device_id = ? AND project_ulid = ?`).get(deviceId, projectUlid) as { upto_seq: number } | undefined;
    if (!rep) return finish();
    const member = db.prepare(`SELECT 1 FROM po_project_members WHERE device_id = ? AND project_ulid = ?`).get(deviceId, projectUlid);
    if (!member || after >= rep.upto_seq) {
      db.prepare(`DELETE FROM po_replays WHERE device_id = ? AND project_ulid = ?`).run(deviceId, projectUlid);
      return finish();
    }
    const rows = db
      .prepare(`SELECT ${DELIVERY_COLS} FROM po_deliveries WHERE project_ulid = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
      .all(projectUlid, after, rep.upto_seq, limit) as DeliveryWire[];
    const more = rows.length === limit;
    return {
      changes: rows.filter((r) => r.origin !== deviceId).map(toWire),
      last_seq: more ? rows[rows.length - 1].seq : rep.upto_seq,
      more,
      done: false,
    };
  }).immediate();
}
