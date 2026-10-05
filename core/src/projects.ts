// file: core/src/projects.ts
// Projects (collab piece 2 stage B1, spec P1/P2/P10): a project has a
// permanent ULID, a name you can rename, and a fixed code that numbers its
// notes (SH-1, SH-2). Local only in B1: solo projects are numbered on this
// laptop and never sent; team projects arrive with stage C.
import type { DB } from "./db.js";
import { hasSeries } from "./schema.js";
import { newUlid, SERIES_CODE_RE } from "./ulid.js";

export interface Project {
  ulid: string;
  name: string;
  code: string;
  mode: "solo" | "team";
  team: string | null;
  created_at: string;
}

/** A project name or code already used in this notebook (P10: warn, don't mix). */
export class ProjectClashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectClashError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

const COLS = "ulid, name, code, mode, team, created_at";

function needs0009(db: DB): void {
  if (!hasSeries(db)) {
    throw new Error("[collab] projects needs migration 0009 (projects). Run `collab migrate` (or restart the MCP server) first.");
  }
}

function checkCode(raw: string): string {
  const code = String(raw ?? "").trim().toUpperCase();
  if (code === "E" || !SERIES_CODE_RE.test(code)) {
    throw new Error(`[collab] project code "${raw}" is not valid: 2-8 letters or digits, starting with a letter (e.g. SH, NV2), not E (E numbers the notes without a project)`);
  }
  return code;
}

function nameClash(db: DB, name: string, exceptUlid?: string): Project | null {
  return (db.prepare(`SELECT ${COLS} FROM projects WHERE lower(name) = lower(?) AND ulid IS NOT ?`)
    .get(name, exceptUlid ?? null) as Project | undefined) ?? null;
}

const FIXES = "Fix: rename one of them (`collab project rename <code> <new name>`), or use a different notebook.";

export function createProject(db: DB, args: { name: string; code: string; mode?: "solo" }): Project {
  needs0009(db);
  const mode = (args.mode ?? "solo") as string;
  if (mode === "team") throw new Error("[collab] team projects arrive with stage C; create a solo project for now");
  if (mode !== "solo") throw new Error(`[collab] invalid project mode: ${mode} (solo)`);
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("[collab] a project needs a name");
  const code = checkCode(args.code);
  const byName = nameClash(db, name);
  if (byName) {
    throw new ProjectClashError(`[collab] this notebook already has a project named "${byName.name}" (${byName.code}). ${FIXES}`);
  }
  const byCode = db.prepare(`SELECT ${COLS} FROM projects WHERE code = ?`).get(code) as Project | undefined;
  if (byCode) {
    throw new ProjectClashError(`[collab] this notebook already has a project with code ${code} ("${byCode.name}"). ${FIXES}`);
  }
  const ulid = newUlid();
  db.prepare(`INSERT INTO projects (ulid, name, code, mode) VALUES (?, ?, ?, 'solo')`).run(ulid, name, code);
  return findProject(db, ulid)!;
}

export function renameProject(db: DB, codeOrUlid: string, newName: string): Project {
  needs0009(db);
  const p = findProject(db, codeOrUlid);
  if (!p) throw notFound(db, codeOrUlid);
  const name = String(newName ?? "").trim();
  if (!name) throw new Error("[collab] a project needs a name");
  const clash = nameClash(db, name, p.ulid);
  if (clash) {
    throw new ProjectClashError(`[collab] this notebook already has a project named "${clash.name}" (${clash.code}). ${FIXES}`);
  }
  db.prepare(`UPDATE projects SET name = ?, updated_at = datetime('now') WHERE ulid = ?`).run(name, p.ulid);
  return findProject(db, p.ulid)!;
}

/** Every project in this notebook, by name. */
export function listProjects(db: DB): Project[] {
  needs0009(db);
  return db.prepare(`SELECT ${COLS} FROM projects ORDER BY lower(name), ulid`).all() as Project[];
}

/** A project by code (any case) or exact ULID, or null. */
export function findProject(db: DB, codeOrUlid: string): Project | null {
  needs0009(db);
  const v = String(codeOrUlid ?? "").trim();
  return (db.prepare(`SELECT ${COLS} FROM projects WHERE code = upper(?) OR ulid = ? LIMIT 1`).get(v, v) as Project | undefined) ?? null;
}

/** The error for a project that isn't in this notebook, listing the known codes. */
export function notFound(db: DB, codeOrUlid: string, where?: string): ProjectNotFoundError {
  const known = listProjects(db).map((p) => p.code);
  return new ProjectNotFoundError(
    `[collab] ${where ? `${where} names project` : "no project"} "${codeOrUlid}"${where ? ", which isn't in this notebook" : " in this notebook"}. ` +
      `Known: ${known.join(", ") || "none"}. See \`collab project list\`.`,
  );
}
