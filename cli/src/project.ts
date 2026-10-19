import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeDb, collabStartDir, createProjectOp, currentProject, findCollabFile, findProject, getDb,
  notFound, promoteProject, renameProject, resolveDbPath, promotedLines, renamedLine, type Project,
  projectCreatedLines, projectListLines, projectListRows, bindModule, unbindModule, bindChangeLine,
} from "@collab-mcp/core";
import { failPlain, type CliResult, type Io } from "./io.js";

// `collab project ...` (spec P2): projects number their own notes (SH-1, SH-2).

const fail = (io: Io, msg: string): CliResult => { io.err(`collab: ${msg.replace(/^\[collab(-mcp)?\] /, "")}`); return { code: 1 }; };

const USAGE = "usage: collab project create <name> --code <CODE> [--team] | promote <code> | rename <code> <new name> | list | use <code> | bind <module> <code> | unbind <module>";

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
        // Team (stage C): registered at this notebook's post office first (E-820: any member creates one).
        // Same function and words as the MCP tool collab_project_create (stage B2).
        const db = getDb();
        const p = await createProjectOp(db, { name, code, team });
        for (const l of projectCreatedLines(db, p)) io.out(l);
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
        // Same lines as the MCP tool collab_project_promote (UI parity Task 7d).
        for (const l of promotedLines(db, p, wasTeam)) io.out(l);
        return { code: 0 };
      }
      case "rename": {
        const [code, ...nameWords] = words(rest);
        if (!code || nameWords.length === 0) { io.err("usage: collab project rename <code> <new name>"); return { code: 2 }; }
        const p = await renameProject(getDb(), code, nameWords.join(" "));
        io.out(renamedLine(p));
        return { code: 0 };
      }
      case "list": {
        // Same rows and words as the MCP tool collab_project_list (stage B2).
        const db = getDb();
        let cur: Project | null = null;
        try { cur = currentProject(db); } catch (e) { io.err(`collab: ${(e as Error).message.replace(/^\[collab\] /, "")}`); }
        for (const l of projectListLines(projectListRows(db, cur))) io.out(l);
        return { code: 0 };
      }
      case "bind": {
        const [module, code] = words(rest);
        if (!module || !code) { io.err("usage: collab project bind <module> <code>"); return { code: 2 }; }
        io.out(bindChangeLine(bindModule(getDb(), module, code)));
        return { code: 0 };
      }
      case "unbind": {
        const [module] = words(rest);
        if (!module) { io.err("usage: collab project unbind <module>"); return { code: 2 }; }
        io.out(bindChangeLine(unbindModule(getDb(), module)));
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
    return failPlain(io, e);
  } finally {
    closeDb();
  }
}
