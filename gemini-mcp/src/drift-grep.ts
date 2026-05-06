import type { DriftWarning } from "./types.js";

export function scanForDrift(
  text: string,
  allowlist: { emp1st_prefixes: string[]; ingxt_prefixes: string[] },
): DriftWarning[] {
  const stripped = stripAnsi(text);
  const warnings: DriftWarning[] = [];

  const emp1stAllowedSuffixes = allowlist.emp1st_prefixes
    .map((p) => (p.startsWith("emp1st-") ? p.slice("emp1st-".length) : p))
    .filter(Boolean);
  const ingxtAllowedSuffixes = allowlist.ingxt_prefixes
    .map((p) => (p.startsWith("ingxt-") ? p.slice("ingxt-".length) : p))
    .filter(Boolean);

  const emp1stAlt =
    emp1stAllowedSuffixes.length > 0
      ? emp1stAllowedSuffixes.map(escapeRegExp).join("|")
      : "(?!)";
  const ingxtAlt =
    ingxtAllowedSuffixes.length > 0
      ? ingxtAllowedSuffixes.map(escapeRegExp).join("|")
      : "(?!)";

  const patterns: Array<{ pattern: string; re: RegExp }> = [
    { pattern: "@\\w+[\\\\/]", re: /@\w+[\\/]/g },
    { pattern: "temaplates", re: /temaplates/gi },
    {
      pattern: "emp1st_unknown",
      re: new RegExp(
        `\\bemp1st-(?!(?:${emp1stAlt})(?:\\b|[\\\\/]))[A-Za-z0-9-]+`,
        "g",
      ),
    },
    {
      pattern: "ingxt_unknown",
      re: new RegExp(
        `\\bingxt-(?!(?:${ingxtAlt})(?:\\b|[\\\\/]))[A-Za-z0-9-]+`,
        "g",
      ),
    },
  ];

  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const { pattern, re } of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const idx = match.index ?? 0;
        const hit = match[0] ?? "";
        const start = Math.max(0, idx - 40);
        const end = Math.min(line.length, idx + hit.length + 40);
        warnings.push({
          pattern,
          line: i + 1,
          context: line.slice(start, end),
        });
      }
    }
  }

  return warnings;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
