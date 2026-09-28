import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Migrations ship WITH the code, so they are resolved relative to the package.
// Layout:
//   internal-tools/mcp/
//     migrations/*.sql
//     src/db.ts      <- this file
const MIGRATIONS_DIR = join(__dirname, "../../mcp/migrations");

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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/**
 * Apply any un-applied migrations in lexical order.
 * Idempotent: safe to call on every startup.
 * Returns the list of versions applied in this call.
 */
export function migrate(db: DB = getDb()): string[] {
  // Bootstrap the bookkeeping table (also created by 0001_init, but we need it
  // before we can read from it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as string)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    // Each migration file owns its BEGIN/COMMIT; we just exec.
    db.exec(sql);
    newlyApplied.push(version);
  }

  return newlyApplied;
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
