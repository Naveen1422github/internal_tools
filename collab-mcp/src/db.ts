import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the collab package root, NOT cwd.
// Layout:
//   internal-tools/collab-mcp/
//     migrations/*.sql
//     src/db.ts      <- this file
//     collab.db      <- runtime DB (gitignored)
const PACKAGE_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");
const DEFAULT_DB_PATH = process.env.COLLAB_DB_PATH ?? join(PACKAGE_ROOT, "collab.db");

export type DB = Database.Database;

let _db: DB | null = null;

export function getDb(dbPath: string = DEFAULT_DB_PATH): DB {
  if (_db) return _db;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
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
 * Convenience: estimate tokens for a string.
 * Used by collab.add to populate entries.tokens_estimate.
 * Rough heuristic: ~4 chars per token. Off by ~15% vs real tokenizers; fine for budget caps.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
