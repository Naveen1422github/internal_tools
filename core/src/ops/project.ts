// file: core/src/ops/project.ts
// The project commands' one implementation and their words (stage B2, user
// decision 2026-10-11: an AI agent can do anything the CLI can). The CLI
// (`collab project create|list`) and the MCP tools (collab_project_create,
// collab_project_list) call these and print exactly these lines.
import { E_PROJECT_ULID, writeProjectUlid } from "../e-project.js";
import type { DB } from "../db.js";
import { listBindings } from "./bind.js";
import { createProject, createTeamProject, listProjects, isLeftProject, highestNumberOf, type Project } from "../projects.js";
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
    : `Created project ${p.code} (${p.name}), private: its notes are numbered ${p.code}-1, ${p.code}-2, ... on this computer and never sent.`;
  return [first, `Use it in this folder: collab project use ${p.code}`];
}

export interface ProjectListRow extends Project { notes: number; pending: number; current: boolean; modules: string[] }

/** Every project with its note count and the notes waiting for a number (rule 8). */
export function projectListRows(db: DB, current: Project | null): ProjectListRow[] {
  const count = db.prepare(`SELECT COUNT(*) n FROM entries WHERE project_ulid IS ? AND deleted_at IS NULL`);
  const pending = new Map(pendingCounts(db).map((r) => [r.project ?? E_PROJECT_ULID, r.n] as [string, number]));
  const bound = new Map<string, string[]>();
  for (const b of listBindings(db)) bound.set(b.project_ulid, [...(bound.get(b.project_ulid) ?? []), b.module]);
  return listProjects(db).map((p) => ({
    ...p,
    notes: (count.get(writeProjectUlid(p)) as { n: number }).n,
    pending: pending.get(p.ulid) ?? 0,
    current: current?.ulid === p.ulid,
    modules: bound.get(p.ulid) ?? [],
  }));
}

/** `collab project list` / collab_project_list, line for line (* = this folder's project). */
export function projectListLines(rows: ProjectListRow[]): string[] {
  if (!rows.length) return ["No projects yet. Create one: collab project create <name> --code <CODE>"];
  return rows.map((p) =>
    `${p.current ? "*" : " "} ${p.code.padEnd(8)} ${p.name.padEnd(24)} ${p.mode.padEnd(5)} ${String(p.notes).padStart(5)} note(s)` +
      `${p.pending ? `, ${p.pending} waiting for a number` : ""}${isLeftProject(p) ? " (left team, read-only)" : ""}` +
      `${p.modules.length ? `  modules: ${p.modules.join(", ")}` : ""}`);
}

/** `collab project promote` / collab_project_promote, line for line. `wasTeam`: it was already a team project. */
export function promotedLines(db: DB, p: Project, wasTeam: boolean): string[] {
  if (wasTeam) return [`Project ${p.code} (${p.name}) is already a team project of this notebook's post office.`];
  const seed = highestNumberOf(db, p.code); // what promoteProject sent as the office's seed
  return [
    `Project ${p.code} (${p.name}) is now a team project: the post office at ${getSyncValue(db, SYNC_KEYS.url)} continues its numbers after ${p.code}-${seed}; the next note is ${p.code}-${seed + 1}.`,
    "Its notes keep their numbers; the courier sends them to the team on its next sync.",
  ];
}

/** `collab project rename` / collab_project_rename / the Projects page, word for word. */
export function renamedLine(p: Project): string {
  return `Project ${p.code} is now named ${p.name}.`;
}
