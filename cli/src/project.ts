import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeDb, collabStartDir, createProject, createTeamProject, currentProject, findCollabFile, findProject, getDb, listProjects,
  notFound, promoteProject, highestNumberOf, renameProject, resolveDbPath, getSyncValue, pendingCounts, SYNC_KEYS, type Project,
} from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";

// `collab project ...` (spec P2): projects number their own notes (SH-1, SH-2).

const fail = (io: Io, msg: string): CliResult => { io.err(`collab: ${msg.replace(/^\[collab(-mcp)?\] /, "")}`); return { code: 1 }; };

const USAGE = "usage: collab project create <name> --code <CODE> [--team] | promote <code> | rename <code> <new name> | list | use <code>";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Positional words, without `--flag value` pairs. */
function words(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const projectLine = (p: Project) => `project = ${p.ulid}  # ${p.code} ${p.name}`;

/**
 * Point the nearest .collab at `p`: replace its project line (or add one),
 * keeping every other line and comment. No .collab: create one in the current
 * folder naming the notebook that is open now.
 */
function useProject(p: Project, io: Io): CliResult {
  const found = findCollabFile(collabStartDir());
  if (found) {
    const lines = readFileSync(found.file, "utf8").split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*project\s*=/.test(l.replace(/#.*/, "")));
    if (at >= 0) lines[at] = projectLine(p);
    else {
      const nb = lines.findIndex((l) => /^\s*notebook\s*=/.test(l.replace(/#.*/, "")));
      lines.splice(nb + 1, 0, projectLine(p));
    }
    writeFileSync(found.file, lines.join("\n"));
    io.out(`${found.file} now uses project ${p.code} (${p.name}).`);
    return { code: 0 };
  }
  const r = resolveDbPath();
  if (!r.name) {
    return fail(io, `the open notebook (${r.path}) isn't registered, so a new .collab can't name it. ` +
      `Register it first: collab notebook adopt "${r.path}" --name <name>`);
  }
  const file = join(process.cwd(), ".collab");
  if (existsSync(file)) return fail(io, `${file} exists but wasn't read`);
  writeFileSync(file, `notebook = ${r.name}\n${projectLine(p)}\n`);
  io.out(`Created ${file}: notebook ${r.name}, project ${p.code} (${p.name}).`);
  return { code: 0 };
}

export async function runProject(args: string[], io: Io): Promise<CliResult> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "create": {
        const team = rest.includes("--team");
        const opts = rest.filter((a) => a !== "--team" && a !== "--solo");
        const [name] = words(opts);
        const code = flag(opts, "--code");
        if (!name || !code) { io.err("usage: collab project create <name> --code <CODE> [--team]"); return { code: 2 }; }
        if (team) {
          // Stage C: registered at this notebook's post office first (E-820: any member creates one).
          const db = getDb();
          const p = await createTeamProject(db, { name, code });
          io.out(`Created team project ${p.code} (${p.name}): numbers come from the post office at ${getSyncValue(db, SYNC_KEYS.url)}; with the office down, notes are saved and wait for their number.`);
          io.out(`Use it in this folder: collab project use ${p.code}`);
          return { code: 0 };
        }
        const p = createProject(getDb(), { name, code });
        io.out(`Created project ${p.code} (${p.name}), solo: its notes are numbered ${p.code}-1, ${p.code}-2, ... on this computer and never sent.`);
        io.out(`Use it in this folder: collab project use ${p.code}`);
        return { code: 0 };
      }
      case "promote": {
        const [code] = words(rest);
        if (!code) { io.err("usage: collab project promote <code>"); return { code: 2 }; }
        const db = getDb();
        const before = findProject(db, code);
        if (!before) throw notFound(db, code);
        const wasTeam = before.mode === "team";
        const p = await promoteProject(db, code);
        const seed = highestNumberOf(db, p.code); // what promoteProject sent as the office's seed
        if (wasTeam) { io.out(`Project ${p.code} (${p.name}) is already a team project of this notebook's post office.`); return { code: 0 }; }
        io.out(`Project ${p.code} (${p.name}) is now a team project: the post office at ${getSyncValue(db, SYNC_KEYS.url)} continues its numbers after ${p.code}-${seed}; the next note is ${p.code}-${seed + 1}.`);
        io.out("Its notes keep their numbers; the courier sends them to the team on its next sync.");
        return { code: 0 };
      }
      case "rename": {
        const [code, ...nameWords] = words(rest);
        if (!code || nameWords.length === 0) { io.err("usage: collab project rename <code> <new name>"); return { code: 2 }; }
        const p = renameProject(getDb(), code, nameWords.join(" "));
        io.out(`Project ${p.code} is now named ${p.name}.`);
        return { code: 0 };
      }
      case "list": {
        const db = getDb();
        const all = listProjects(db);
        if (!all.length) { io.out("No projects yet. Create one: collab project create <name> --code <CODE>"); return { code: 0 }; }
        let cur: Project | null = null;
        try { cur = currentProject(db); } catch (e) { io.err(`collab: ${(e as Error).message.replace(/^\[collab\] /, "")}`); }
        const count = db.prepare(`SELECT COUNT(*) n FROM entries WHERE project_ulid = ? AND deleted_at IS NULL`);
        // Stage C (rule 8): notes still waiting for their number from the post office.
        const pending = new Map(pendingCounts(db).filter((r) => r.project).map((r) => [r.project as string, r.n]));
        for (const p of all) {
          const n = (count.get(p.ulid) as { n: number }).n;
          const waiting = pending.get(p.ulid) ?? 0;
          io.out(`${cur?.ulid === p.ulid ? "*" : " "} ${p.code.padEnd(8)} ${p.name.padEnd(24)} ${p.mode.padEnd(5)} ${String(n).padStart(5)} note(s)${waiting ? `, ${waiting} waiting for a number` : ""}`);
        }
        return { code: 0 };
      }
      case "use": {
        const [code] = words(rest);
        if (!code) { io.err("usage: collab project use <code>"); return { code: 2 }; }
        const db = getDb();
        const p = findProject(db, code);
        if (!p) throw notFound(db, code);
        return useProject(p, io);
      }
      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    return fail(io, (e as Error).message);
  } finally {
    closeDb();
  }
}
