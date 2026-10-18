/**
 * Changes the post office refused (table refused_changes, migration 0013).
 * Local, never synced. RnR R6 / rule 5: nothing a user typed is lost silently;
 * the person can copy the change into a solo project or discard it.
 */
import type { DB } from "../db.js";
import type { WireChange } from "../sync/changes.js";
import { newUlid } from "../ulid.js";
import { addEntryAsync, type AddEntryArgs } from "../ops/add.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { findProject, isTeamProject, notFound } from "../projects.js";

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

export function isRefusedNote(db: DB, ulid: string): boolean {
  return !!db.prepare(`SELECT 1 FROM refused_changes WHERE note_ulid = ? LIMIT 1`).get(ulid);
}

function getRefused(db: DB, id: string): RefusedRow {
  const raw = db.prepare(`SELECT * FROM refused_changes WHERE ulid = ?`).get(id) as RawRow | undefined;
  if (!raw) throw new Error(`[collab] no refused change "${id}" on this laptop.`);
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

const FIELDS = ["type", "title", "summary", "description", "agent", "module"] as const;

/** Copy the refused note into a solo project (local note overlaid with the refused cells), then drop the refusal. */
export async function copyRefused(db: DB, id: string, toCode: string): Promise<{ id: number; series: string }> {
  const r = getRefused(db, id);
  const target = findProject(db, toCode);
  if (!target) throw notFound(db, toCode);
  if (isTeamProject(target)) {
    throw new Error(`[collab] ${target.code} is a team project. Copy this note into a solo project instead (\`collab project list\` shows which are solo).`);
  }
  const local = (r.note_ulid
    ? db.prepare(`SELECT type, title, summary, description, agent, module FROM entries WHERE ulid = ?`).get(r.note_ulid)
    : undefined) as Record<string, unknown> | undefined;
  const fields: Record<string, unknown> = { ...(local ?? {}) };
  for (const c of r.cells) {
    if (c.table === "entries" && (FIELDS as readonly string[]).includes(c.cid) && typeof c.val === "string") fields[c.cid] = c.val;
  }
  const args: AddEntryArgs = {
    type: (fields.type as AddEntryArgs["type"]) ?? "decision",
    title: String(fields.title ?? ""),
    summary: String(fields.summary ?? fields.title ?? "").slice(0, 200),
    project: target.ulid,
  };
  if (fields.description) args.description = String(fields.description);
  if (fields.agent) args.agent = fields.agent as AddEntryArgs["agent"];
  if (fields.module) args.module = String(fields.module);
  const res = await addEntryAsync(db, args);
  discardRefused(db, id);
  return { id: res.id as number, series: target.code };
}
