import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "../db.js";

// cr-sqlite is a loadable SQLite extension. Once any table is a CRR, its
// triggers call crsql_* functions, so EVERY connection that writes this file
// must load the extension or its writes fail (spec D2, risks).
const __dirname = dirname(fileURLToPath(import.meta.url));
// core/src/sync (tsx) and core/dist/sync (built) are both 3 levels below internal-tools/.
const DEFAULT_BASE = join(__dirname, "../../../vendor/crsqlite/crsqlite");
const SUFFIXES = [".dll", ".so", ".dylib"];

export class CrsqliteMissingError extends Error {
  constructor(dbPath: string, tried: string) {
    super(
      `[collab-mcp] ${dbPath} shares notes (it has cr-sqlite tables), but the cr-sqlite extension was not found at ${tried}.\n` +
        `[collab-mcp] Fix: run \`npm run fetch:crsqlite\` in internal-tools, or set COLLAB_CRSQLITE_PATH.`,
    );
    this.name = "CrsqliteMissingError";
  }
}

/** Extension path WITHOUT suffix (loadExtension adds it), or null if absent. */
export function crsqlitePath(): string | null {
  const base = process.env.COLLAB_CRSQLITE_PATH || DEFAULT_BASE;
  return SUFFIXES.some((s) => existsSync(base + s)) || existsSync(base) ? base : null;
}

export function hasCrrTables(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_\\_crsql\\_clock' ESCAPE '\\' LIMIT 1`).get();
}

export function isCrsqliteLoaded(db: DB): boolean {
  try { db.prepare(`SELECT crsql_db_version()`).get(); return true; } catch { return false; }
}

/**
 * Every writer calls this first. A connection opened BEFORE `sync setup` has no
 * cr-sqlite, and its writes would fail on the CRR triggers; worse, a new note
 * would have taken a post-office number first and burned it (E-739 #2). Loading
 * the extension into the open connection heals it; if the extension is missing
 * on disk, this throws CrsqliteMissingError before anything is asked or written.
 */
export function ensureCrsqlite(db: DB): void {
  if (hasCrrTables(db) && !isCrsqliteLoaded(db)) loadCrsqlite(db);
}

export function loadCrsqlite(db: DB): void {
  if (isCrsqliteLoaded(db)) return;
  const p = crsqlitePath();
  if (!p) throw new CrsqliteMissingError(db.name, process.env.COLLAB_CRSQLITE_PATH || DEFAULT_BASE);
  db.loadExtension(p);
}
