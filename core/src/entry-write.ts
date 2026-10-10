import type { DB } from "./db.js";
import { hasUlidColumns } from "./db.js";
import { hasSeries, hasUlidPrimaryKey, liveEntry } from "./schema.js";
import { newUlid, isUlid, type NoteRef } from "./ulid.js";
import { resolveAuthor } from "./author.js";
import type { RefInput } from "./ops/add.js";
import { isSyncEnabled } from "./sync/state.js";

// The ONE place that knows how an entry and its links are written at each
// schema level (pre-0005 / 0005 / 0006). Every writer goes through here.
//
// Link columns: at 0005 and 0006 writers fill BOTH entry_id and entry_ulid
// (D3: entry_id is a write-only label at 0006; at 0005 the fill trigger
// COALESCEs, so passing entry_ulid is harmless). DELETES key on the level's
// real primary key: entry_ulid at 0006, entry_id before (F3), because at
// 0005 entry_ulid is only trigger-filled and may be NULL on a row written by
// a path that bypassed the trigger.

export interface InsertedEntry {
  /** null = pending: saved, waiting for its number from the post office (stage C). */
  id: number | null;
  ulid: string | null; // null only on a pre-0005 DB
}

export interface EntryRowInput {
  type: string;
  kind: string;
  title: string;
  summary: string;
  description: string | null;
  status: string;
  agent: string | null;
  module: string | null;
  task_id: string | null;
  tokens_estimate: number;
  category?: string;
  rollup_of_task?: string | null;
  assigned?: { ulid: string; id: number }; // internal: pre-assigned by the post office
  /** Team-project note without a number in hand: saved with id NULL (stage C, rule 4). */
  pending?: boolean;
  /** The ulid a pending note was already asked for under: the courier retries with it (E-713). */
  pendingUlid?: string;
  /** 0009+: a project's code; omitted = series E (the column default). */
  series?: string;
  project_ulid?: string | null;
}

export interface RefRowInput extends RefInput {
  target_ulid?: string | null;
}

/**
 * Next local number in `series` (D2; per project from 0009, spec P5). Self-heals
 * a missing counter row and never falls behind max(id) of that series, so a
 * restored or hand-edited DB can't hand out a duplicate, and a hard-deleted
 * number is never handed out again (the counter only grows).
 * Counter rows: `entry_number` for E (unchanged), `series:<CODE>` otherwise.
 * Only valid at 0006 (local_counters is created by that migration).
 */
export function nextEntryNumber(db: DB, series = "E"): number {
  const name = series === "E" ? "entry_number" : `series:${series}`;
  const filter = hasSeries(db) ? "WHERE series = @series" : "";
  const maxId = `(SELECT COALESCE(MAX(id), 0) FROM entries ${filter})`;
  db.prepare(`INSERT OR IGNORE INTO local_counters (name, value) SELECT @name, ${maxId}`).run({ name, ...(filter ? { series } : {}) });
  const row = db
    .prepare(
      `UPDATE local_counters
          SET value = MAX(value, ${maxId}) + 1
        WHERE name = @name
      RETURNING value`,
    )
    .get({ name, ...(filter ? { series } : {}) }) as { value: number };
  return row.value;
}

function run(db: DB, cols: string[], values: Record<string, unknown>) {
  const bind = Object.fromEntries(cols.map((c) => [c, values[c]]));
  return db
    .prepare(`INSERT INTO entries (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`)
    .run(bind);
}

export function insertEntryRow(db: DB, row: EntryRowInput): InsertedEntry {
  const cols = [
    "type", "kind", "title", "summary", "description", "status",
    "agent", "module", "task_id", "tokens_estimate", "rollup_of_task",
  ];
  const values: Record<string, unknown> = { ...row, rollup_of_task: row.rollup_of_task ?? null };
  if (row.category !== undefined) cols.push("category");

  if (row.series !== undefined && row.series !== "E") {
    if (!hasSeries(db)) throw new Error("[collab] writing into a project needs migration 0009");
    // Team project: the number comes from the post office (assigned) or later
    // from the courier (pending, id NULL). Never a local number (rule 4).
    // Solo project: numbered here, never sent (B1).
    const ulid = row.assigned?.ulid ?? row.pendingUlid ?? newUlid();
    const id = row.assigned ? row.assigned.id : row.pending ? null : nextEntryNumber(db, row.series);
    cols.push("ulid", "author", "id", "series", "project_ulid");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id, series: row.series, project_ulid: row.project_ulid ?? null });
    return { id, ulid };
  }

  if (hasUlidPrimaryKey(db)) {
    if (row.assigned) {
      cols.push("ulid", "author", "id");
      run(db, cols, { ...values, ulid: row.assigned.ulid, author: resolveAuthor(), id: row.assigned.id });
      return { id: row.assigned.id, ulid: row.assigned.ulid };
    }
    const ulid = row.pendingUlid ?? newUlid();
    // Shared notebook: E numbers come only from the post office. Without one
    // in hand the note is saved pending and the courier numbers it (E-820;
    // this replaces E-708's refusal to save).
    const id = isSyncEnabled(db) ? null : nextEntryNumber(db);
    cols.push("ulid", "author", "id");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id });
    return { id, ulid };
  }
  if (hasUlidColumns(db)) {
    const ulid = newUlid();
    cols.push("ulid", "author");
    const r = run(db, cols, { ...values, ulid, author: resolveAuthor() });
    return { id: Number(r.lastInsertRowid), ulid };
  }
  // Pre-0005: no ulid/author columns; naming them would throw.
  const r = run(db, cols, values);
  return { id: Number(r.lastInsertRowid), ulid: null };
}

/**
 * The target of an entry ref whose value is a ULID (stage C, spec P6: a pending
 * note has no number yet, so it is linked by ULID). The fill trigger only
 * parses number forms and only fires when target_ulid is NULL, so this needs
 * no trigger change. null when no note has that ULID.
 */
function ulidTarget(db: DB, r: RefRowInput): string | null {
  if (r.ref_type !== "entry" || typeof r.ref_value !== "string") return null;
  const v = r.ref_value.trim().toUpperCase();
  if (!isUlid(v)) return null;
  return db.prepare(`SELECT 1 FROM entries WHERE ulid = ?`).get(v) ? v : null;
}

/** Inserts refs; returns how many rows were actually new (INSERT OR IGNORE). */
export function insertRefs(db: DB, owner: InsertedEntry, refs: RefRowInput[]): number {
  if (refs.length === 0) return 0;
  let changed = 0;
  if (owner.ulid !== null) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of refs) changed += stmt.run(owner.ulid, owner.id, r.ref_type, r.ref_value, r.target_ulid ?? ulidTarget(db, r)).changes;
  } else {
    const stmt = db.prepare(`INSERT OR IGNORE INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)`);
    for (const r of refs) changed += stmt.run(owner.id, r.ref_type, r.ref_value).changes;
  }
  return changed;
}

export function insertEntryModules(db: DB, owner: InsertedEntry, modules: string[], primary: string | null): void {
  if (modules.length === 0) return;
  if (owner.ulid !== null) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, ?, ?, ?)`,
    );
    for (const m of modules) stmt.run(owner.ulid, owner.id, m, m === primary ? 1 : 0);
  } else {
    const stmt = db.prepare(`INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, ?)`);
    for (const m of modules) stmt.run(owner.id, m, m === primary ? 1 : 0);
  }
}

/**
 * Resolve an E-number to the entry a write-by-number acts on. At 0006 id is
 * not unique (E-648): the LOWEST live ulid wins, and tombstoned entries are
 * never owners. Every write looked up by E-number goes through here (F3).
 * From 0009 a bare number means series E only: a project note is reached
 * only with its series (ownerOfRef).
 */
export function ownerOf(db: DB, id: number): InsertedEntry | null {
  return ownerOfRef(db, { series: "E", id });
}

/** ownerOf for a reference with a series (`SH-12`). Before 0009 only series E exists. */
export function ownerOfRef(db: DB, ref: NoteRef): InsertedEntry | null {
  const series = hasSeries(db);
  if (!series && ref.series !== "E") return null;
  if (!hasUlidColumns(db)) {
    const r = db.prepare(`SELECT id FROM entries WHERE id = ?`).get(ref.id) as { id: number } | undefined;
    return r ? { id: r.id, ulid: null } : null;
  }
  const r = (series
    ? db.prepare(`SELECT id, ulid FROM entries WHERE id = ? AND series = ? AND ${liveEntry(db, "entries")} ORDER BY ulid LIMIT 1`)
        .get(ref.id, ref.series)
    : db.prepare(`SELECT id, ulid FROM entries WHERE id = ? AND ${liveEntry(db, "entries")} ORDER BY ulid LIMIT 1`)
        .get(ref.id)) as { id: number; ulid: string } | undefined;
  return r ? { id: r.id, ulid: r.ulid } : null;
}

/**
 * The live note with this ULID, pending or numbered (stage C, spec P6), or
 * null. Tombstones never own a write, as with ownerOfRef. 0005+ only.
 */
export function ownerOfUlid(db: DB, ulid: string): InsertedEntry | null {
  if (!hasUlidColumns(db)) return null;
  const r = db.prepare(`SELECT id, ulid FROM entries WHERE ulid = ? AND ${liveEntry(db, "entries")}`)
    .get(ulid) as { id: number | null; ulid: string } | undefined;
  return r ? { id: r.id, ulid: r.ulid } : null;
}

/**
 * Give a pending note the number the post office assigned (stage C; the
 * courier calls this). Only ever fills an empty id: a note numbered already
 * keeps its number (never two numbers for one note, E-713). Returns true when
 * it wrote.
 */
export function assignPendingNumber(db: DB, ulid: string, id: number): boolean {
  if (!Number.isInteger(id) || id < 1) throw new Error(`not a note number: ${String(id)}`);
  return db.prepare(`UPDATE entries SET id = ? WHERE ulid = ? AND id IS NULL`).run(id, ulid).changes > 0;
}

/** Deletes one ref of `owner`; returns rows removed. Keys on the level's real PK (F3). */
export function deleteRef(db: DB, owner: InsertedEntry, ref: RefInput): number {
  return hasUlidPrimaryKey(db)
    ? db.prepare(`DELETE FROM refs WHERE entry_ulid = ? AND ref_type = ? AND ref_value = ?`)
        .run(owner.ulid, ref.ref_type, ref.ref_value).changes
    : db.prepare(`DELETE FROM refs WHERE entry_id = ? AND ref_type = ? AND ref_value = ?`)
        .run(owner.id, ref.ref_type, ref.ref_value).changes;
}

/** Replace ALL of an entry's refs and module rows (the REST upsert's edit semantics). */
export function replaceLinks(
  db: DB, owner: InsertedEntry, modules: string[], primary: string | null, refs: RefRowInput[],
): void {
  if (hasUlidPrimaryKey(db)) {
    db.prepare(`DELETE FROM refs WHERE entry_ulid = ?`).run(owner.ulid);
    db.prepare(`DELETE FROM entry_modules WHERE entry_ulid = ?`).run(owner.ulid);
  } else {
    db.prepare(`DELETE FROM refs WHERE entry_id = ?`).run(owner.id);
    db.prepare(`DELETE FROM entry_modules WHERE entry_id = ?`).run(owner.id);
  }
  insertEntryModules(db, owner, modules, primary);
  insertRefs(db, owner, refs);
}
