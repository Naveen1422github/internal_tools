// Loads .env before anything else. server.ts must import this FIRST: ES modules
// evaluate imports in order, and tools/collab.ts opens the DB at import time.
// If .env loads later, COLLAB_DB_PATH is still unset when the DB opens, and
// getDb() falls back to ./collab.db in the cwd: an empty DB, with no error.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
// The settings subpath, not the core index: importing the index here would
// evaluate every core module BEFORE .env loads (imports are hoisted), and some
// read process.env at import time (e.g. COLLAB_AUTOEXPAND_MAX_TOKENS).
import { loadSettings } from '@collab-mcp/core/settings';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });
// Installed package: no repo .env exists, so this is where PORT and the AI key come from (spec P14).
loadSettings();

// A relative COLLAB_DB_PATH in .env means "relative to the repo root", not
// relative to wherever the server was started from (npm -w runs in server/).
const dbPath = process.env.COLLAB_DB_PATH;
if (dbPath && !path.isAbsolute(dbPath)) {
  process.env.COLLAB_DB_PATH = path.resolve(ROOT, dbPath);
}
