import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillUlids } from "./backfill.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Migrations ship WITH the code, so they are resolved relative to the package.
// Layout:
//   internal-tools/mcp/
//     migrations/*.sql
//     src/db.ts      <- this file
const MIGRATIONS_DIR = join(__dirname, "../../mcp/migrations");

// Migrations written but not yet released. Only tests and rehearsals read them
// (includeStaged). Going live = moving the file up one folder, after every
// server is stopped, because every running build scans MIGRATIONS_DIR.
const STAGED_DIR = join(MIGRATIONS_DIR, "staged");

export type DB = Database.Database;

export type DbPathSource = "argument" | "COLLAB_DB_PATH" | "cwd-fallback";

export interface DbPathResolution {
  path: string;
  source: DbPathSource;
}

/**
 * Decide which SQLite file to open, in priority order:
 *   1. an explicit path argument
 *   2. $COLLAB_DB_PATH
 *   3. ./collab.db, relative to the CURRENT WORKING DIRECTORY
 *
 * Step 3 is deliberately cwd-relative and must NEVER resolve inside the
 * installation directory. A package-relative default is shared by every
 * project pointed at that install, which silently merges unrelated knowledge
 * bases into one file: see collab E-550, where a second workspace spent days
 * writing its entries into this repo's collab.db with no error and no warning.
 *
 * Contrast with MIGRATIONS_DIR above, which is package-relative on purpose.
 * Code belongs to the install; data belongs to the project.
 */
export function resolveDbPath(explicit?: string): DbPathResolution {
  if (explicit) return { path: explicit, source: "argument" };

  const fromEnv = process.env.COLLAB_DB_PATH;
  if (fromEnv) return { path: fromEnv, source: "COLLAB_DB_PATH" };

  return { path: join(process.cwd(), "collab.db"), source: "cwd-fallback" };
}

let _db: DB | null = null;
let _dbPath: string | null = null;

export function getDb(dbPath?: string): DB {
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

  const { path, source } = resolveDbPath(dbPath);

  // The fallback is safe (per-project) but implicit, so say so out loud.
  // stderr keeps this off the MCP stdio channel.
  if (source === "cwd-fallback") {
    console.error(
      `[collab-mcp] COLLAB_DB_PATH is not set - opening ${path}\n` +
        `[collab-mcp] Set COLLAB_DB_PATH to pin this project to a specific knowledge base.`,
    );
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  _db = db;
  _dbPath = path;
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
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

export interface MigrateOptions {
  includeStaged?: boolean;
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
  const core = listSql(MIGRATIONS_DIR);
  const staged = opts.includeStaged ? listSql(STAGED_DIR) : [];
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

function applyMigrations(db: DB, pending: Pending[]): string[] {
  if (pending.length > 0) backupBeforeMigrating(db, pending[0].version);
  for (const m of pending) {
    // Each migration file owns its BEGIN/COMMIT; we just exec.
    db.exec(readFileSync(m.file, "utf-8"));
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
