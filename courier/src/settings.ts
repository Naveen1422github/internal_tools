// file: courier/src/settings.ts
// `collab sync set-address` and `collab sync autostart on|off` as functions,
// so the CLI and the web's Settings page run the same code (UI parity Task 11).
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadCrsqlite, moveOfficeAddress, normalizeOfficeUrl, samePath, getSyncValue, SYNC_KEYS } from "@collab-mcp/core";
import { courierFiles } from "./paths.js";
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type AutostartDeps } from "./autostart.js";
import { readCourierConfig, writeCourierConfig } from "./setup.js";

/** How the courier is launched at login from this install (`collab sync run`). */
export function autostartContextFor(dir: string, extra: Partial<AutostartContext> = {}): AutostartContext {
  return {
    platform: process.platform,
    nodePath: process.execPath,
    binPath: fileURLToPath(new URL("./bin.js", import.meta.url)),
    home: homedir(),
    env: process.env,
    courierDir: dir,
    logPath: courierFiles(dir).log,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    ...extra,
  };
}

export type AddressResult =
  | { ok: true; url: string }
  /** usage: not an https://host:port address; setup: this machine isn't set up; refused: nothing changed. */
  | { ok: false; kind: "usage" | "setup" | "refused"; reason: string };

/**
 * The post office moved: check the new address answers with the certificate
 * pinned at join, then point the notes DB (and the courier's config, when it
 * is the courier's notebook) at it. `db`: the caller's open notebook (the web
 * server's); without it, the courier's own notebook is opened.
 */
export async function setPostOfficeAddress(dir: string, rawUrl: string, opts: { db?: Database.Database; dbPath?: string } = {}): Promise<AddressResult> {
  const url = normalizeOfficeUrl(rawUrl);
  if (!url) return { ok: false, kind: "usage", reason: "the address must look like https://host:port, e.g. https://192.168.1.40:7443" };
  const cfg = readCourierConfig(dir);
  if (!opts.db && !cfg) return { ok: false, kind: "setup", reason: "this machine is not set up for sync yet: collab sync setup <join code>" };
  const db = opts.db ?? new Database(cfg!.dbPath, { fileMustExist: true });
  try {
    if (!opts.db) loadCrsqlite(db);
    if (!getSyncValue(db, SYNC_KEYS.fingerprint)) {
      return { ok: false, kind: "setup", reason: "this notes DB has no post office certificate on record; run collab sync setup <join code>" };
    }
    const why = await moveOfficeAddress(db, url);
    if (why) return { ok: false, kind: "refused", reason: why };
  } finally {
    if (!opts.db) { try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ } db.close(); }
  }
  // The courier reads its own config on start: keep it in step when it serves this notebook.
  if (cfg && (!opts.dbPath || samePath(cfg.dbPath, opts.dbPath))) writeCourierConfig(dir, { ...cfg, postOffice: url });
  return { ok: true, url };
}

/** Start sync at login, or not. Answers `collab sync autostart on|off`'s lines; null when not set up for sync. */
export function setAutostart(dir: string, on: boolean, ctx: AutostartContext = autostartContextFor(dir), deps?: AutostartDeps): string[] | null {
  const cfg = readCourierConfig(dir);
  if (!cfg) return null;
  const plan = autostartPlan(ctx);
  const lines: string[] = [];
  if (on) {
    installAutostart(plan, deps);
    lines.push("start at login: ON", ...plan.describe.map((l) => `  ${l}`));
  } else {
    const notes = removeAutostart(plan, deps);
    lines.push(`start at login: OFF${notes.length ? ` (notes: ${notes.join("; ")})` : ""}`);
  }
  writeCourierConfig(dir, { ...cfg, autostart: on });
  return lines;
}
