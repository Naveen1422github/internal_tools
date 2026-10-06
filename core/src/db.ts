import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { backfillUlids } from "./backfill.js";
import { preflight0006 } from "./preflight-0006.js";
import { hasCrrTables, loadCrsqlite, isCrsqliteLoaded, ensureCrsqlite } from "./sync/extension.js";
import { installSyncPing } from "./sync/ping.js";
import { installGuardedTriggers } from "./sync/enable.js";
import { isSyncEnabled } from "./sync/state.js";
import { collabDataDir, readNotebookConfig, samePath, type NotebookConfig } from "./notebooks.js";
import { installRoot } from "./install-root.js";

// Migrations ship WITH the code, so they are resolved relative to the install
// root (the repo root in a checkout, the package folder when installed).
const MIGRATIONS_DIR = join(installRoot(), "mcp", "migrations");

// Migrations written but not yet released. Only tests and rehearsals read them
// (includeStaged). Going live = moving the file up one folder, after every
// server is stopped, because every running build scans MIGRATIONS_DIR.
const STAGED_DIR = join(MIGRATIONS_DIR, "staged");

export type DB = Database.Database;

export type DbPathSource =
  | "argument" | "notebook-flag" | "COLLAB_DB_PATH" | "collab-file" | "cwd-existing" | "cwd-create" | "default";

export interface DbPathResolution {
  path: string;
  source: DbPathSource;
  /** Registered notebook name, or null for a path that isn't in config.json. */
  name: string | null;
  /** The .collab file that decided (or that disagrees with COLLAB_DB_PATH). */
  collabFile: string | null;
  /** COLLAB_DB_PATH won, but the nearest .collab names a different notebook (spec P7). */
  clash: { collabFile: string; collabName: string; collabPath: string | null } | null;
}

export class NoNotebookError extends Error {
  constructor(readonly known: string[], cwd: string) {
    super(
      `[collab] no notebook for ${cwd}. ` +
        (known.length
          ? `You have: ${known.join(", ")}. Fix: \`collab notebook default <name>\`, or put a .collab file with "notebook = <name>" in the project folder.`
          : `No notebooks are registered. Fix: \`collab notebook adopt <path-to-collab.db> --name <name>\` or \`collab notebook new <name>\`.`),
    );
    this.name = "NoNotebookError";
  }
}

export class UnknownNotebookError extends Error {
  constructor(readonly name: string, readonly from: string, readonly known: string[]) {
    super(`[collab] ${from} names notebook "${name}", which doesn't exist. Known: ${known.join(", ") || "none"}. Fix the name, or register it with \`collab notebook adopt\`.`);
    this.name = "UnknownNotebookError";
  }
}

/**
 * Nearest .collab file at or above `startDir` (spec P7 rule 3: nearest wins).
 * `project` is the ULID on its `project = <ulid>` line (stage B1, spec P3), or null.
 */
export function findCollabFile(startDir: string): { file: string; name: string; project: string | null } | null {
  let dir = resolvePath(startDir);
  for (;;) {
    const file = join(dir, ".collab");
    if (existsSync(file)) {
      let name: string | null = null;
      let project: string | null = null;
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const clean = line.replace(/#.*/, "");
        const m = clean.match(/^\s*notebook\s*=\s*(\S+)\s*$/);
        if (m && name === null) name = m[1];
        const p = clean.match(/^\s*project\s*=\s*(\S+)\s*$/);
        if (p && project === null) project = p[1];
      }
      if (name === null) throw new Error(`[collab] ${file} has no "notebook = <name>" line`);
      return { file, name, project };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Where the .collab walk starts: CLAUDE_PROJECT_DIR when set (spec J15a), else the working folder. */
export function collabStartDir(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  return env.CLAUDE_PROJECT_DIR || (opts.cwd ?? process.cwd());
}

/**
 * Decide which notebook to open (spec P7), first match wins:
 *   0. an explicit path argument
 *   1. $COLLAB_NOTEBOOK (set by `collab --notebook <name>`)
 *   2. $COLLAB_DB_PATH
 *   3. the nearest .collab file, in cwd or the closest parent
 *   4. ./collab.db in the CURRENT WORKING DIRECTORY, only if it already exists
 *   5. the default notebook in config.json
 *   6. with allowCreate, a new ./collab.db; otherwise NoNotebookError
 *
 * Nothing here ever resolves inside the installation directory. A
 * package-relative default is shared by every project pointed at that install,
 * which silently merges unrelated knowledge bases into one file: see collab
 * E-550, where a second workspace spent days writing its entries into this
 * repo's collab.db with no error and no warning.
 *
 * Contrast with MIGRATIONS_DIR above, which is install-relative on purpose.
 * Code belongs to the install; data belongs to the user.
 */
export function resolveDbPath(
  explicit?: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; dataDir?: string; allowCreate?: boolean } = {},
): DbPathResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dataDir = opts.dataDir ?? collabDataDir(env);
  const none = { collabFile: null, clash: null };
  if (explicit) return { path: explicit, source: "argument", name: null, ...none };

  // config.json is read lazily: a broken file must not block rules 0 and 2.
  let cfg: NotebookConfig | null = null;
  const config = () => (cfg ??= readNotebookConfig(dataDir));
  const lookup = (name: string, from: string) => {
    const nb = config().notebooks[name];
    if (!nb) throw new UnknownNotebookError(name, from, Object.keys(config().notebooks));
    return nb.path;
  };
  const nameOf = (p: string): string | null => {
    try { return Object.entries(config().notebooks).find(([, v]) => samePath(v.path, p))?.[0] ?? null; } catch { return null; }
  };

  if (env.COLLAB_NOTEBOOK) {
    return { path: lookup(env.COLLAB_NOTEBOOK, "--notebook"), source: "notebook-flag", name: env.COLLAB_NOTEBOOK, ...none };
  }
  const found = findCollabFile(collabStartDir({ cwd, env }));
  if (env.COLLAB_DB_PATH) {
    const path = env.COLLAB_DB_PATH;
    let clash: DbPathResolution["clash"] = null;
    if (found) {
      let collabPath: string | null = null;
      try { collabPath = config().notebooks[found.name]?.path ?? null; } catch { collabPath = null; }
      if (!collabPath || !samePath(collabPath, path)) clash = { collabFile: found.file, collabName: found.name, collabPath };
    }
    return { path, source: "COLLAB_DB_PATH", name: nameOf(path), collabFile: found?.file ?? null, clash };
  }
  if (found) {
    return { path: lookup(found.name, found.file), source: "collab-file", name: found.name, collabFile: found.file, clash: null };
  }
  const local = join(cwd, "collab.db");
  if (existsSync(local)) return { path: local, source: "cwd-existing", name: nameOf(local), ...none };
  const c = config();
  if (c.default) return { path: c.notebooks[c.default].path, source: "default", name: c.default, ...none };
  if (opts.allowCreate) return { path: local, source: "cwd-create", name: null, ...none };
  throw new NoNotebookError(Object.keys(c.notebooks), cwd);
}

export function describeResolution(r: DbPathResolution): string {
  const who = r.name ?? r.path;
  switch (r.source) {
    case "collab-file": return `${who} (from .collab in ${dirname(r.collabFile!)})`;
    case "notebook-flag": return `${who} (from --notebook)`;
    case "COLLAB_DB_PATH": return `${who} (from COLLAB_DB_PATH)`;
    case "cwd-existing": return `${who} (collab.db in the current folder)`;
    case "cwd-create": return `${who} (new collab.db in the current folder)`;
    case "default": return `${who} (the default notebook)`;
    default: return `${who} (given by the caller)`;
  }
}

let _db: DB | null = null;
let _dbPath: string | null = null;
let _resolution: DbPathResolution | null = null;

/** How the open database was chosen (doctor and heartbeats), or null if none is open. */
export function lastResolution(): DbPathResolution | null {
  return _resolution;
}

export interface GetDbOptions {
  /** Allow creating the file when it does not exist. Only init paths pass this. */
  create?: boolean;
}

/**
 * Thrown instead of creating a new, empty database (collab E-689). A missing
 * file almost always means a wrong path (a typo, a late-loaded .env, the wrong
 * cwd), and a freshly migrated empty DB looks exactly like "all entries gone".
 */
export class MissingDatabaseError extends Error {
  constructor(path: string, source: DbPathSource) {
    super(
      `[collab-mcp] no database at ${path} (chosen by ${source}). Refusing to create an empty one.
` +
        `[collab-mcp] Fix: register an existing notebook with \`collab notebook adopt <path> --name <name>\`, ` +
        `or start a new one with \`collab notebook new <name>\`. ` +
        `To create a new knowledge base at this exact path, run once: ` +
        `COLLAB_DB_PATH="${path}" npm --prefix mcp run migrate  (or set COLLAB_DB_CREATE=1).`,
    );
    this.name = "MissingDatabaseError";
  }
}

export function getDb(dbPath?: string, opts: GetDbOptions = {}): DB {
  if (_db) {
    // The connection is a module-level singleton, so a later caller asking for a
    // DIFFERENT file would silently receive the first one. Refuse instead: a
    // request for the wrong knowledge base must never look like it succeeded.
    if (dbPath && _dbPath && dbPath !== _dbPath) {
      throw new Error(
        `[collab-mcp] getDb("${dbPath}") requested, but "${_dbPath}" is already open. ` +
          `Call closeDb() before switching databases.`,
      );
    }
    return _db;
  }

  const mayCreate = opts.create === true || process.env.COLLAB_DB_CREATE === "1";
  const r = resolveDbPath(dbPath, { allowCreate: mayCreate });
  const { path, source } = r;
  if (path !== ":memory:" && !mayCreate && !existsSync(path)) {
    throw new MissingDatabaseError(path, source);
  }
  // First line of every program (spec P12): which notebook and why. stderr: stdout is the MCP channel.
  console.error(`[collab] opened ${describeResolution(r)}: ${path}`);
  if (r.clash) {
    console.error(
      `[collab] WARNING: COLLAB_DB_PATH chose ${path}, but ${r.clash.collabFile} says notebook "${r.clash.collabName}". ` +
        `Notes are going to ${path}. Remove COLLAB_DB_PATH from this program's settings to use the project's notebook.`,
    );
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  if (hasCrrTables(db)) {
    try { loadCrsqlite(db); } catch (e) { db.close(); throw e; }
  }
  // Push on write: tell the courier after each save (never blocks the save).
  try { installSyncPing(db); } catch (e) {
    console.error(`[collab-mcp] sync ping not installed (the courier will only catch up on restart): ${(e as Error).message}`);
  }
  _db = db;
  _dbPath = path;
  _resolution = r;
  return db;
}

/** Absolute path of the currently-open database, or null if none is open. */
export function getDbPath(): string | null {
  return _dbPath;
}

/**
 * True once migration 0005 has added `entries.ulid` (and, with it, `author`).
 * Cheap per-call pragma check - deliberately NOT cached, because `migrate()`
 * can run between two calls on the same open handle (e.g. a pre-0005 DB that
 * gets upgraded mid-session), and a stale cached `false` would silently stop
 * stamping ulid/author forever. Shared by the backfill gate below and by every
 * core insert site that writes `entries` (add.ts, rollup.ts) so a pre-0005 DB
 * never sees `table entries has no column named ulid`.
 */
export function hasUlidColumns(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'ulid'`).get();
}

export function closeDb(): void {
  if (_db) {
    // cr-sqlite requires finalize before close on a connection that loaded it.
    if (isCrsqliteLoaded(_db)) { try { _db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ } }
    _db.close();
    _db = null;
    _dbPath = null;
    _resolution = null;
  }
}

export interface MigrateOptions {
  includeStaged?: boolean;
  /** Tests only: read migrations from here instead of mcp/migrations. */
  migrationsDir?: string;
  /** Tests only: defaults to <migrationsDir>/staged. */
  stagedDir?: string;
}

interface Pending {
  version: string;
  file: string;
}

function listSql(dir: string): Pending[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ version: f.replace(/\.sql$/, ""), file: join(dir, f) }));
}

/**
 * A version present in both the released folder and staged/ (e.g. copied
 * instead of moved at go-live) is refused rather than silently resolved,
 * because the two copies could differ and picking one would be a guess.
 */
export class DuplicateMigrationError extends Error {
  constructor(version: string, corePath: string, stagedPath: string) {
    super(
      `[collab-mcp] migration version "${version}" exists in both ${corePath} and ${stagedPath}. ` +
        `Delete the staged copy before migrating.`,
    );
    this.name = "DuplicateMigrationError";
  }
}

function pendingMigrations(db: DB, upTo: string | undefined, opts: MigrateOptions): Pending[] {
  // Bootstrap the bookkeeping table (also created by 0001_init, but we need it
  // before we can read from it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as string),
  );
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const stagedDir = opts.stagedDir ?? (opts.migrationsDir ? join(opts.migrationsDir, "staged") : STAGED_DIR);
  const core = listSql(migrationsDir);
  const staged = opts.includeStaged ? listSql(stagedDir) : [];
  for (const s of staged) {
    const dup = core.find((c) => c.version === s.version);
    if (dup) throw new DuplicateMigrationError(s.version, dup.file, s.file);
  }
  return [...core, ...staged]
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
    .filter((m) => !applied.has(m.version) && (upTo === undefined || m.version.slice(0, 4) <= upTo));
}

/**
 * Copy the DB aside before changing its schema. Skipped for in-memory DBs and
 * for brand-new files (no entries table yet = nothing to lose).
 * VACUUM INTO writes a consistent snapshot even with WAL, and never touches
 * the source's rowids.
 */
function backupBeforeMigrating(db: DB, firstPending: string): void {
  if (db.memory) return;
  const hasEntries = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'`)
    .get();
  if (!hasEntries) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  db.prepare("VACUUM INTO ?").run(`${db.name}.bak-${firstPending}-${stamp}`);
}

// JS that must run immediately BEFORE a given migration's SQL (after the
// backup). A hook that throws stops migrate() before that SQL runs.
const BEFORE_MIGRATION: Record<string, (db: DB) => unknown> = {
  "0006_ulid_contract": preflight0006,
};

// JS that must run immediately AFTER a given migration's SQL.
const AFTER_MIGRATION: Record<string, (db: DB) => unknown> = {
  // The SQL file creates the unguarded ref trigger; a synced notebook needs the guarded one (E-643).
  "0009_projects": (db) => { if (isSyncEnabled(db)) installGuardedTriggers(db); },
};

/** True when `table` is a cr-sqlite CRR in this file. */
function isCrr(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(`${table}__crsql_clock`);
}

/**
 * Migrations that ALTER a CRR table. cr-sqlite needs the change wrapped in
 * crsql_begin_alter / crsql_commit_alter, and the whole thing must be atomic.
 * Their SQL files carry no BEGIN/COMMIT.
 */
const CRR_ALTERS: Record<string, string> = {
  "0008_revision_author": "entry_revisions",
  "0009_projects": "entries",
};

function applyMigrations(db: DB, pending: Pending[]): string[] {
  if (pending.length > 0) backupBeforeMigrating(db, pending[0].version);
  for (const m of pending) {
    BEFORE_MIGRATION[m.version]?.(db);
    const sql = readFileSync(m.file, "utf-8");
    const crrTable = CRR_ALTERS[m.version];
    if (crrTable) {
      // No BEGIN/COMMIT in these files: one transaction around the whole alter.
      const crr = isCrr(db, crrTable);
      if (crr) ensureCrsqlite(db);
      db.transaction(() => {
        if (crr) db.prepare(`SELECT crsql_begin_alter(?)`).get(crrTable);
        db.exec(sql);
        if (crr) db.prepare(`SELECT crsql_commit_alter(?)`).get(crrTable);
      })();
    } else {
      // Each migration file owns its BEGIN/COMMIT; we just exec.
      db.exec(sql);
    }
    AFTER_MIGRATION[m.version]?.(db);
  }
  // Runs every startup, not only when 0005 applies: it repairs rows written by
  // paths that bypass core (scripts, the REST server). Cheap: WHERE ... IS NULL.
  if (hasUlidColumns(db)) {
    // Must never be able to stop startup: only the backfill call is guarded.
    // Migration SQL above is intentionally left to throw.
    try {
      backfillUlids(db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[collab-mcp] backfill failed: ${message}; run collab_doctor`);
    }
  }
  return pending.map((m) => m.version);
}

/** The newest applied migration, e.g. "0008_revision_author" (null on an empty file). */
export function latestMigration(db: DB): string | null {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!has) return null;
  return (db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get() as { v: string | null }).v;
}

/** Newest RELEASED migration this install knows (doctor check 3). */
export function latestAvailableMigration(): string | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return files.length ? files[files.length - 1].replace(/\.sql$/, "") : null;
}

/** Apply any un-applied migrations in lexical order. Idempotent. */
export function migrate(db: DB = getDb(), opts: MigrateOptions = {}): string[] {
  return applyMigrations(db, pendingMigrations(db, undefined, opts));
}

/** Test helper: apply migrations whose 4-digit prefix is <= `upTo` (e.g. "0004"). */
export function migrateTo(db: DB, upTo: string, opts: MigrateOptions = {}): string[] {
  return applyMigrations(db, pendingMigrations(db, upTo, opts));
}

/**
 * Estimate tokens for a string.
 * Uses a heuristic: ~4 chars per token for prose, ~3.2 chars per token for code.
 * Detects code by looking for triple backticks.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const divisor = text.includes("```") ? 3.2 : 4.0;
  return Math.ceil(text.length / divisor);
}
