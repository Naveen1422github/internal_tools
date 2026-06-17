import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startTestServer() {
  const tmpFile = path.join(os.tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmpFile;
  // dynamic import AFTER env is set so the singleton binds to the temp DB
  const { start } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'server', 'dist', 'server.js')).href);
  const { getDb } = await import('@collab-mcp/core');
  const { server, port } = await start(0, '127.0.0.1');
  const db = getDb();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(() => {
    for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(tmpFile + s); } catch {} }
    resolve();
  }));
  return { baseUrl, db, close };
}

export function seedEntry(db, { type = 'decision', kind = 'signal', category = 'Reference',
  title = 'T', summary = 'S', description = '', agent = 'Claude', module = null,
  deprecated = 0 } = {}) {
  const info = db.prepare(`
    INSERT INTO entries (type, kind, category, title, summary, description, agent, module, deprecated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, kind, category, title, summary, description, agent, module, deprecated);
  const id = info.lastInsertRowid;
  if (module) {
    db.prepare('INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, 1)').run(id, module);
  }
  return id;
}
