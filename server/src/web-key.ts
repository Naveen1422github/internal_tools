import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// The web server's access key: new on every start. The UI gets it inside
// index.html; dev tools and tests read it from this user-only file.

export function webKeyPath(): string {
  if (process.env.COLLAB_WEB_KEY_FILE) return process.env.COLLAB_WEB_KEY_FILE;
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : join(homedir(), '.local', 'share');
  return join(base, 'collab', 'web', 'key');
}

/** Always returns a key. Failing to write the file only costs dev tools; it never stops the server. */
export function createWebKey(path: string = webKeyPath()): string {
  const key = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows: best effort */ }
  } catch (e) {
    console.error(`[web] could not write the access key file ${path}: ${(e as Error).message}. The UI still works; dev tools that read the file will not.`);
  }
  return key;
}

export function readWebKey(path: string = webKeyPath()): string | null {
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

export function injectKey(html: string, key: string): string {
  const tag = `<meta name="collab-key" content="${key}">`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
}
