// file: post-office/test/helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate, enableSync, isCrsqliteLoaded } from '@collab-mcp/core';
import { createStore, closeStore, type Store } from '../src/store.js';

export function tempDir(prefix = 'collab-po-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempStore(seedMaxId = 0): { store: Store; path: string; cleanup: () => void } {
  const t = tempDir();
  const path = join(t.dir, 'store.db');
  const store = createStore(path, { seedMaxId });
  return { store, path, cleanup: () => { try { closeStore(store); } catch { /* closed */ } t.cleanup(); } };
}

/** A simulated laptop's notes DB: the newest released migration (same as the office) + sharing on. */
export function laptop(): { db: Database.Database; path: string; cleanup: () => void } {
  const t = tempDir('collab-laptop-');
  const path = join(t.dir, 'collab.db');
  const db = new Database(path);
  migrate(db);
  enableSync(db);
  return {
    db, path,
    cleanup: () => {
      try { if (isCrsqliteLoaded(db)) db.prepare('SELECT crsql_finalize()').get(); db.close(); } catch { /* closed */ }
      t.cleanup();
    },
  };
}
