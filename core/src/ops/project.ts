// file: core/src/ops/project.ts
// The project commands' one implementation and their words (stage B2, user
// decision 2026-10-11: an AI agent can do anything the CLI can). The CLI
// (`collab project create|list`) and the MCP tools (collab_project_create,
// collab_project_list) call these and print exactly these lines.
import type { DB } from "../db.js";
import { createProject, createTeamProject, listProjects, isLeftProject, type Project } from "../projects.js";
import { pendingCounts } from "../sync/overview.js";
import { getSyncValue } from "../sync/state.js";
import { SYNC_KEYS } from "../sync/http-allocator.js";

/** Create a solo project, or (team) register a team project at this notebook's post office first (stage C). */
export async function createProjectOp(db: DB, args: { name: string; code: string; team?: boolean }): Promise<Project> {
  return args.team ? createTeamProject(db, { name: args.name, code: args.code }) : createProject(db, { name: args.name, code: args.code });
}

/** What creating `p` did, in words. */
export function projectCreatedLines(db: DB, p: Project): string[] {
  const first = p.mode === "team"
    ? `Created team project ${p.code} (${p.name}): numbers come from the post office at ${getSyncValue(db, SYNC_KEYS.url)}; with the office down, notes are saved and wait for their number.`
    : `Created project ${p.code} (${p.name}), solo: its notes are numbered ${p.code}-1, ${p.code}-2, ... on this computer and never sent.`;
  return [first, `Use it in this folder: collab project use ${p.code}`];
}

export interface ProjectListRow extends Project { notes: number; pending: number; current: boolean }

/** Every project with its note count and the notes waiting for a number (rule 8). */
export function projectListRows(db: DB, current: Project | null): ProjectListRow[] {
  const count = db.prepare(`SELECT COUNT(*) n FROM entries WHERE project_ulid = ? AND deleted_at IS NULL`);
  const pending = new Map(pendingCounts(db).filter((r) => r.project).map((r) => [r.project as string, r.n]));
  return listProjects(db).map((p) => ({
    ...p,
    notes: (count.get(p.ulid) as { n: number }).n,
    pending: pending.get(p.ulid) ?? 0,
    current: current?.ulid === p.ulid,
  }));
}

/** `collab project list` / collab_project_list, line for line (* = this folder's project). */
export function projectListLines(rows: ProjectListRow[]): string[] {
  if (!rows.length) return ["No projects yet. Create one: collab project create <name> --code <CODE>"];
  return rows.map((p) =>
    `${p.current ? "*" : " "} ${p.code.padEnd(8)} ${p.name.padEnd(24)} ${p.mode.padEnd(5)} ${String(p.notes).padStart(5)} note(s)` +
      `${p.pending ? `, ${p.pending} waiting for a number` : ""}${isLeftProject(p) ? " (left team, read-only)" : ""}`);
}
