import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, migrate, closeDb, addEntry } from '@collab-mcp/core';

// Builds a fresh, isolated temp DB with a fixed seed for deterministic golden tests.
// getDb() binds a module-level singleton to COLLAB_DB_PATH on first call, so this must
// be the first getDb() in the test process; close() resets it.
export function freshDb() {
  const tmp = path.join(os.tmpdir(), `collab-golden-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmp;
  const db = getDb(tmp);
  migrate(db);

  // Mirror the proven arg shape from mcp/src/scripts/seed.ts (kind/category are derived from type).
  addEntry(db, { type: 'decision', title: 'Alpha decision', summary: 'a', description: 'd', agent: 'Claude', module: 'demo' });
  addEntry(db, { type: 'changelog', title: 'Beta change', summary: 'b', description: 'd', agent: 'Claude', module: 'demo' });
  addEntry(db, { type: 'gotcha', title: 'Gamma gotcha', summary: 'g', description: 'd', agent: 'Claude', module: 'other' });

  return {
    db,
    tmp,
    close: () => {
      closeDb();
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(tmp + suffix); } catch { /* ignore */ }
      }
    },
  };
}
