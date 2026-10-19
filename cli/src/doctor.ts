import { fixableIds, runSafeFix, runSetupDoctor, SAFE_FIXES, formatSetupReport, type SetupReport } from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";

type CourierModule = { runCli(argv: string[], io: Io): Promise<{ code: number }> };

/**
 * `--fix` does only repairs that can't lose data and can be undone (spec P11):
 * fetch the add-on, start the courier, remove leftover status files. Migrating,
 * adopting and reindexing stay printed fixes, never run. The add-on and status
 * files are core's safe repairs, shared with the Health page.
 */
async function fix(report: SetupReport, io: Io, importModule: (s: string) => Promise<unknown>): Promise<void> {
  const attempt = async (what: string, fn: () => Promise<string | null>) => {
    try {
      const why = await fn();
      io.out(why === null ? `fixed: ${what}` : `could not fix: ${what} (${why})`);
    } catch (e) { io.out(`could not fix: ${what} (${(e as Error).message})`); }
  };
  const safe = fixableIds(report);
  if (safe.includes("install.addon")) await attempt(SAFE_FIXES["install.addon"], () => runSafeFix("install.addon", report));
  const courier = report.checks.find((c) => c.id === "programs.courier");
  if (courier?.mark === "warn" && courier.fix === "collab sync start") {
    await attempt("courier started", async () => {
      const lines: string[] = [];
      const r = await ((await importModule("@collab-mcp/courier")) as CourierModule).runCli(["sync", "start"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
      return r.code === 0 ? null : lines.join(" ") || `exit ${r.code}`;
    });
  }
  if (safe.includes("programs.stale")) await attempt(SAFE_FIXES["programs.stale"], () => runSafeFix("programs.stale", report));
}

export async function runDoctor(args: string[], io: Io, importModule: (s: string) => Promise<unknown>): Promise<CliResult> {
  if (args.includes("--fix")) await fix(await runSetupDoctor(), io, importModule);
  const report = await runSetupDoctor();
  io.out(args.includes("--json") ? JSON.stringify(report) : formatSetupReport(report));
  return { code: report.exitCode };
}
