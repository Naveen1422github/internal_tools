import { readBuildInfo } from "../build-info.js";
import { readHeartbeats, runtimeDirFor, type ProgramName } from "../heartbeat.js";
import { isSyncEnabled } from "../sync/state.js";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "programs" as const;
const NAME: Record<ProgramName, string> = { mcp: "MCP", courier: "courier", web: "web server" };
const FIX: Record<ProgramName, string> = {
  mcp: "type /mcp in Claude Code and reconnect collab",
  courier: "collab sync stop, then collab sync start",
  web: "stop the web server (Ctrl+C) and run collab web",
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function checkPrograms(ctx: SetupContext, st: GroupState): SetupCheck[] {
  const dir = runtimeDirFor(st.resolution!, ctx.dataDir);
  const installed = readBuildInfo();
  const beats = readHeartbeats(dir, ctx.now, ctx.isAlive);
  const live = beats.filter((h) => !h.stale);
  const out: SetupCheck[] = [];
  if (installed.build === "unknown") {
    out.push({ group: G, id: "programs.build", mark: "warn", text: "Can't tell which code programs are running: this install has no build identity", fix: "npm run build" });
  } else {
    for (const p of ["mcp", "courier", "web"] as ProgramName[]) {
      const mine = live.filter((h) => h.program === p);
      if (mine.length === 0) {
        if (p === "mcp") out.push({ group: G, id: "programs.mcp", mark: "ok", text: "MCP not running (Claude Code starts it when needed)" });
        else if (p === "courier") {
          out.push(st.db && isSyncEnabled(st.db)
            ? { group: G, id: "programs.courier", mark: "warn", text: "Courier not running: notes aren't being shared", fix: "collab sync start" }
            : { group: G, id: "programs.courier", mark: "ok", text: "Courier not running (sharing is off)" });
        } else out.push({ group: G, id: "programs.web", mark: "warn", text: "Web server not running", fix: "collab web" });
        continue;
      }
      for (const h of mine) {
        out.push(h.build === installed.build
          ? { group: G, id: `programs.${p}`, mark: "ok", text: `${cap(NAME[p])} running (pid ${h.pid})` }
          : {
              group: G, id: `programs.${p}`, mark: "error",
              text: `The ${NAME[p]} is running older code than is installed (started ${hhmm(h.startedAt)}, installed build ${hhmm(installed.builtAt)})`,
              fix: FIX[p],
            });
      }
    }
  }
  const stale = beats.length - live.length;
  if (stale > 0) {
    out.push({ group: G, id: "programs.stale", mark: "warn", text: `${stale} leftover status file(s) from programs that stopped`, fix: "collab doctor --fix" });
  }
  return out;
}
