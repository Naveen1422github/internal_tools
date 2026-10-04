import type { GroupId, Mark, SetupReport } from "./types.js";

const TITLE: Record<GroupId, string> = {
  install: "Install", notebook: "Notebook", version: "Version", programs: "Programs", sync: "Sync", claude: "Claude Code", notes: "Notes",
};
const ORDER = Object.keys(TITLE) as GroupId[];
const MARK: Record<Mark, string> = { ok: "✓", warn: "!", error: "✗", skipped: "-" };

/** The terminal report (and the MCP collab_doctor text): same words as the web Health page. */
export function formatSetupReport(r: SetupReport): string {
  const lines = ["collab doctor", ""];
  for (const g of ORDER) {
    const checks = r.checks.filter((c) => c.group === g);
    if (!checks.length) continue;
    lines.push(TITLE[g]);
    for (const c of checks) {
      lines.push(`  ${MARK[c.mark]} ${c.text}`);
      if (c.fix) lines.push(`      fix: ${c.fix}`);
    }
    lines.push("");
  }
  lines.push(r.exitCode === 0 ? "All good." : `${r.errors} problem(s), ${r.warnings} warning(s).`);
  return lines.join("\n");
}
