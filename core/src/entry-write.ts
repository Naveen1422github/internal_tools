import type { DB } from "./db.js";
import { hasUlidColumns } from "./db.js";
import { hasUlidPrimaryKey, liveEntry } from "./schema.js";
import { newUlid } from "./ulid.js";
import { resolveAuthor } from "./author.js";
import type { RefInput } from "./ops/add.js";

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
  id: number;
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
}

export interface RefRowInput extends RefInput {
  target_ulid?: string | null;
}

/**
 * Next local E-number (D2). Self-heals a missing counter row and never falls
 * behind max(id), so a restored or hand-edited DB can't hand out a duplicate.
 * Only valid at 0006 (local_counters is created by that migration).
 * Replaced by the central allocator later (E-648).
 */
export function nextEntryNumber(db: DB): number {
  db.prepare(
    `INSERT OR IGNORE INTO local_counters (name, value) SELECT 'entry_number', COALESCE(MAX(id), 0) FROM entries`,
  ).run();
  const row = db
    .prepare(
      `UPDATE local_counters
          SET value = MAX(value, (SELECT COALESCE(MAX(id), 0) FROM entries)) + 1
        WHERE name = 'entry_number'
      RETURNING value`,
    )
    .get() as { value: number };
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

  if (hasUlidPrimaryKey(db)) {
    const ulid = newUlid();
    const id = nextEntryNumber(db);
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

/** Inserts refs; returns how many rows were actually new (INSERT OR IGNORE). */
export function insertRefs(db: DB, owner: InsertedEntry, refs: RefRowInput[]): number {
  if (refs.length === 0) return 0;
  let changed = 0;
  if (owner.ulid !== null) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO refs (entry_ulid, entry_id, ref_type, ref_value, target_ulid) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of refs) changed += stmt.run(owner.ulid, owner.id, r.ref_type, r.ref_value, r.target_ulid ?? null).changes;
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
 */
export function ownerOf(db: DB, id: number): InsertedEntry | null {
  if (!hasUlidColumns(db)) {
    const r = db.prepare(`SELECT id FROM entries WHERE id = ?`).get(id) as { id: number } | undefined;
    return r ? { id: r.id, ulid: null } : null;
  }
  const r = db
    .prepare(`SELECT id, ulid FROM entries WHERE id = ? AND ${liveEntry(db, "entries")} ORDER BY ulid LIMIT 1`)
    .get(id) as { id: number; ulid: string } | undefined;
  return r ? { id: r.id, ulid: r.ulid } : null;
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
