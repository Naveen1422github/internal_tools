import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startTestServer({ level = '0005' } = {}) {
  const tmpFile = path.join(os.tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmpFile;
  process.env.COLLAB_DB_CREATE = '1'; // test DBs are created on purpose
  const keyFile = path.join(os.tmpdir(), `collab-web-key-${crypto.randomUUID()}`);
  process.env.COLLAB_WEB_KEY_FILE = keyFile;
  // dynamic import AFTER env is set so the singleton binds to the temp DB
  const { start } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'server', 'dist', 'server.js')).href);
  const { getDb, migrate } = await import('@collab-mcp/core');
  const { server, port, key } = await start(0, '127.0.0.1');
  const db = getDb();
  // The server only applies released migrations; opt this DB into staged 0006.
  if (level === '0006') migrate(db, { includeStaged: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Every existing API test calls fetch(baseUrl + ...). Add the access key
  // (and the JSON type for bodies) here so those tests stay unchanged.
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(baseUrl)) return rawFetch(input, init);
    const headers = new Headers(init.headers);
    if (!headers.has('x-collab-key')) headers.set('x-collab-key', key);
    if (init.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return rawFetch(input, { ...init, headers });
  };
  const close = () => new Promise((resolve) => server.close(() => {
    for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(tmpFile + s); } catch {} }
    globalThis.fetch = rawFetch; try { fs.unlinkSync(keyFile); } catch {}
    resolve();
  }));
  return { baseUrl, db, close, key, rawFetch };
}

export async function seedEntry(db, { type = 'decision', category = 'Reference',
  title = 'T', summary = 'S', description = '', agent = 'Claude', module = null,
  deprecated = 0 } = {}) {
  // Through core, so the row is valid at 0005 AND 0006 (ulid, id, author).
  const { addEntry } = await import('@collab-mcp/core');
  const { id } = addEntry(db, { type, category, title, summary, description, agent, module: module ?? undefined });
  if (deprecated) db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(id);
  return id;
}
