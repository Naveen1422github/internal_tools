const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Path resolution: default to project root / mcp / collab.db
// This will be configurable via .env
const DEFAULT_DB_PATH = process.env.COLLAB_DB_PATH || path.join(__dirname, '..', 'mcp', 'collab.db');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'mcp', 'migrations');

let _db = null;

function getDb(dbPath = DEFAULT_DB_PATH) {
  if (_db) return _db;
  
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    _db = db;
    return db;
  } catch (err) {
    console.error('[core/db] Failed to open database:', err.message);
    throw err;
  }
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function migrate(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  const applied = new Set(rows.map(r => r.version));

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn('[core/db] Migrations directory not found:', MIGRATIONS_DIR);
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    newlyApplied.push(version);
  }

  return newlyApplied;
}

function estimateTokens(text) {
  if (!text) return 0;
  const divisor = text.includes('```') ? 3.2 : 4.0;
  return Math.ceil(text.length / divisor);
}

module.exports = {
  getDb,
  closeDb,
  migrate,
  estimateTokens,
};
