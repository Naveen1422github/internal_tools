import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// A tiny built UI so index.html can be served without building the real UI.
const uiDist = path.join(os.tmpdir(), `collab-ui-${crypto.randomUUID()}`);
fs.mkdirSync(uiDist, { recursive: true });
fs.writeFileSync(path.join(uiDist, 'index.html'), '<html><head><title>collab</title></head><body></body></html>');
process.env.COLLAB_UI_DIST = uiDist;

const { startTestServer } = await import('./helpers/server.mjs');

let srv: any;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); fs.rmSync(uiDist, { recursive: true, force: true }); });

const port = () => Number(new URL(srv.baseUrl).port);
/** Raw node:http GET so the Host header can be forged (fetch does not allow it). */
function rawGet(p: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port(), path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    }).on('error', reject);
  });
}

test('no key -> 403 with a generic body', async () => {
  const r = await srv.rawFetch(srv.baseUrl + '/api/collab/stats');
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'forbidden' });
});

test('the right key -> 200, and the response does not contain the key', async () => {
  const r = await fetch(srv.baseUrl + '/api/collab/stats');
  assert.equal(r.status, 200);
  assert.ok(!(await r.text()).includes(srv.key));
});

test('foreign Origin with the right key -> 403', async () => {
  const r = await srv.rawFetch(srv.baseUrl + '/api/collab/stats', {
    headers: { 'x-collab-key': srv.key, origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
});

test('POST with a text/plain body and the right key -> 415', async () => {
  const r = await srv.rawFetch(srv.baseUrl + '/api/collab/doctor', {
    method: 'POST', headers: { 'x-collab-key': srv.key, 'content-type': 'text/plain' }, body: 'x',
  });
  assert.equal(r.status, 415);
});

test('rebinding Host is refused for /api AND for index.html', async () => {
  assert.equal((await rawGet('/api/collab/stats', { Host: `evil.example:${port()}`, 'x-collab-key': srv.key })).status, 403);
  assert.equal((await rawGet('/', { Host: `evil.example:${port()}` })).status, 403);
});

test('localhost Host and Origin are accepted', async () => {
  const r = await rawGet('/api/collab/stats', {
    Host: `localhost:${port()}`, Origin: `http://localhost:${port()}`, 'x-collab-key': srv.key,
  });
  assert.equal(r.status, 200);
});

test('index.html carries the key; the key file holds the same key', async () => {
  const r = await srv.rawFetch(srv.baseUrl + '/');
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(`<meta name="collab-key" content="${srv.key}">`));
  assert.equal(fs.readFileSync(process.env.COLLAB_WEB_KEY_FILE!, 'utf8').trim(), srv.key);
});

test('an SPA route (no extension) also gets the key', async () => {
  const r = await srv.rawFetch(srv.baseUrl + '/knowledge');
  assert.ok((await r.text()).includes(srv.key));
});
