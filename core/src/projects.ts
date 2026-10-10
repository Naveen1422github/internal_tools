// file: core/src/projects.ts
// Projects (collab piece 2 stage B1, spec P1/P2/P10): a project has a
// permanent ULID, a name you can rename, and a fixed code that numbers its
// notes (SH-1, SH-2). Local only in B1: solo projects are numbered on this
// laptop and never sent; team projects arrive with stage C.
import type { DB } from "./db.js";
import { collabStartDir, findCollabFile } from "./db.js";
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

/** A team project: numbered only by its post office, sent only there (stage C, rules 4-5). */
export function isTeamProject(p: Project | null): boolean { return !!p && p.mode === "team"; }

function needs0009(db: DB): void {
  if (!hasSeries(db)) {
    throw new Error("[collab] projects needs migration 0009 (projects). Restart the MCP server (or run `collab web` once): it applies migrations on start.");
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
  if (code === "NONE") throw new Error(`[collab] project code NONE is reserved ("project: none" means no project)`);
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

/**
 * A team project as the office lists it (stage C, P1). Creates or refreshes
 * the local row; never overwrites a local project with the same code or name
 * (P10): that is a clash, reported and left alone.
 */
export function upsertTeamProjectFromOffice(
  db: DB, p: { ulid: string; name: string; code: string }, fingerprint: string,
): "created" | "updated" | "clash" {
  needs0009(db);
  const mine = db.prepare(`SELECT ulid, mode, team, name FROM projects WHERE ulid = ?`).get(p.ulid) as
    | { ulid: string; mode: string; team: string | null; name: string } | undefined;
  if (mine) {
    if (mine.mode !== "team" || mine.team !== fingerprint || mine.name !== p.name) {
      db.prepare(`UPDATE projects SET mode = 'team', team = ?, name = ?, updated_at = datetime('now') WHERE ulid = ?`).run(fingerprint, p.name, p.ulid);
    }
    return "updated";
  }
  const clash = db.prepare(`SELECT 1 FROM projects WHERE code = ? OR lower(name) = lower(?)`).get(p.code, p.name);
  if (clash) return "clash";
  db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', ?)`).run(p.ulid, p.name, p.code, fingerprint);
  return "created";
}

/** One team project of the office that clashes with a local project (courier sync_state `project_clash`). */
export interface ProjectClash { code: string; office_ulid: string; local_ulid: string | null; local_code?: string }

/** The local project a team project clashes with (same code, or same name), or null. */
export function localClashOf(db: DB, p: { code: string; name: string }): { ulid: string; code: string } | null {
  return (db.prepare(`SELECT ulid, code FROM projects WHERE code = ? OR lower(name) = lower(?) ORDER BY code = ? DESC LIMIT 1`)
    .get(p.code, p.name, p.code) as { ulid: string; code: string } | undefined) ?? null;
}

/** What to tell the person about clashes (courier status and doctor say the same, rule 8). */
export function projectClashText(clashes: ProjectClash[]): string {
  return clashes
    .map((c) => {
      const mine = c.local_code ?? c.code;
      return `the team's ${c.code} clashes with your own ${mine}. Copy your notes into another code (\`collab copy\`, stage B2) and delete your ${mine}, then sync again.`;
    })
    .join(" ");
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

/**
 * The project the nearest .collab names (spec P3; walk from CLAUDE_PROJECT_DIR
 * when set), or null when it names none (today's behaviour). Re-reads the
 * file on every call: it is small, and the MCP server is long-lived. A ULID
 * that isn't in this notebook is an error naming the file, never a silent
 * fall back to the E series.
 */
export function currentProject(db: DB, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Project | null {
  const found = findCollabFile(collabStartDir(opts));
  if (!found || !found.project) return null;
  const p = findProject(db, found.project);
  if (!p) throw notFound(db, found.project, found.file);
  return p;
}
