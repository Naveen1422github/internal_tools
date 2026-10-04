import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "claude" as const;
const REPLACEMENT = 'replace that entry with: "collab": { "command": "collab", "args": ["mcp"] }';

/** ~/.claude.json plus every .mcp.json from cwd up to the filesystem root. */
export function defaultClaudeConfigFiles(cwd: string): string[] {
  const files = [join(homedir(), ".claude.json")];
  let dir = resolve(cwd);
  for (;;) {
    files.push(join(dir, ".mcp.json"));
    const up = dirname(dir);
    if (up === dir) return files;
    dir = up;
  }
}

interface Entry { file: string; key: string; command: string; args: string[]; env: Record<string, string> }

function isAbove(dir: string, cwd: string): boolean {
  const d = resolve(dir), c = resolve(cwd);
  return c === d || c.startsWith(d.endsWith("/") || d.endsWith("\\") ? d : d + (process.platform === "win32" ? "\\" : "/"));
}

function entries(file: string, cwd: string): Entry[] {
  if (!existsSync(file)) return [];
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  const servers: Array<Record<string, any>> = [];
  if (raw?.mcpServers && typeof raw.mcpServers === "object") servers.push(raw.mcpServers);
  if (raw?.projects && typeof raw.projects === "object") {
    for (const [dir, p] of Object.entries<any>(raw.projects)) {
      if (p?.mcpServers && typeof p.mcpServers === "object" && isAbove(dir, cwd)) servers.push(p.mcpServers);
    }
  }
  const out: Entry[] = [];
  for (const group of servers) {
    for (const [key, v] of Object.entries<any>(group)) {
      out.push({ file, key, command: String(v?.command ?? ""), args: Array.isArray(v?.args) ? v.args.map(String) : [], env: v?.env ?? {} });
    }
  }
  return out;
}

const runsFromPath = (e: Entry) => e.args.some((a) => a.replace(/\\/g, "/").endsWith("mcp/dist/server.js"));
const runsCommand = (e: Entry) => /(^|[\\/])collab(\.cmd)?$/.test(e.command) && e.args.length === 1 && e.args[0] === "mcp";

export function checkClaude(ctx: SetupContext, _st: GroupState): SetupCheck[] {
  const mine = ctx.claudeConfigFiles.flatMap((f) => entries(f, ctx.cwd)).filter((e) => e.key === "collab" || runsFromPath(e) || runsCommand(e));
  if (mine.length === 0) {
    return [{ group: G, id: "claude.registered", mark: "warn", text: "collab isn't registered in Claude Code", fix: "claude mcp add collab -- collab mcp" }];
  }
  const fromPath = mine.find(runsFromPath);
  if (fromPath) return [{ group: G, id: "claude.registered", mark: "warn", text: `Claude Code runs collab from a file path (${fromPath.file})`, fix: REPLACEMENT }];
  const good = mine.find(runsCommand);
  if (good) return [{ group: G, id: "claude.registered", mark: "ok", text: `Claude Code runs collab mcp (${good.file})` }];
  const other = mine[0];
  return [{ group: G, id: "claude.registered", mark: "warn", text: `Claude Code runs collab with an unexpected command: ${[other.command, ...other.args].join(" ")} (${other.file})`, fix: REPLACEMENT }];
}
