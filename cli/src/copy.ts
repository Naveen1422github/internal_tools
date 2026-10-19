import { applyCopy, closeDb, copyPlanLines, copyResultLines, getDb, planCopy } from "@collab-mcp/core";
import { failPlain, type CliResult, type Io } from "./io.js";

// `collab copy` (spec P8, rule 7): list, ask, then copy. The lines come from
// core (copyPlanLines / copyResultLines), the same ones collab_copy prints.

const USAGE = "usage: collab copy --from <module | project | note:<SH-12>> --to <project> [--author me] [--since <YYYY-MM-DD>] [--yes]";
const VALUED = new Set(["--from", "--to", "--author", "--since"]);

const fail = (io: Io, msg: string): CliResult => { io.err(`collab: ${msg.replace(/^\[collab(-mcp)?\] /, "")}`); return { code: 1 }; };

export async function runCopy(args: string[], io: Io): Promise<CliResult> {
  const opts: Record<string, string> = {};
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") { yes = true; continue; }
    if (!VALUED.has(a) || args[i + 1] === undefined) { io.err(USAGE); return { code: 2 }; }
    opts[a.slice(2)] = args[++i];
  }
  if (!opts.from || !opts.to) { io.err(USAGE); return { code: 2 }; }
  try {
    const db = getDb();
    const plan = planCopy(db, { from: opts.from, to: opts.to, author: opts.author, since: opts.since });
    for (const l of copyPlanLines(plan)) io.out(l);
    if (plan.items.length === 0) return { code: 0 };
    if (!yes) {
      if (!io.ask) {
        io.out("Nothing copied: run again with --yes to copy, or run it in a terminal to be asked.");
        return { code: 0 };
      }
      const n = plan.items.length;
      if (!(await io.ask(`Copy ${n === 1 ? "this note" : `these ${n} notes`} into ${plan.target.code} (${plan.target.name})? [y/N] `))) {
        io.out("Nothing copied.");
        return { code: 0 };
      }
    }
    const r = await applyCopy(db, plan);
    for (const l of copyResultLines(r)) io.out(l);
    return { code: 0 };
  } catch (e) {
    return failPlain(io, e);
  } finally {
    closeDb();
  }
}
