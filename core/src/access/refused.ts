/**
 * Changes the post office refused (table refused_changes, migration 0013).
 * Local, never synced. RnR R6 / rule 5: nothing a user typed is lost silently;
 * the person can copy the change into a solo project or discard it.
 */
import type { DB } from "../db.js";
import { entryUlidOf, type WireChange } from "../sync/changes.js";
import { newUlid } from "../ulid.js";
import { addEntryAsync, type AddEntryArgs } from "../ops/add.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { findProject, isTeamProject, notFound } from "../projects.js";
import { isCopiedToValue } from "../entry-write.js";
import { formatEntryRef } from "../entry-ref.js";

/** No refused change has this id on this laptop. */
export class RefusedNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedNotFoundError";
  }
}

/** A refused change can only be copied into a solo project. */
export class TeamTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamTargetError";
  }
}

export interface RefusedRow {
  ulid: string;
  note_ulid: string | null;
  project_ulid: string | null;
  kind: "new" | "edit";
  key: string | null;
  reason: string;
  cells: WireChange[];
  at: string;
}

export interface RefusalInput {
  noteUlid: string | null;
  projectUlid: string | null;
  kind: "new" | "edit";
  key: string | null;
  reason: string;
  cells: WireChange[];
}

type RawRow = Omit<RefusedRow, "cells"> & { cells: string };

/** Keep a refused change. A refused new note is kept once: a repeat only updates the reason. */
export function recordRefusal(db: DB, r: RefusalInput): string {
  const cells = JSON.stringify(r.cells);
  if (r.kind === "new" && r.noteUlid) {
    const have = db.prepare(`SELECT ulid FROM refused_changes WHERE kind = 'new' AND note_ulid = ?`).get(r.noteUlid) as { ulid: string } | undefined;
    if (have) {
      db.prepare(`UPDATE refused_changes SET reason = ?, key = ?, cells = ? WHERE ulid = ?`).run(r.reason, r.key, cells, have.ulid);
      return have.ulid;
    }
  }
  const ulid = newUlid();
  db.prepare(`INSERT INTO refused_changes (ulid, note_ulid, project_ulid, kind, key, reason, cells) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ulid, r.noteUlid, r.projectUlid, r.kind, r.key, r.reason, cells);
  return ulid;
}

function toRow(raw: RawRow): RefusedRow {
  return { ...raw, cells: JSON.parse(raw.cells) as WireChange[] };
}

export function listRefused(db: DB): RefusedRow[] {
  return (db.prepare(`SELECT * FROM refused_changes ORDER BY at, ulid`).all() as RawRow[]).map(toRow);
}

/**
 * A refusal as a person knows it, the same on the CLI and the web: the note's
 * number when it has one, else its title; the project's code. "-" for none.
 */
export function describeRefused(db: DB, row: Pick<RefusedRow, "note_ulid" | "project_ulid">): { note: string; project_code: string } {
  return { note: noteLabel(db, row.note_ulid), project_code: projectCode(db, row.project_ulid) };
}

function noteLabel(db: DB, ulid: string | null): string {
  if (!ulid) return "-";
  const n = db.prepare(`SELECT id, series, title FROM entries WHERE ulid = ?`).get(ulid) as { id: number | null; series: string; title: string } | undefined;
  if (!n) return "-";
  return n.id !== null && n.id !== undefined ? formatEntryRef(n.id, n.series) : n.title;
}

function projectCode(db: DB, ulid: string | null): string {
  if (!ulid) return "-";
  return (db.prepare(`SELECT code FROM projects WHERE ulid = ?`).get(ulid) as { code: string } | undefined)?.code ?? "-";
}

export function isRefusedNote(db: DB, ulid: string): boolean {
  return !!db.prepare(`SELECT 1 FROM refused_changes WHERE note_ulid = ? LIMIT 1`).get(ulid);
}

/** The office refused this note's creation (kind 'new'): it is never sent or numbered again (R7, ruling R-23). */
export function isRefusedCreation(db: DB, ulid: string): boolean {
  return !!db.prepare(`SELECT 1 FROM refused_changes WHERE note_ulid = ? AND kind = 'new' LIMIT 1`).get(ulid);
}

function getRefused(db: DB, id: string): RefusedRow {
  const raw = db.prepare(`SELECT * FROM refused_changes WHERE ulid = ?`).get(id) as RawRow | undefined;
  if (!raw) throw new RefusedNotFoundError(`[collab] no refused change "${id}" on this laptop.`);
  return toRow(raw);
}

/** Hard-delete a note's rows from every notes table (the caller owns the transaction). */
function dropLocalNote(db: DB, ulid: string): void {
  ensureCrsqlite(db);
  for (const [t, col] of [["entry_revisions", "entry_ulid"], ["entry_modules", "entry_ulid"], ["refs", "entry_ulid"], ["entries", "ulid"]] as const) {
    db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(ulid);
  }
}

/** Drop the refusal; a refused new note also loses its local copy. One transaction. */
export function discardRefused(db: DB, id: string): void {
  const r = getRefused(db, id);
  db.transaction(() => {
    db.prepare(`DELETE FROM refused_changes WHERE ulid = ?`).run(id);
    if (r.kind === "new" && r.note_ulid) dropLocalNote(db, r.note_ulid);
  })();
}

const FIELDS = ["type", "title", "summary", "description", "agent", "module", "category", "status"] as const;
const NULLABLE = new Set(["description", "agent", "module"]); // a cleared field is the user's intent

/**
 * The refs rows alive in the refused cells for this note: (entry_ulid, ref_type,
 * ref_value) from each refs pk. A removal (even cl) and a copy-out marker are not
 * additions (the marker belongs to the source note). The pk is decoded here, not
 * with crsql_unpack_columns: copy works without the extension loaded.
 */
function refusedRefs(cells: WireChange[], noteUlid: string): Array<{ ref_type: string; ref_value: string }> {
  const out: Array<{ ref_type: string; ref_value: string }> = [];
  for (const c of cells) {
    if (c.table !== "refs" || c.cl % 2 === 0) continue;
    const pk = textCellsOf(Buffer.from(c.pk, "base64"));
    if (!pk || pk.length !== 3 || pk[0] !== noteUlid || isCopiedToValue(pk[2])) continue;
    out.push({ ref_type: pk[1], ref_value: pk[2] });
  }
  return out;
}

/** Every cell of a cr-sqlite packed pk when all are text, else null: [count], then per cell [(lenBytes << 3) | 3][length][utf8]. */
function textCellsOf(pk: Buffer): string[] | null {
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

/** Copy the refused note into a solo project (local note overlaid with the refused cells), then drop the refusal. */
export async function copyRefused(db: DB, id: string, toCode: string): Promise<{ id: number; series: string }> {
  const r = getRefused(db, id);
  const target = findProject(db, toCode);
  if (!target) throw notFound(db, toCode);
  if (isTeamProject(target)) {
    throw new TeamTargetError(`[collab] ${target.code} is a team project. Copy this note into a solo project instead (\`collab project list\` shows which are solo).`);
  }
  ensureCrsqlite(db);
  const local = (r.note_ulid
    ? db.prepare(`SELECT type, title, summary, description, agent, module, category, status FROM entries WHERE ulid = ?`).get(r.note_ulid)
    : undefined) as Record<string, unknown> | undefined;
  const fields: Record<string, unknown> = { ...(local ?? {}) };
  // Only this note's cells; oldest first so the latest version wins.
  const mine = r.cells
    .filter((c) => c.table === "entries" && (FIELDS as readonly string[]).includes(c.cid) && entryUlidOf(db, "entries", Buffer.from(c.pk, "base64")) === r.note_ulid)
    .sort((a, b) => a.col_version - b.col_version || a.seq - b.seq);
  for (const c of mine) {
    if (typeof c.val === "string") fields[c.cid] = c.val;
    else if (c.val === null && NULLABLE.has(c.cid)) fields[c.cid] = null;
  }
  const args: AddEntryArgs = {
    type: (fields.type as AddEntryArgs["type"]) ?? "decision",
    title: String(fields.title ?? ""),
    summary: String(fields.summary ?? fields.title ?? "").slice(0, 200),
    project: target.ulid,
  };
  if (fields.description) args.description = String(fields.description);
  if (fields.agent) args.agent = fields.agent as AddEntryArgs["agent"];
  if (fields.category) args.category = fields.category as AddEntryArgs["category"];
  if (fields.status === "draft" || fields.status === "active") args.status = fields.status;
  if (r.note_ulid) {
    // Rule 5: the note's refs and every module travel with it.
    const mods = db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY is_primary DESC, module`).all(r.note_ulid) as Array<{ module: string; is_primary: number }>;
    const primary = fields.module ? String(fields.module) : mods.find((m) => m.is_primary)?.module;
    if (primary) args.module = primary;
    const extra = mods.map((m) => m.module).filter((m) => m !== primary);
    if (extra.length) args.modules = extra;
    const refs = db.prepare(`SELECT ref_type, ref_value FROM refs WHERE entry_ulid = ?`).all(r.note_ulid) as NonNullable<AddEntryArgs["refs"]>;
    // R-32b: the refs the refused cells added (the laptop's copy was reverted since) travel too.
    const have = new Set(refs.map((x) => x.ref_type + "\0" + x.ref_value));
    for (const x of refusedRefs(r.cells, r.note_ulid)) {
      if (!have.has(x.ref_type + "\0" + x.ref_value)) { have.add(x.ref_type + "\0" + x.ref_value); refs.push(x as (typeof refs)[number]); }
    }
    if (refs.length) args.refs = refs;
  } else if (fields.module) args.module = String(fields.module);
  const res = await addEntryAsync(db, args);
  // A crash between the copy and this discard leaves a duplicate: it errs toward keeping data.
  discardRefused(db, id);
  return { id: res.id as number, series: target.code };
}
