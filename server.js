const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const codex = require('./tools/codex');
const collab = require('./tools/collab');
const consoleTool = require('./tools/console');

const PORT = Number(process.env.PORT || 7473);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Add more tools by requiring their module and spreading its .routes here.
const routes = {
  ...codex.routes,
  ...collab.routes,
  ...consoleTool.routes,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function readBody(req) {
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

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
  const filePath = path.join(PUBLIC_DIR, rel);
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + rel);
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const key = `${req.method} ${urlPath}`;

  const send = (status, body) => {
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
      // If a handler returns '__sse__', it manages the response entirely itself.
      if (result === '__sse__') {
        return;
      }
    } catch (err) {
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

server.listen(PORT, HOST, () => {
  console.log(`Internal tools server:  http://${HOST}:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
});
