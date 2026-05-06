import type { LocateMatch } from "./types.js";

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function extractFilesRead(text: string): string[] {
  const clean = stripAnsi(text);
  const out: string[] = [];
  const seen = new Set<string>();

  const readingRe = /Reading:\s+([^\s,]+)\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = readingRe.exec(clean)) !== null) {
    const p = (m[1] ?? "").trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }

  const listRe = /I read the following files:\s*([^\n\r]+)/gi;
  while ((m = listRe.exec(clean)) !== null) {
    const list = (m[1] ?? "").split(",").map((s) => s.trim());
    for (const p of list) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }

  return out;
}

export function extractCodeBlocks(
  text: string,
): Array<{ lang: string; content: string }> {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const blocks: Array<{ lang: string; content: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("```")) {
      i += 1;
      continue;
    }

    const lang = line.slice(3).trim();
    i += 1;
    const contentLines: string[] = [];
    while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
      contentLines.push(lines[i] ?? "");
      i += 1;
    }

    if (i >= lines.length) break;
    blocks.push({ lang, content: contentLines.join("\n") });
    i += 1;
  }

  return blocks;
}

export function parseLocateMatches(text: string): LocateMatch[] {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const matches: LocateMatch[] = [];

  const refRe = /(^|\s)([A-Za-z0-9_./-]+):(\d+)(?::(\d+))?/g;

  for (const line of lines) {
    refRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(line)) !== null) {
      const file = m[2];
      const lineNum = m[3] ? Number.parseInt(m[3], 10) : NaN;
      if (!file || !Number.isFinite(lineNum)) continue;
      matches.push({ file, line: lineNum, snippet: line.trim() });
    }
  }

  return matches;
}
