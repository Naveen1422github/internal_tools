// file: courier/src/setup.ts
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  migrate, enableSync, disableSync, isSyncEnabled, hasCrrTables, loadCrsqlite, isCrsqliteLoaded, setSyncValue,
  postOfficeTargetFromDb, parseJoinCode, requestJson, SYNC_KEYS,
} from "@collab-mcp/core";
import { COURIER_KEYS } from "./keys.js";
import { courierFiles } from "./paths.js";
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type AutostartDeps, type AutostartPlan } from "./autostart.js";

// `collab sync setup` and `collab sync uninstall` as plain functions (the CLI
// and the acceptance tests share them). Setup says exactly what it did and how
// to undo it; uninstall removes everything setup added (spec D6).

export interface CourierConfig {
  dbPath: string;
  postOffice: string;
  device: string;
  autostart: boolean;
  backup: string | null;
}

export function readCourierConfig(dir: string): CourierConfig | null {
  const f = courierFiles(dir).config;
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as CourierConfig;
}
export function writeCourierConfig(dir: string, cfg: CourierConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(courierFiles(dir).config, JSON.stringify(cfg, null, 2) + "\n");
}

function openNotes(path: string, create: boolean): Database.Database {
  const db = new Database(path, { fileMustExist: !create });
  db.pragma("journal_mode = WAL");
  if (hasCrrTables(db)) loadCrsqlite(db);
  return db;
}
function closeNotes(db: Database.Database): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) {
    try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  }
  db.close();
}

export interface SetupOptions {
  code: string;
  dbPath: string;
  courierDir: string;
  /** The answer to "Start sync automatically when you log in? [y/N]" (default no). */
  autostart: boolean;
  /** Only for the notes DB the post office was seeded from (D11). */
  uploadExisting?: boolean;
  /** Rehearsals/tests only, until 0007 is released (go-live). */
  includeStaged?: boolean;
  autostartCtx: AutostartContext;
  autostartDeps?: AutostartDeps;
  out: (line: string) => void;
}

export interface SetupResult {
  dbPath: string;
  device: string;
  created: boolean;
  backup: string | null;
  autostart: AutostartPlan | null;
}

export async function setup(o: SetupOptions): Promise<SetupResult> {
  const files = courierFiles(o.courierDir);
  if (readCourierConfig(o.courierDir)) {
    throw new Error(`this machine is already set up for sync (${files.config}); run \`collab sync uninstall\` first`);
  }
  const jc = parseJoinCode(o.code);
  const dbPath = resolve(o.dbPath);
  const created = !existsSync(dbPath);
  let backup: string | null = null;
  if (created) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openNotes(dbPath, true);
  let ok = false;
  try {
    migrate(db, { includeStaged: o.includeStaged === true });
    if (!db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0007_sync_prep'`).get()) {
      throw new Error("this build has not released migration 0007_sync_prep yet (the sync go-live step), so sharing cannot be set up");
    }
    if (isSyncEnabled(db) && postOfficeTargetFromDb(db)) throw new Error(`${dbPath} already shares notes with a post office`);
    const notes = (db.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c;
    if (notes > 0 && !o.uploadExisting) {
      throw new Error(
        `${dbPath} already holds ${notes} note(s). In v1 a new machine starts with an empty notes file (spec D11); ` +
          `only the notes DB the post office was seeded from joins with its notes. If this IS that DB, add --upload-existing.`,
      );
    }
    // The join code is one-time: redeem it BEFORE changing anything, so a bad code changes nothing.
    const r = await requestJson({ url: jc.url, fingerprint: jc.fingerprint }, "POST", "/v1/join", { device: jc.device, secret: jc.secret });
    if (r.status !== 200 || typeof r.body?.key !== "string") {
      throw new Error(`the post office refused the join code: ${r.body?.error ?? `status ${r.status}`}`);
    }
    backup = enableSync(db, { backup: notes > 0 }).backup;
    db.transaction(() => {
      setSyncValue(db, SYNC_KEYS.url, jc.url);
      setSyncValue(db, SYNC_KEYS.fingerprint, jc.fingerprint);
      setSyncValue(db, SYNC_KEYS.device, jc.device);
      setSyncValue(db, SYNC_KEYS.key, r.body.key as string);
      setSyncValue(db, COURIER_KEYS.sent, "0");
      setSyncValue(db, COURIER_KEYS.recv, "0");
    })();
    ok = true;
  } finally {
    closeNotes(db);
    // A refused setup leaves no trace: a notes file it created is removed again.
    if (!ok && created) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  }
  writeCourierConfig(o.courierDir, { dbPath, postOffice: jc.url, device: jc.device, autostart: o.autostart, backup });
  let plan: AutostartPlan | null = null;
  if (o.autostart) {
    plan = autostartPlan(o.autostartCtx);
    installAutostart(plan, o.autostartDeps);
  }

  o.out(`Sync is set up on this machine. What changed:`);
  o.out(`  - joined the post office at ${jc.url} as device ${jc.device} (its certificate is pinned: ${jc.fingerprint.slice(0, 16)}…)`);
  o.out(created ? `  - created a new, empty notes DB: ${dbPath}` : `  - notes DB: ${dbPath}`);
  o.out(`  - turned on sharing in it${backup ? ` (backup first: ${backup})` : ""}; this machine's key is stored in its local-only sync_state table`);
  o.out(`  - wrote ${files.config}`);
  if (plan) {
    o.out(`  - start at login: YES`);
    for (const line of plan.describe) o.out(`      ${line}`);
  } else {
    o.out(`  - start at login: no (start it yourself: collab sync start; change later: collab sync autostart on)`);
  }
  o.out(`Restart every program that writes this notes DB (MCP servers, the REST server) so they load cr-sqlite.`);
  o.out(`Only notes in shared modules leave this machine (see: collab sync modules). Every new note now gets its number from the post office.`);
  o.out(`To remove all of this: collab sync uninstall`);
  return { dbPath, device: jc.device, created, backup, autostart: plan };
}

export interface UninstallOptions {
  courierDir: string;
  autostartCtx: AutostartContext;
  autostartDeps?: AutostartDeps;
  /** Stops a running courier first (the CLI passes its pid-based stop). */
  stopCourier?: () => Promise<void>;
  out: (line: string) => void;
}

/** Removes everything setup added. Notes stay (received ones too); new notes get local numbers again. */
export async function uninstall(o: UninstallOptions): Promise<void> {
  const cfg = readCourierConfig(o.courierDir);
  if (!cfg) throw new Error("nothing to remove: this machine is not set up for sync");
  await o.stopCourier?.();
  o.out(`Removing sync from this machine:`);
  if (cfg.autostart) {
    const notes = removeAutostart(autostartPlan(o.autostartCtx), o.autostartDeps);
    o.out(`  - removed start-at-login${notes.length ? ` (notes: ${notes.join("; ")})` : ""}`);
  }
  if (existsSync(cfg.dbPath)) {
    const db = openNotes(cfg.dbPath, false);
    try { disableSync(db); } finally { closeNotes(db); }
    o.out(`  - turned sharing off in ${cfg.dbPath}: the key is deleted, the tables are plain again, every note stays`);
  }
  rmSync(o.courierDir, { recursive: true, force: true });
  o.out(`  - deleted ${o.courierDir}`);
  if (cfg.backup) o.out(`The backup taken at setup is still at ${cfg.backup} (delete it when you no longer need it).`);
  o.out(`Ask the post office owner to revoke ${cfg.device} if this machine should never sync again.`);
}
