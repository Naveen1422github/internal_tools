// file: post-office/src/writeback.ts
import { rootRevId, type RawChange } from "@collab-mcp/core";
import type { Store } from "./store.js";
import { OFFICE_ORIGIN, RECORD_STAMPED, firstTextCell, textCells, prep, revisionEntries, type DeliveryRow } from "./deliveries.js";
import { eStamp, isEAdoptedOffice } from "./e-adopt.js";

// RnR S2, R6: the office's undo of a refused group. Mechanism (b) of the spike
// (docs/superpowers/plans/2026-10-18-collab-rnr-s2-spike.md §1, §2): insert into
// crsql_changes under the office's own crsql_site_id(), with a forced col_version,
// so recordOwnChanges delivers it as an OFFICE_ORIGIN change and the sender's
// laptop reverts when it pulls.
//
// R-13: only notes the office holds get a write-back. A refused creation (and
// any note in po_refused_notes) gets none: the sender keeps the whole note.
// Spike §2.2: never tombstone a pk the office could legitimately receive later:
// the root revision `${ulid}.0` and a `modules` slug are the same on every machine.

const NOTE_TABLES = new Set(["entries", "refs", "entry_modules", "entry_revisions"]);
const INS = `INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq)
             VALUES (?, ?, ?, ?, ?, ?, crsql_site_id(), ?, ?)`;
// The office's own view of each note: held, its project (hp: the project cell
// arrived), refused at creation (R7).
const NOTES = `
SELECT j.value AS ulid, e.ulid IS NOT NULL AS held, e.project_ulid, r.ulid IS NOT NULL AS refused,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'project_ulid') AS hp,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'series') AS hs
  FROM json_each(?) j
  LEFT JOIN entries e ON e.ulid = j.value
  LEFT JOIN entries__crsql_pks p ON p.ulid = j.value
  LEFT JOIN po_refused_notes r ON r.ulid = j.value`;

/** One refused row: its highest causal length and each cell's highest version on the sender. */
interface Row { table: string; pk: Buffer; key: string | null; cl: number; cells: Map<string, number>; ulid: string | null }
/** The office's copy of a row: causal length, each cell's clock, the values (alive rows). */
interface Held { cl: number; cv: Map<string, { cv: number; dbv: number }>; values: Record<string, unknown> | null }
interface Cell { table: string; pk: Buffer; cid: string; val: unknown; cv: number; cl: number; stamp: string | null }

/**
 * R6: for each refused (table, pk, cid) on a row the office holds, the office's
 * current value at col_version = (highest refused version of that cell) + 1. A row
 * the sender deleted or re-inserted (higher cl) is answered with the office's row
 * at the next cl of the office's parity. A child row the office never had gets a
 * row tombstone (cl + 1). Idempotent: a cell the office already holds at that
 * version or higher is skipped, so a resend writes nothing. Returns the recorded
 * OFFICE_ORIGIN deliveries, stamped with the note's real project (R-5: never '?').
 * Call it before recordOwnChanges in the same transaction. `projects` = classify's
 * judged project per note (Verdict.noteProjects), for a note whose project cell
 * the office doesn't hold yet.
 */
export function writeBack(db: Store, refused: RawChange[], projects?: Map<string, string | null>): DeliveryRow[] {
  if (!refused.length) return [];
  // Refused cells by row, decoded once per run of equal pks.
  const rows = new Map<string, Row>();
  const revHint = new Map<string, string>();
  let last: Row | undefined;
  for (const r of refused) {
    if (!NOTE_TABLES.has(r.table) && r.table !== "modules") continue;
    if (!last || last.table !== r.table || !last.pk.equals(r.pk)) {
      const id = r.table + "\0" + r.pk.toString("latin1");
      last = rows.get(id);
      if (!last) rows.set(id, (last = { table: r.table, pk: r.pk, key: firstTextCell(r.pk), cl: 0, cells: new Map(), ulid: null }));
    }
    last.cl = Math.max(last.cl, r.cl);
    if (r.cid !== "-1") last.cells.set(r.cid, Math.max(last.cells.get(r.cid) ?? 0, r.col_version));
    if (r.table === "entry_revisions" && r.cid === "entry_ulid" && typeof r.val === "string" && last.key) revHint.set(last.key, r.val);
  }
  // Each row's note: a revision the office holds belongs to the office's note (never the batch's).
  const revs = [...rows.values()].filter((x) => x.table === "entry_revisions" && x.key).map((x) => x.key!);
  const officeRev = revisionEntries(db, revs);
  for (const x of rows.values()) {
    if (!x.key || x.table === "modules") continue;
    x.ulid = x.table === "entry_revisions" ? officeRev.get(x.key) ?? revHint.get(x.key) ?? null : x.key;
  }
  const ulids = [...new Set([...rows.values()].map((x) => x.ulid).filter((u): u is string => u !== null))];
  type NoteRow = { ulid: string; held: number; project_ulid: string | null; refused: number; hp: number; hs: number };
  const notes = new Map<string, NoteRow>();
  if (ulids.length) for (const n of prep(db, NOTES).all(JSON.stringify(ulids)) as NoteRow[]) notes.set(n.ulid, n);

  const out: Cell[] = [];
  const todo: Array<{ x: Row; stamp: string | null }> = [];
  const adopted = isEAdoptedOffice(db); // Task 4: no project = E once adopted
  for (const x of rows.values()) {
    let stamp: string | null = null;
    if (x.table !== "modules") {
      const n = x.ulid ? notes.get(x.ulid) : undefined;
      if (!n || !n.held || n.refused) continue; // R-13: a note the office doesn't hold, or refused at creation
      // The office's project cell; none yet but a series cell (still arriving): the
      // project classify judged it in, else held. Neither cell: before 0009, no project.
      stamp = eStamp(adopted, x.table, n.hp ? n.project_ulid : !n.hs ? null : projects?.get(x.ulid!) ?? "?");
    } else if (!x.key) continue;
    todo.push({ x, stamp });
  }
  const held = officeRows(db, todo.map((t) => t.x));
  for (const { x, stamp } of todo) {
    const h = held.get(x);
    if (!h) {
      // A child row the office never had: tombstone it (spike §2), unless its pk is deterministic.
      if (x.table === "entries" || x.table === "modules" || x.cl % 2 === 0) continue;
      if (x.table === "entry_revisions" && x.key === rootRevId(x.ulid!)) continue;
      out.push({ table: x.table, pk: x.pk, cid: "-1", val: null, cv: x.cl + 1, cl: x.cl + 1, stamp });
      continue;
    }
    const officeCl = h.cl;
    if (x.cl > officeCl) {
      // The sender deleted or re-inserted the row: the office's row at the next cl of its own parity.
      const alive = officeCl % 2 === 1;
      const t = x.cl + ((x.cl % 2 === 1) === alive ? 2 : 1);
      out.push({ table: x.table, pk: x.pk, cid: "-1", val: null, cv: t, cl: t, stamp });
      if (alive && h.values) for (const [cid, c] of h.cv) if (cid !== "-1") out.push({ table: x.table, pk: x.pk, cid, val: h.values[cid], cv: c.cv + 1, cl: t, stamp });
    } else if (x.cl === officeCl && h.values) {
      for (const [cid, max] of x.cells) {
        const c = h.cv.get(cid);
        if (!c || c.cv > max) continue; // the office's value already wins (or a resend: it holds max + 1)
        out.push({ table: x.table, pk: x.pk, cid, val: h.values[cid], cv: max + 1, cl: officeCl, stamp });
      }
    } // x.cl < officeCl: the sender's row is behind; the office's row is already on its way to it
  }
  if (!out.length) return [];

  const dv = (prep(db, `SELECT crsql_db_version() v`).get() as { v: number }).v;
  const ins = prep(db, INS);
  out.forEach((c, i) => ins.run(c.table, c.pk, c.cid, c.val, c.cv, dv, c.cl, i));
  // cr-sqlite stores max(passed, this transaction's version): one db_version for all
  // of them, shared with any merge written earlier in the same transaction. So they
  // are recorded here, not by recordOwnChanges (it would skip them past its
  // watermark); its later call ignores them as duplicates.
  const first = rows.get(out[0].table + "\0" + out[0].pk.toString("latin1"))!;
  const stored = officeRows(db, [first]).get(first)!.cv.get(out[0].cid)!.dbv;
  const site = (prep(db, `SELECT crsql_site_id() s`).get() as { s: Buffer }).s;
  // R-5: stamped with the note's project (R3 can't resolve a revision the office
  // never had, and would hold it as '?' forever).
  const rec = prep(db, RECORD_STAMPED);
  const done: DeliveryRow[] = [];
  out.forEach((c, i) => {
    const x = rec.run(OFFICE_ORIGIN, c.table, c.pk, c.cid, c.val, c.cv, stored, site, c.cl, i, c.stamp);
    if (x.changes === 1) done.push({ seq: Number(x.lastInsertRowid), tbl: c.table, pk: c.pk, origin: OFFICE_ORIGIN, held: 0, stamp: c.stamp });
  });
  return done;
}

// ---------------------------------------------------------------- the office's rows
// Read from cr-sqlite's own tables, not crsql_changes: a pk filter on that view
// scans every clock (measured: ~10 ms per row on a small store).
const PK_COLS = new WeakMap<Store, Map<string, string[]>>();
function pkCols(db: Store, table: string): string[] {
  let m = PK_COLS.get(db);
  if (!m) PK_COLS.set(db, (m = new Map()));
  let c = m.get(table);
  if (!c) m.set(table, (c = (db.prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(table) as Array<{ name: string }>).map((r) => r.name)));
  return c;
}

/** The office's copy of each row (absent = it has no clock for the row). Two queries per table. */
function officeRows(db: Store, list: Row[]): Map<Row, Held> {
  const out = new Map<Row, Held>();
  const byTable = new Map<string, Array<{ x: Row; cells: string[] }>>();
  for (const x of list) {
    const cells = textCells(x.pk);
    if (!cells) continue; // not a text pk: never a notes row
    const l = byTable.get(x.table);
    if (l) l.push({ x, cells }); else byTable.set(x.table, [{ x, cells }]);
  }
  for (const [table, items] of byTable) {
    const cols = pkCols(db, table);
    const on = (alias: string) => cols.map((c, i) => `${alias}."${c}" = json_extract(j.value, '$[${i}]')`).join(" AND ");
    const json = JSON.stringify(items.map((t) => t.cells));
    const clocks = prep(db, `SELECT j.key AS i, c.col_name AS cid, c.col_version AS cv, c.db_version AS dbv FROM json_each(?) j
                               JOIN "${table}__crsql_pks" p ON ${on("p")} JOIN "${table}__crsql_clock" c ON c.key = p.__crsql_key`)
      .all(json) as Array<{ i: number; cid: string; cv: number; dbv: number }>;
    for (const c of clocks) {
      const x = items[c.i].x;
      let h = out.get(x);
      if (!h) out.set(x, (h = { cl: 1, cv: new Map(), values: null })); // no sentinel = a live row never deleted (cl 1)
      if (c.cid === "-1") h.cl = c.cv;
      h.cv.set(c.cid, { cv: c.cv, dbv: c.dbv });
    }
    const values = prep(db, `SELECT j.key AS __i, t.* FROM json_each(?) j JOIN "${table}" t ON ${on("t")}`).all(json) as Array<Record<string, unknown> & { __i: number }>;
    for (const v of values) { const h = out.get(items[v.__i].x); if (h) h.values = v; }
  }
  return out;
}
