import './env.js'; // must stay first: loads .env before tools/collab.js opens the DB
import './preflight.js'; // must stay second: refuses to start on a setup problem (spec P12)
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, lastResolution, readBuildInfo, runtimeDirFor, startHeartbeat } from '@collab-mcp/core';
import * as collab from './tools/collab.js';
import * as ai from './tools/ai.js';
import * as sync from './tools/sync.js';
import { checkApiRequest, checkHost, type GuardRefusal } from './guard.js';
import { createWebKey, injectKey } from './web-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 7473);
const HOST = '127.0.0.1';
const UI_DIST = process.env.COLLAB_UI_DIST || path.join(__dirname, '..', '..', 'ui', 'dist');
const WEB_KEY = createWebKey();
let boundPort = PORT; // the real port once listening (tests use port 0)
const uiBuilt = () => fsSync.existsSync(path.join(UI_DIST, 'index.html'));

const appliedMigrations = migrate();
if (appliedMigrations.length > 0) {
  console.log(`[migrate] applied: ${appliedMigrations.join(', ')}`);
}

// "I'm alive" file so collab doctor can tell which code this server runs (spec P9).
{
  const r = lastResolution()!;
  const { version, build } = readBuildInfo();
  startHeartbeat(runtimeDirFor(r), { program: 'web', version, build, dbPath: r.path, notebook: r.name });
}

// Add more tools by requiring their module and spreading its .routes here.
const routes: Record<string, any> = {
  ...collab.routes,
  ...ai.routes,
  ...sync.routes,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** index.html carries the access key; never cached, so a restart's new key is picked up on reload. */
function sendIndex(res: http.ServerResponse, content: Buffer) {
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(injectKey(content.toString('utf8'), WEB_KEY));
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  if (!uiBuilt()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('UI not built. Run `npm run ui:build` first.');
    return;
  }
  const root = UI_DIST;
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
  const filePath = path.join(root, rel);
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (path.basename(filePath) === 'index.html') return sendIndex(res, content);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback: unknown non-file path under a built UI -> serve index.html
    // so client-side routes (/knowledge, /tasks, ...) work on hard refresh.
    if (uiBuilt() && !path.extname(rel)) {
      try {
        return sendIndex(res, await fs.readFile(path.join(UI_DIST, 'index.html')));
      } catch {}
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + rel);
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url!.split('?')[0];
  const key = `${req.method} ${urlPath}`;

  const send = (status: number, body: any) => {
    const isString = typeof body === 'string';
    const payload = isString ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': isString ? 'text/plain' : 'application/json' });
    res.end(payload);
  };

  const refuse = (r: GuardRefusal) => {
    console.error(`[guard] refused ${req.method} ${urlPath}: ${r.reason}`);
    send(r.status, { error: r.status === 415 ? 'unsupported content type' : 'forbidden' });
  };
  const hostRefusal = checkHost(req.headers, boundPort);
  if (hostRefusal) return refuse(hostRefusal);
  if (urlPath.startsWith('/api/')) {
    const r = checkApiRequest(req, { port: boundPort, key: WEB_KEY });
    if (r) return refuse(r);
  }

  const handler = routes[key];
  if (handler) {
    try {
      const body = req.method === 'GET' ? null : await readBody(req);
      const result = await handler(req, res, send, body);
      // SSE handlers own the response lifecycle and intentionally keep it open.
      if (result === '__sse__') return;
    } catch (err: any) {
      console.error('[error]', key, err);
      if (!res.headersSent) {
        send(500, { error: err.message });
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, urlPath);
  send(404, { error: 'not found' });
});

function start(port = PORT, host = HOST): Promise<{ server: http.Server; port: number; host: string; key: string }> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = (server.address() as any).port;
      boundPort = actualPort;
      const isMain = process.argv[1] ? (
        path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
        process.argv[1].endsWith('server.js') ||
        process.argv[1].endsWith('server.ts')
      ) : false;
      if (isMain) {
        console.log(`Internal tools server:  http://${host}:${actualPort}/`);
        console.log('Press Ctrl+C to stop.');
      }
      resolve({ server, port: actualPort, host, key: WEB_KEY });
    });
  });
}

export { start };

const isMain = process.argv[1] ? (
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith('server.js') ||
  process.argv[1].endsWith('server.ts')
) : false;
if (isMain) {
  start();
}
