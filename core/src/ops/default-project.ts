// file: core/src/ops/default-project.ts
// The private project a note goes to when none is named (local-first Task 3).
// Applies only once E is adopted: before that a no-project note is E, as today.
import type { DB } from "../db.js";
import { createProject, findProject, notFound, type Project } from "../projects.js";
import { DEFAULT_PROJECT_KEY, isEProject } from "../e-project.js";
import { getSyncValue, setSyncValue } from "../sync/state.js";

export const FALLBACK_CODE = "PS";
export const FALLBACK_NAME = "Personal";

const isShared = (p: Project): boolean => isEProject(p) || p.mode === "team";

/** The default project, if one is set and still private; else null. */
export function getDefaultProject(db: DB): Project | null {
  const code = getSyncValue(db, DEFAULT_PROJECT_KEY);
  if (!code) return null;
  const p = findProject(db, code);
  return p && !isShared(p) ? p : null;
}

/** Make a private project the default. E and team projects are refused. */
export function setDefaultProject(db: DB, codeOrUlid: string): Project {
  const p = findProject(db, codeOrUlid);
  if (!p) throw notFound(db, codeOrUlid);
  if (isShared(p)) throw new Error("[collab] the default must be a project that isn't shared");
  setSyncValue(db, DEFAULT_PROJECT_KEY, p.code);
  return p;
}

function psConflict(p: Project): Error {
  return new Error(`[collab] ${FALLBACK_CODE} is a shared project here, so notes can't default to it. Pick a private project with \`collab project default <CODE>\`.`);
}

/** The default project, without creating anything: the set one, an existing private PS, or what would be created. */
export function peekDefaultProject(db: DB): { code: string; name: string; mode: string; exists: boolean } {
  const d = getDefaultProject(db);
  if (d) return { code: d.code, name: d.name, mode: d.mode, exists: true };
  const ps = findProject(db, FALLBACK_CODE);
  if (ps) {
    if (isShared(ps)) throw psConflict(ps);
    return { code: ps.code, name: ps.name, mode: ps.mode, exists: true };
  }
  return { code: FALLBACK_CODE, name: FALLBACK_NAME, mode: "solo", exists: false };
}

/** The default project: the set one, else PS if private, else a new private PS ("Personal"), remembered. */
export function ensureDefaultProject(db: DB): Project {
  const d = getDefaultProject(db);
  if (d) return d;
  let ps = findProject(db, FALLBACK_CODE);
  if (ps && isShared(ps)) throw psConflict(ps);
  if (!ps) ps = createProject(db, { name: FALLBACK_NAME, code: FALLBACK_CODE });
  setSyncValue(db, DEFAULT_PROJECT_KEY, ps.code);
  return ps;
}

/** One line for `collab project default` and collab_project_default. */
export function defaultProjectLine(p: Project | null, justSet: boolean): string {
  if (!p) return `No default project is set yet. Until E is shared, notes with no project are numbered E-…; after that they go to ${FALLBACK_CODE} (${FALLBACK_NAME}), a private project made for you. Pick one with \`collab project default <CODE>\`.`;
  return justSet ? `New notes with no project now go to ${p.code} (${p.name}).` : `New notes with no project go to ${p.code} (${p.name}).`;
}
