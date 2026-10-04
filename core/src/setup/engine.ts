import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { describeResolution } from "../db.js";
import { collabDataDir } from "../notebooks.js";
import { hasCrrTables, isCrsqliteLoaded, loadCrsqlite } from "../sync/extension.js";
import { checkAddonState, checkNode, checkSqlite } from "./check-install.js";
import { checkNotebook } from "./check-notebook.js";
import { checkNotebookVersion, checkOfficeVersion } from "./check-version.js";
import { checkPrograms } from "./check-programs.js";
import { checkSync, defaultProbe } from "./check-sync.js";
import { checkClaude, defaultClaudeConfigFiles } from "./check-claude.js";
import { checkNoteData, checkSearchIndex } from "./check-notes.js";
import type { GroupId, GroupState, SetupCheck, SetupContext, SetupReport } from "./types.js";

// Spec P10: 7 check groups in dependency order. A group whose prerequisite
// failed is shown as "skipped: needs <group>", never as a pass. One check that
// throws becomes an error line; the others still run.

const OPEN_FIX = "collab doctor --fix (if the sync add-on is missing), else ask for help with this message";
const ORDER: GroupId[] = ["install", "notebook", "version", "programs", "sync", "claude", "notes"];

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
};

type Step = (ctx: SetupContext, st: GroupState) => Promise<SetupCheck | SetupCheck[] | null> | SetupCheck | SetupCheck[] | null;
interface Group { needs: "nothing" | "resolution" | "db"; steps: Array<{ id: string; run: Step }> }

const GROUPS: Record<Exclude<GroupId, "notebook">, Group> = {
  install: {
    needs: "nothing",
    steps: [
      { id: "install.node", run: () => checkNode() },
      { id: "install.sqlite", run: () => checkSqlite() },
      { id: "install.addon", run: (ctx) => checkAddonState(ctx.env) },
    ],
  },
  version: {
    needs: "db",
    steps: [
      { id: "version.notebook", run: checkNotebookVersion },
      { id: "version.office", run: checkOfficeVersion },
    ],
  },
  programs: { needs: "resolution", steps: [{ id: "programs", run: checkPrograms }] },
  sync: { needs: "db", steps: [{ id: "sync", run: checkSync }] },
  claude: { needs: "nothing", steps: [{ id: "claude.registered", run: checkClaude }] },
  notes: {
    needs: "db",
    steps: [
      { id: "notes.data", run: checkNoteData },
      { id: "notes.search", run: checkSearchIndex },
    ],
  },
};

function context(partial: Partial<SetupContext>): SetupContext {
  const env = partial.env ?? process.env;
  const cwd = partial.cwd ?? process.cwd();
  return {
    cwd,
    env,
    dataDir: partial.dataDir ?? collabDataDir(env),
    now: partial.now ?? new Date(),
    probePostOffice: partial.probePostOffice !== undefined ? partial.probePostOffice : defaultProbe,
    claudeConfigFiles: partial.claudeConfigFiles ?? defaultClaudeConfigFiles(cwd),
    isAlive: partial.isAlive ?? defaultIsAlive,
    groups: partial.groups,
  };
}

async function runSteps(g: GroupId, steps: Group["steps"], ctx: SetupContext, st: GroupState): Promise<SetupCheck[]> {
  const out: SetupCheck[] = [];
  for (const s of steps) {
    try {
      const r = await s.run(ctx, st);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    } catch (e) {
      out.push({ group: g, id: s.id, mark: "error", text: `doctor could not run this check: ${(e as Error).message}` });
    }
  }
  return out;
}

function openReadOnly(st: GroupState): void {
  const r = st.resolution;
  if (!r || !existsSync(r.path)) return;
  try {
    const db = new Database(r.path, { readonly: true, fileMustExist: true });
    try { if (hasCrrTables(db)) loadCrsqlite(db); } catch (e) { db.close(); throw e; }
    st.db = db;
  } catch (e) {
    st.dbOpenError = (e as Error).message.replace(/^\[collab(-mcp)?\] /, "");
  }
}

/**
 * cr-sqlite must be finalized before close(), or close() returns while the file
 * stays open: a leaked handle that, on Windows, blocks deleting or moving the
 * notebook (same rule as closeDb in core/src/db.ts).
 */
function closeReadOnly(st: GroupState): void {
  const db = st.db;
  st.db = null;
  if (!db) return;
  if (isCrsqliteLoaded(db)) { try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ } }
  try { db.close(); } catch { /* closing anyway */ }
}

export async function runSetupDoctor(partial: Partial<SetupContext> = {}): Promise<SetupReport> {
  const ctx = context(partial);
  const wanted = new Set(ctx.groups ?? ORDER);
  const st: GroupState = { resolution: null, db: null, dbOpenError: null };
  const checks: SetupCheck[] = [];
  try {
    for (const g of ORDER) {
      if (g === "notebook") {
        // Later groups depend on the resolution, so it is computed whenever any
        // of them runs; its lines are shown only when the group was asked for.
        if (![...wanted].some((w) => w !== "install")) continue;
        let lines: SetupCheck[];
        try { lines = checkNotebook(ctx, st); }
        catch (e) { lines = [{ group: "notebook", id: "notebook.choice", mark: "error", text: `doctor could not run this check: ${(e as Error).message}` }]; }
        openReadOnly(st);
        if (st.dbOpenError) {
          lines.push({ group: "notebook", id: "notebook.open", mark: "error", text: `The notebook can't be opened: ${st.dbOpenError}`, fix: OPEN_FIX });
        }
        if (wanted.has("notebook")) checks.push(...lines);
        continue;
      }
      if (!wanted.has(g)) continue;
      const group = GROUPS[g];
      if (group.needs === "resolution" && !st.resolution) {
        checks.push({ group: g, id: `${g}.skipped`, mark: "skipped", text: "skipped: needs notebook" });
        continue;
      }
      if (group.needs === "db" && !st.db) {
        checks.push({ group: g, id: `${g}.skipped`, mark: "skipped", text: "skipped: needs notebook" });
        continue;
      }
      checks.push(...(await runSteps(g, group.steps, ctx, st)));
    }
  } finally {
    closeReadOnly(st);
  }
  const errors = checks.filter((c) => c.mark === "error").length;
  const warnings = checks.filter((c) => c.mark === "warn").length;
  const r = st.resolution;
  return {
    checks,
    errors,
    warnings,
    exitCode: errors ? 2 : warnings ? 1 : 0,
    notebook: r ? { name: r.name, path: r.path, source: r.source, described: describeResolution(r) } : null,
  };
}

/**
 * Startup check for the MCP, courier and web server (spec P12): install +
 * notebook only; the first error, or null. Synchronous on purpose: the web
 * server must refuse to start BEFORE a sibling import opens the DB, and ES
 * modules don't wait for a sibling's top-level await.
 */
export function startupProblemSync(partial: Partial<SetupContext> = {}): SetupCheck | null {
  const ctx = context(partial);
  const st: GroupState = { resolution: null, db: null, dbOpenError: null };
  const checks: SetupCheck[] = [];
  try {
    for (const s of GROUPS.install.steps) {
      try { const r = s.run(ctx, st) as SetupCheck; if (r) checks.push(r); }
      catch (e) { checks.push({ group: "install", id: s.id, mark: "error", text: `doctor could not run this check: ${(e as Error).message}` }); }
    }
    try { checks.push(...checkNotebook(ctx, st)); }
    catch (e) { checks.push({ group: "notebook", id: "notebook.choice", mark: "error", text: `doctor could not run this check: ${(e as Error).message}` }); }
    openReadOnly(st);
    if (st.dbOpenError) checks.push({ group: "notebook", id: "notebook.open", mark: "error", text: `The notebook can't be opened: ${st.dbOpenError}`, fix: OPEN_FIX });
  } finally {
    closeReadOnly(st);
  }
  return checks.find((c) => c.mark === "error") ?? null;
}

export async function startupProblem(partial: Partial<SetupContext> = {}): Promise<SetupCheck | null> {
  return startupProblemSync(partial);
}
