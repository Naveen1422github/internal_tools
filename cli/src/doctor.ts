import {
  formatSetupReport, installAddon, removeStaleHeartbeats, runSetupDoctor, runtimeDirFor, type SetupReport,
} from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";

type CourierModule = { runCli(argv: string[], io: Io): Promise<{ code: number }> };

/**
 * `--fix` does only repairs that can't lose data and can be undone (spec P11):
 * fetch the add-on, start the courier, remove leftover status files. Migrating,
 * adopting and reindexing stay printed fixes, never run.
 */
async function fix(report: SetupReport, io: Io, importModule: (s: string) => Promise<unknown>): Promise<void> {
  const by = (id: string) => report.checks.find((c) => c.id === id);
  const attempt = async (what: string, fn: () => Promise<string | null>) => {
    try {
      const why = await fn();
      io.out(why === null ? `fixed: ${what}` : `could not fix: ${what} (${why})`);
    } catch (e) { io.out(`could not fix: ${what} (${(e as Error).message})`); }
  };
  if (by("install.addon")?.mark === "error") {
    await attempt("sync add-on", async () => {
      const r = await installAddon();
      return r.state === "ok" ? null : r.state === "hash-mismatch" ? "the download was damaged or altered" : r.state;
    });
  }
  const courier = by("programs.courier");
  if (courier?.mark === "warn" && courier.fix === "collab sync start") {
    await attempt("courier started", async () => {
      const lines: string[] = [];
      const r = await ((await importModule("@collab-mcp/courier")) as CourierModule).runCli(["sync", "start"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
      return r.code === 0 ? null : lines.join(" ") || `exit ${r.code}`;
    });
  }
  if (by("programs.stale") && report.notebook) {
    await attempt("leftover status files removed", async () => {
      removeStaleHeartbeats(runtimeDirFor({ path: report.notebook!.path, name: report.notebook!.name }));
      return null;
    });
  }
}

export async function runDoctor(args: string[], io: Io, importModule: (s: string) => Promise<unknown>): Promise<CliResult> {
  if (args.includes("--fix")) await fix(await runSetupDoctor(), io, importModule);
  const report = await runSetupDoctor();
  io.out(args.includes("--json") ? JSON.stringify(report) : formatSetupReport(report));
  return { code: report.exitCode };
}
