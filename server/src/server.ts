import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { migrate } from '@emp1st/core';
import * as collab from './tools/collab.js';
import * as ai from './tools/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const PORT = Number(process.env.PORT || 7473);
const HOST = '127.0.0.1';
const UI_DIST = path.join(__dirname, '..', '..', 'ui', 'dist');
const uiBuilt = () => fsSync.existsSync(path.join(UI_DIST, 'index.html'));

const appliedMigrations = migrate();
if (appliedMigrations.length > 0) {
  console.log(`[migrate] applied: ${appliedMigrations.join(', ')}`);
}

// Add more tools by requiring their module and spreading its .routes here.
const routes: Record<string, any> = {
  ...collab.routes,
  ...ai.routes,
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback: unknown non-file path under a built UI -> serve index.html
    // so client-side routes (/knowledge, /tasks, ...) work on hard refresh.
    if (uiBuilt() && !path.extname(rel)) {
      try {
        const html = await fs.readFile(path.join(UI_DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
        return;
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

function start(port = PORT, host = HOST): Promise<{ server: http.Server; port: number; host: string }> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = (server.address() as any).port;
      const isMain = process.argv[1] ? (
        path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
        process.argv[1].endsWith('server.js') ||
        process.argv[1].endsWith('server.ts')
      ) : false;
      if (isMain) {
        console.log(`Internal tools server:  http://${host}:${actualPort}/`);
        console.log('Press Ctrl+C to stop.');
      }
      resolve({ server, port: actualPort, host });
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
