// RnR S3 Task 4: a web server whose notebook is joined to a real post office.
// The web server module is a process singleton bound to COLLAB_DB_PATH at
// import, so one office-backed server per test file.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * An office with two joined laptops: `a` (the first member, Office admin) is
 * the web server's notebook; `b` (Office member) is driven over HTTPS or by a
 * courier. Everything lives in one temp folder.
 */
export async function startTeamServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-team-web-'));
  const saved = Object.fromEntries(
    ['COLLAB_DATA_DIR', 'COLLAB_DB_PATH', 'COLLAB_WEB_KEY_FILE', 'COLLAB_NOTEBOOK', 'CLAUDE_PROJECT_DIR'].map((k) => [k, process.env[k]]),
  );
  // Heartbeats, notebook lookups and the web key go to the temp folder, never the real ones.
  process.env.COLLAB_DATA_DIR = path.join(root, 'data');
  process.env.COLLAB_WEB_KEY_FILE = path.join(root, 'web-key');
  delete process.env.COLLAB_NOTEBOOK;
  delete process.env.CLAUDE_PROJECT_DIR;

  const { startOffice, joinedDb } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'courier', 'test', 'world.ts')).href);
  const office = await startOffice(root, 0);
  const a = await joinedDb(office, root, 'a');
  const b = await joinedDb(office, root, 'b');
  process.env.COLLAB_DB_PATH = a.path;

  // dynamic import AFTER env is set so the singleton binds to a's notebook
  const { start } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'server', 'dist', 'server.js')).href);
  const { getDb, lastResolution } = await import('@collab-mcp/core');
  const { server, port, key } = await start(0, '127.0.0.1');
  const db = getDb();
  if (path.resolve(lastResolution().path) !== path.resolve(a.path)) {
    throw new Error(`the web server opened ${lastResolution().path}, not the test notebook ${a.path}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const rawFetch = globalThis.fetch;
  /** GET or POST one /api route with the access key; answers { status, body }. */
  const api = async (route, body) => {
    const res = await rawFetch(baseUrl + route, body === undefined
      ? { headers: { 'x-collab-key': key } }
      : { method: 'POST', headers: { 'x-collab-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await office.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { baseUrl, key, db, api, office, a, b, root, close };
}
