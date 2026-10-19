// file: core/src/setup/fix.ts
// The setup repairs that can't lose data and can be undone (spec P11), shared by
// `collab doctor --fix` and the Health page's Fix buttons (UI parity Task 7b).
// Starting the courier is also a --fix repair, but it needs the courier package,
// so it stays in the CLI until the web UI can start it (web UI part 3).
import { installAddon } from "../addon.js";
import { removeStaleHeartbeats, runtimeDirFor } from "../heartbeat.js";
import type { SetupReport } from "./types.js";

/** Each safe repair: the check it fixes, and its name in `collab doctor --fix`'s lines. */
export const SAFE_FIXES = {
  "install.addon": "sync add-on",
  "programs.stale": "leftover status files removed",
} as const;
export type SafeFixId = keyof typeof SAFE_FIXES;

/** The safe repairs this report asks for, in the order --fix runs them. */
export function fixableIds(report: SetupReport): SafeFixId[] {
  const by = (id: string) => report.checks.find((c) => c.id === id);
  const out: SafeFixId[] = [];
  if (by("install.addon")?.mark === "error") out.push("install.addon");
  if (by("programs.stale") && report.notebook) out.push("programs.stale");
  return out;
}

/** Runs one safe repair: null when it worked, else why not (the words --fix prints in brackets). */
export async function runSafeFix(id: SafeFixId, report: SetupReport): Promise<string | null> {
  if (id === "install.addon") {
    const r = await installAddon();
    return r.state === "ok" ? null : r.state === "hash-mismatch" ? "the download was damaged or altered" : r.state;
  }
  if (!report.notebook) return "no notebook is open";
  removeStaleHeartbeats(runtimeDirFor({ path: report.notebook.path, name: report.notebook.name }));
  return null;
}
