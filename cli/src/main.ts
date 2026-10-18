import { join } from "node:path";
import { installRoot, readBuildInfo } from "@collab-mcp/core";
import type { CliResult, Deps, Io } from "./io.js";
import { runNotebook } from "./notebook.js";
import { runDoctor } from "./doctor.js";
import { runProject } from "./project.js";
import { runCopy } from "./copy.js";
import { runTeam } from "./team.js";
import { runRefused } from "./refused.js";

export type { CliResult, Deps, Io } from "./io.js";

// Spec P1: one command, `collab`, routing to the existing programs.

const USAGE = `usage: collab [--notebook <name>] <command>

  collab sync ...                         the courier (sharing): setup, start, stop, status, run
  collab office ...                       the post office: init, serve, ...
  collab mcp                              the MCP server for Claude Code (stdio)
  collab web                              the web UI and REST server
  collab notebook list                    the notebooks on this computer
  collab notebook adopt <path> --name <n> register an existing notebook where it is
  collab notebook new <name>              create a new, empty notebook in your data folder
  collab notebook default <name>          the notebook used when nothing else picks one
  collab notebook which                   the notebook this folder uses, and why
  collab notebook reindex                 rebuild the search index of that notebook
  collab project create <name> --code <C> a solo project: its notes are numbered C-1, C-2, ...
  collab project create <name> --code <C> --team
                                          a team project: the post office numbers its notes and shares them
  collab project promote <code>           make a solo project a team project (its notes keep their numbers)
  collab project rename <code> <new name> rename a project (its code never changes)
  collab project list                     the projects in this notebook (* = this folder's) and their bound modules
  collab project bind <module> <code>     new notes whose primary module is <module> go to project <code>
                                          (beats this folder's .collab; an explicit project beats it; local to this laptop)
  collab project unbind <module>          remove that binding
  collab project use <code>               make it this folder's project (writes .collab)
  collab team list <CODE>                 who is in a team project, and their roles
  collab team set <member> <CODE> <role>  give a member a role in a team project
  collab team remove <member> <CODE>      take a member out of a team project
  collab team office-role <member> <role> a member's role in the whole office
  collab team invite <name>               add a member to the office: prints their join code
  collab team revoke <member>             cut a member off from the office
  collab refused list                     changes the post office refused, kept on this laptop
  collab refused copy <id> --to <CODE>    copy one into a solo project
  collab refused delete <id>              discard one
  collab copy --from <module|project> --to <project> [--author me] [--since <date>] [--yes]
                                          copy notes into a project: lists them, asks, then copies
  collab doctor [--json] [--fix]          check the whole setup and print the fix for each problem
  collab --version`;

type CourierModule = { runCli(argv: string[], io: Io): Promise<{ code: number; stop?: () => Promise<void> }> };
type WebModule = { start(): Promise<{ port: number; host: string }> };
type OfficeModule = { runCli(argv: string[], io: Io): Promise<{ code: number; office?: { close(): Promise<void> } }> };

export async function main(argv: string[], io: Io, deps: Deps = {}): Promise<CliResult> {
  const importModule = deps.importModule ?? ((s: string) => import(s));
  const args = [...argv];
  if (args[0] === "--notebook") {
    // Rule 1 of the notebook choice (spec P7): explicit wins.
    const name = args[1];
    if (!name) { io.err("--notebook needs a name"); return { code: 2 }; }
    process.env.COLLAB_NOTEBOOK = name;
    args.splice(0, 2);
  }
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "--version":
    case "-v": {
      const b = readBuildInfo();
      io.out(`collab ${b.version} (build ${b.build}${b.builtAt ? `, ${b.builtAt}` : ""})`);
      return { code: 0 };
    }
    case "sync": {
      const courier = (await importModule("@collab-mcp/courier")) as CourierModule;
      return courier.runCli(["sync", ...rest], io);
    }
    case "office": {
      const office = (await importModule("@collab-mcp/post-office")) as OfficeModule;
      const r = await office.runCli(rest, io);
      return r.office ? { code: r.code, stop: () => r.office!.close() } : { code: r.code };
    }
    case "mcp":
      // Top-level code of the MCP server starts the stdio server.
      await importModule("collab-mcp/dist/server.js");
      return { code: 0 };
    case "web": {
      process.env.COLLAB_UI_DIST ??= join(installRoot(), "ui", "dist");
      // The server listens by itself only when run as server.js; here we start it.
      const web = (await importModule("@collab-mcp/server/dist/server.js")) as WebModule;
      const r = await web.start();
      io.out(`collab web: http://${r.host}:${r.port}/  (Ctrl+C to stop)`);
      return { code: 0 };
    }
    case "notebook":
      return runNotebook(rest, io);
    case "project":
      return runProject(rest, io);
    case "team":
      return runTeam(rest, io);
    case "refused":
      return runRefused(rest, io);
    case "copy":
      return runCopy(rest, io);
    case "doctor":
      return runDoctor(rest, io, importModule);
    default:
      io.err(USAGE);
      return { code: 2 };
  }
}
