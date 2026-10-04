# Collab Web UI Part 1: Lock the Local Web Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Code-block convention:** a block whose first line is `// file: <path>` is the COMPLETE content of a new file. Edits to existing files are described in prose with the exact snippet to add or replace.

**Goal:** The collab web server (`server/`, port 7473) only answers requests from its own UI: a secret key made at every start, delivered inside `index.html`, required on every `/api` call together with Host, Origin and Content-Type checks.

**Architecture:** A pure guard (`server/src/guard.ts`) decides allow/refuse from request headers, so it is unit-tested without sockets. `server/src/web-key.ts` makes the key, writes it to a user-only file, and injects it into `index.html`. `server/src/server.ts` runs the guard before any route and injects the key when serving `index.html`. The UI's single HTTP choke point (`ui/src/api/client.ts`, `getJson`/`postJson`) reads the key from the meta tag and sends `X-Collab-Key`. The vite dev proxy reads the key file. Existing API tests keep their assertions; their shared helper adds the key.

**Tech Stack:** TypeScript 5.3, Node ≥ 20.9 (`node:crypto`, `node:http`), node:test via tsx 4 (root `test/*.test.mts`), React 19 + vitest (UI, `environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-10-04-collab-web-lock-design.md`. Context: collab E-739 (go-live), E-740 (bugs #2/#3). Series: part 2 spec `docs/superpowers/specs/2026-10-04-collab-web-sync-visibility-design.md` builds on this.

**Branch:** `collab-web-lock`, created from `collabv1` at the commit that contains this plan. Run `npm install` at the repo root once before Task 1.

## Global Constraints

- Key: 32 random bytes, hex (64 chars), new on every server start.
- Key file: `COLLAB_WEB_KEY_FILE` if set; else Windows `%LOCALAPPDATA%/collab/web/key`, others `~/.local/share/collab/web/key`; mode 0600 where supported. Tests ALWAYS set `COLLAB_WEB_KEY_FILE` to a temp path; never write the real one in tests.
- Allowed Host values: exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive). Allowed Origin (when present): `http://127.0.0.1:<port>` or `http://localhost:<port>`. `Origin: null` is refused.
- Header name: `X-Collab-Key`. Compare with `crypto.timingSafeEqual`; different lengths are refused without throwing.
- A request with a non-empty body (`content-length > 0` or chunked) must have `Content-Type` starting with `application/json`, else **415**. Every other refusal is **403**. Refusal body: `{"error":"forbidden"}` (403) / `{"error":"unsupported content type"}` (415).
- The key is never logged and never appears in any `/api` response. It appears only in `index.html` (as `<meta name="collab-key" content="...">`) and the key file.
- No CORS headers are ever sent.
- The Host check applies to every request (static files too); the key/Origin/Content-Type checks apply to paths starting with `/api/`.
- One log line per refusal: `[guard] refused <METHOD> <path>: <host|origin|key|content-type>`.
- Port, URLs and API response shapes do not change.
- Windows is the real platform. No POSIX-only calls (chmod is best-effort, wrapped in try/catch).
- Never commit `vendor/`, `dist/`, `.superpowers/`, key files. Commits go on `collab-web-lock` only. Never commit to `collabv1`.
- Do not change `mcp/`, `core/`, `courier/`, `post-office/`.

## Review Focus

1. **Opening the UI at `http://localhost:7473` instead of `127.0.0.1`** must work (Host and Origin both accept `localhost`). Test: Task 2, "localhost Host and Origin are accepted".
2. **A tab left open across a server restart** sends the old key → 403. The user must see "reload", not silent empty pages. Test: Task 3, "a 403 tells the user to reload".
3. **`Origin: null`** (sandboxed iframe, `file://` page) must be refused. Test: Task 1, "Origin null is refused".
4. **Key file location not writable** (e.g. `LOCALAPPDATA` points somewhere read-only, or the path is a file) must not stop the server: the UI still gets the key from `index.html`; one warning line is logged. Test: Task 2, "an unwritable key file does not stop the server".
5. **A curl-style POST with a body but no Content-Type** (`curl -d`) is refused with 415 even with the right key. Test: Task 1 "body without JSON type → 415" and Task 2 integration.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `server/src/guard.ts` | new | `allowedHosts`, `checkHost`, `checkApiRequest` (pure) |
| `server/src/web-key.ts` | new | `webKeyPath`, `createWebKey`, `readWebKey`, `injectKey` |
| `server/src/server.ts` | modify | run the guard; inject the key into `index.html`; `start()` also returns `key`; `COLLAB_UI_DIST` override |
| `test/web-guard.test.mts` | new | unit tests for `guard.ts` and `web-key.ts` |
| `test/api.lock.test.mts` | new | integration tests against a real server |
| `test/helpers/server.mjs` | modify | temp key file; fetch wrapper that adds the key for the test server; `rawFetch` |
| `ui/src/api/client.ts` | modify | send `X-Collab-Key`; 403 → "reload" error; `collabKey()` |
| `ui/src/api/client.test.ts` | modify | header + 403 tests |
| `ui/src/components/KeyMissingNotice.tsx` | new | one-line notice when the key meta tag is missing (not in dev) |
| `ui/src/components/AppShell.tsx` | modify | render the notice |
| `ui/vite.config.ts` | modify | dev proxy adds the key, drops Origin |
| `README.md` | modify | "REST API access" note |

---

### Task 1: The guard (pure function)

**Files:**
- Create: `server/src/guard.ts`
- Test: `test/web-guard.test.mts` (create; Task 2 appends to it)

**Interfaces:**
- Produces:
  - `allowedHosts(port: number): string[]`
  - `checkHost(headers: IncomingHttpHeaders, port: number): GuardRefusal | null`
  - `checkApiRequest(req: { headers: IncomingHttpHeaders; method?: string }, opts: { port: number; key: string }): GuardRefusal | null`
  - `type GuardRefusal = { status: 403 | 415; reason: 'host' | 'origin' | 'key' | 'content-type' }`

- [ ] **Step 1: Write the failing tests**

```ts
// file: test/web-guard.test.mts
import { test } from 'node:test';
import assert from 'node:assert';
import { checkApiRequest, checkHost } from '../server/src/guard.ts';

const PORT = 7473;
const KEY = 'a'.repeat(64);
const ok = (extra: Record<string, string> = {}) => ({
  method: 'GET',
  headers: { host: `127.0.0.1:${PORT}`, 'x-collab-key': KEY, ...extra },
});
const check = (req: any) => checkApiRequest(req, { port: PORT, key: KEY });

test('the right key from the right host is allowed', () => {
  assert.equal(check(ok()), null);
});

test('no key -> 403 key', () => {
  const r = ok(); delete (r.headers as any)['x-collab-key'];
  assert.deepEqual(check(r), { status: 403, reason: 'key' });
});

test('wrong key, and a key of a different length, -> 403 key without throwing', () => {
  assert.deepEqual(check(ok({ 'x-collab-key': 'b'.repeat(64) })), { status: 403, reason: 'key' });
  assert.deepEqual(check(ok({ 'x-collab-key': 'short' })), { status: 403, reason: 'key' });
});

test('foreign Origin -> 403 origin, even with the right key', () => {
  assert.deepEqual(check(ok({ origin: 'https://evil.example' })), { status: 403, reason: 'origin' });
});

test('Origin null is refused', () => {
  assert.deepEqual(check(ok({ origin: 'null' })), { status: 403, reason: 'origin' });
});

test('same-site Origin (127.0.0.1 or localhost) is allowed', () => {
  assert.equal(check(ok({ origin: `http://127.0.0.1:${PORT}` })), null);
  assert.equal(check(ok({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` })), null);
});

test('rebinding Host -> 403 host', () => {
  assert.deepEqual(check(ok({ host: `evil.example:${PORT}` })), { status: 403, reason: 'host' });
  assert.deepEqual(checkHost({ host: `evil.example:${PORT}` }, PORT), { status: 403, reason: 'host' });
  assert.deepEqual(checkHost({ host: `127.0.0.1:9999` }, PORT), { status: 403, reason: 'host' });
  assert.equal(checkHost({ host: `LOCALHOST:${PORT}` }, PORT), null);
});

test('body without JSON type -> 415; JSON body or empty POST allowed', () => {
  const post = (h: Record<string, string>) => ({ method: 'POST', headers: { ...ok().headers, ...h } });
  assert.deepEqual(check(post({ 'content-length': '5', 'content-type': 'text/plain' })), { status: 415, reason: 'content-type' });
  assert.deepEqual(check(post({ 'content-length': '5' })), { status: 415, reason: 'content-type' });
  assert.deepEqual(check(post({ 'transfer-encoding': 'chunked' })), { status: 415, reason: 'content-type' });
  assert.equal(check(post({ 'content-length': '5', 'content-type': 'application/json; charset=utf-8' })), null);
  assert.equal(check(post({ 'content-length': '0' })), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/web-guard.test.mts`
Expected: FAIL, cannot find module `../server/src/guard.ts`.

- [ ] **Step 3: Implement**

```ts
// file: server/src/guard.ts
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// The web server listens on 127.0.0.1 only, but any web page open in the
// browser can still send it requests. This guard lets through only requests
// from the collab UI itself (spec: docs/superpowers/specs/2026-10-04-collab-web-lock-design.md).

export type GuardRefusal = { status: 403 | 415; reason: 'host' | 'origin' | 'key' | 'content-type' };

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Every request (static files too: index.html carries the key). Stops DNS rebinding. */
export function checkHost(headers: IncomingHttpHeaders, port: number): GuardRefusal | null {
  const host = String(headers.host ?? '').toLowerCase();
  return allowedHosts(port).includes(host) ? null : { status: 403, reason: 'host' };
}

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every /api request: Host, then Origin (if sent), then the key, then the body type. */
export function checkApiRequest(
  req: { headers: IncomingHttpHeaders; method?: string },
  opts: { port: number; key: string },
): GuardRefusal | null {
  const h = req.headers;
  const host = checkHost(h, opts.port);
  if (host) return host;
  if (h.origin !== undefined) {
    const origins = allowedHosts(opts.port).map((x) => `http://${x}`);
    if (!origins.includes(String(h.origin).toLowerCase())) return { status: 403, reason: 'origin' };
  }
  const given = h['x-collab-key'];
  if (typeof given !== 'string' || !sameKey(given, opts.key)) return { status: 403, reason: 'key' };
  const hasBody = Number(h['content-length'] ?? 0) > 0 || /chunked/i.test(String(h['transfer-encoding'] ?? ''));
  if (hasBody && !/^application\/json\b/i.test(String(h['content-type'] ?? ''))) {
    return { status: 415, reason: 'content-type' };
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test test/web-guard.test.mts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/guard.ts test/web-guard.test.mts
git commit -m "feat(web): request guard for the local web server (host, origin, key, JSON body)"
```

---

### Task 2: The key, and the server runs the guard

**Files:**
- Create: `server/src/web-key.ts`
- Modify: `server/src/server.ts`
- Modify: `test/helpers/server.mjs`
- Modify: `test/web-guard.test.mts` (append)
- Create: `test/api.lock.test.mts`

**Interfaces:**
- Consumes: `checkHost`, `checkApiRequest` (Task 1).
- Produces:
  - `webKeyPath(): string`, `createWebKey(path?: string): string`, `readWebKey(path?: string): string | null`, `injectKey(html: string, key: string): string`
  - `start(port?, host?)` now resolves `{ server, port, host, key }`.
  - Test helper `startTestServer()` resolves `{ baseUrl, db, close, key, rawFetch }`; while it runs, `globalThis.fetch` adds `X-Collab-Key` (and `Content-Type: application/json` when a body is present and no type is set) to requests whose URL starts with `baseUrl`. `rawFetch` is the original fetch.
  - Env `COLLAB_UI_DIST`: folder the server serves the UI from (default `ui/dist`).

- [ ] **Step 1: Write the failing unit tests (append to `test/web-guard.test.mts`)**

Add these imports at the top of `test/web-guard.test.mts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWebKey, readWebKey, injectKey } from '../server/src/web-key.ts';
```

Append:

```ts
test('createWebKey writes a fresh 64-hex key that readWebKey reads back', () => {
  const file = path.join(os.tmpdir(), `collab-web-key-${crypto.randomUUID()}`, 'key');
  try {
    const k1 = createWebKey(file);
    assert.match(k1, /^[0-9a-f]{64}$/);
    assert.equal(readWebKey(file), k1);
    const k2 = createWebKey(file);
    assert.notEqual(k2, k1, 'a new key on every start');
    assert.equal(readWebKey(file), k2);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('an unwritable key file does not stop the server: createWebKey still returns a key', () => {
  const blocker = path.join(os.tmpdir(), `collab-web-blocker-${crypto.randomUUID()}`);
  fs.writeFileSync(blocker, 'a file, not a folder');
  try {
    const k = createWebKey(path.join(blocker, 'web', 'key'));
    assert.match(k, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(blocker, { force: true }); }
});

test('readWebKey returns null when the file is missing', () => {
  assert.equal(readWebKey(path.join(os.tmpdir(), `nope-${crypto.randomUUID()}`)), null);
});

test('injectKey puts the meta tag in <head>, or in front when there is no head', () => {
  assert.equal(injectKey('<html><head><title>x</title></head></html>', 'k'),
    '<html><head><title>x</title><meta name="collab-key" content="k"></head></html>');
  assert.equal(injectKey('<p>x</p>', 'k'), '<meta name="collab-key" content="k"><p>x</p>');
});
```

- [ ] **Step 2: Write the failing integration tests**

```ts
// file: test/api.lock.test.mts
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx tsx --test test/web-guard.test.mts`
Expected: FAIL, cannot find module `../server/src/web-key.ts`.
(`test/api.lock.test.mts` imports the BUILT server; it is run after Step 6.)

- [ ] **Step 4: Implement `web-key.ts`**

```ts
// file: server/src/web-key.ts
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
```

- [ ] **Step 5: Wire the server (`server/src/server.ts`)**

1. Add imports after `import * as ai from './tools/ai.js';`:

```ts
import { checkApiRequest, checkHost, type GuardRefusal } from './guard.js';
import { createWebKey, injectKey } from './web-key.js';
```

2. Replace `const UI_DIST = path.join(__dirname, '..', '..', 'ui', 'dist');` with:

```ts
const UI_DIST = process.env.COLLAB_UI_DIST || path.join(__dirname, '..', '..', 'ui', 'dist');
const WEB_KEY = createWebKey();
let boundPort = PORT; // the real port once listening (tests use port 0)
```

3. In `serveStatic`, replace the `try { const content = await fs.readFile(filePath); ... }` success branch with:

```ts
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (path.basename(filePath) === 'index.html') return sendIndex(res, content);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
```

and in the SPA fallback replace

```ts
        const html = await fs.readFile(path.join(UI_DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
        return;
```

with

```ts
        return sendIndex(res, await fs.readFile(path.join(UI_DIST, 'index.html')));
```

4. Add above `serveStatic`:

```ts
/** index.html carries the access key; never cached, so a restart's new key is picked up on reload. */
function sendIndex(res: http.ServerResponse, content: Buffer) {
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(injectKey(content.toString('utf8'), WEB_KEY));
}
```

5. In the `http.createServer` handler, after the `send` helper is defined and BEFORE `const handler = routes[key];`, add:

```ts
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
```

6. In `start`, change the return type to `Promise<{ server: http.Server; port: number; host: string; key: string }>`, set `boundPort = actualPort;` right after `const actualPort = ...`, and resolve `{ server, port: actualPort, host, key: WEB_KEY }`.

- [ ] **Step 6: Update the test helper (`test/helpers/server.mjs`)**

In `startTestServer`, before the dynamic import of the server, add:

```js
  const keyFile = path.join(os.tmpdir(), `collab-web-key-${crypto.randomUUID()}`);
  process.env.COLLAB_WEB_KEY_FILE = keyFile;
```

Replace `const { server, port } = await start(0, '127.0.0.1');` with `const { server, port, key } = await start(0, '127.0.0.1');`, and after `const baseUrl = ...;` add:

```js
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
```

In `close`, before `resolve()`, add `globalThis.fetch = rawFetch; try { fs.unlinkSync(keyFile); } catch {}`. Return `{ baseUrl, db, close, key, rawFetch }`.

- [ ] **Step 7: Build the server and run everything that touches it**

Run: `npm -w @collab-mcp/server run build`
Run: `npx tsx --test test/web-guard.test.mts test/api.lock.test.mts`
Expected: PASS (12 unit + 8 integration).
Run: `npx tsx --test test/**/*.test.mts`
Expected: every pre-existing API/golden test still PASSES unchanged (the helper adds the key). If a golden snapshot differs ONLY because of new log lines, investigate; do not update snapshots to hide a behaviour change.

- [ ] **Step 8: Commit**

```bash
git add server/src/web-key.ts server/src/server.ts test/helpers/server.mjs test/web-guard.test.mts test/api.lock.test.mts
git commit -m "feat(web): access key per start, injected into index.html; server refuses unauthenticated /api requests"
```

---

### Task 3: The UI sends the key

**Files:**
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/client.test.ts`
- Create: `ui/src/components/KeyMissingNotice.tsx`
- Modify: `ui/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: the meta tag `<meta name="collab-key" content="...">` (Task 2).
- Produces: `collabKey(): string | null`, `resetCollabKeyForTests(): void`, `keyMissingMessage(key: string | null, isDev: boolean): string | null`, `RELOAD_MESSAGE` (exported string) from `ui/src/api/client.ts`.

- [ ] **Step 1: Write the failing tests (append inside `describe('api client', ...)` in `ui/src/api/client.test.ts`)**

Add `collabKey, resetCollabKeyForTests, keyMissingMessage, RELOAD_MESSAGE` to the existing `import { aiChat, isDraft, type AiResponse } from './client';` line, then append:

```ts
  describe('access key', () => {
    afterEach(() => { delete (globalThis as any).document; resetCollabKeyForTests(); });
    const withMeta = (content: string | null) => {
      (globalThis as any).document = {
        querySelector: (sel: string) =>
          sel === 'meta[name="collab-key"]' && content !== null ? { getAttribute: () => content } : null,
      };
      resetCollabKeyForTests();
    };

    it('GET and POST send X-Collab-Key from the meta tag', async () => {
      withMeta('k123');
      await api.stats();
      await api.supersede([1], 2);
      const [, getOpts] = (globalThis.fetch as any).mock.calls[0];
      const [, postOpts] = (globalThis.fetch as any).mock.calls[1];
      expect(getOpts.headers['X-Collab-Key']).toBe('k123');
      expect(postOpts.headers['X-Collab-Key']).toBe('k123');
      expect(postOpts.headers['Content-Type']).toBe('application/json');
    });

    it('no meta tag: no header, and collabKey() is null', async () => {
      withMeta(null);
      await api.stats();
      const [, opts] = (globalThis.fetch as any).mock.calls[0];
      expect(opts.headers['X-Collab-Key']).toBeUndefined();
      expect(collabKey()).toBeNull();
    });

    it('a 403 tells the user to reload', async () => {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as any;
      await expect(api.stats()).rejects.toThrow(RELOAD_MESSAGE);
      await expect(api.supersede([1], 2)).rejects.toThrow(RELOAD_MESSAGE);
    });

    it('keyMissingMessage: only when the key is missing and not in dev', () => {
      expect(keyMissingMessage(null, false)).toMatch(/Restart the collab web server and reload/);
      expect(keyMissingMessage(null, true)).toBeNull();
      expect(keyMissingMessage('k', false)).toBeNull();
    });
  });
```

(`afterEach` must be in the vitest import at the top of the file; it already imports `afterEach`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/api/client.test.ts`
Expected: FAIL, `collabKey` / `RELOAD_MESSAGE` not exported.

- [ ] **Step 3: Implement in `ui/src/api/client.ts`**

Above `async function getJson`, add:

```ts
// The server only answers requests that carry its access key, which it puts
// into index.html as <meta name="collab-key">. Read once, sent on every call.
export const RELOAD_MESSAGE = "collab refused this request. The server was probably restarted: reload the page.";
let cachedKey: string | null | undefined;
export function collabKey(): string | null {
  if (cachedKey === undefined) {
    const doc = (globalThis as any).document as Document | undefined;
    cachedKey = doc?.querySelector('meta[name="collab-key"]')?.getAttribute('content') || null;
  }
  return cachedKey;
}
export function resetCollabKeyForTests(): void { cachedKey = undefined; }
function keyHeader(): Record<string, string> {
  const k = collabKey();
  return k ? { 'X-Collab-Key': k } : {};
}
export function keyMissingMessage(key: string | null, isDev: boolean): string | null {
  if (key || isDev) return null; // dev: the vite proxy adds the key
  return "This page can't talk to collab. Restart the collab web server and reload.";
}
```

Replace `getJson` with:

```ts
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: keyHeader() });
  if (res.status === 403) throw new Error(RELOAD_MESSAGE);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}
```

In `postJson`, change the headers to `{ 'Content-Type': 'application/json', ...keyHeader() }` and add `if (res.status === 403) throw new Error(RELOAD_MESSAGE);` as the first line after the `fetch` call.

- [ ] **Step 4: Add the notice**

```tsx
// file: ui/src/components/KeyMissingNotice.tsx
import { collabKey, keyMissingMessage } from '../api/client';

/** One line when this page was not served by the collab web server (no access key). */
export default function KeyMissingNotice() {
  const msg = keyMissingMessage(collabKey(), import.meta.env.DEV);
  if (!msg) return null;
  return (
    <div role="alert" className="px-4 py-2 text-sm bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">
      {msg}
    </div>
  );
}
```

In `ui/src/components/AppShell.tsx`, add `import KeyMissingNotice from './KeyMissingNotice';` and render `<KeyMissingNotice />` as the first child of `<main ...>` (directly above `<header ...>`).

- [ ] **Step 5: Run to verify they pass**

Run: `cd ui && npx vitest run src/api/client.test.ts`
Expected: PASS (existing tests + 4 new).
Run: `cd ui && npx tsc -b --noEmit` if supported, else `npx tsc -p tsconfig.app.json --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/client.test.ts ui/src/components/KeyMissingNotice.tsx ui/src/components/AppShell.tsx
git commit -m "feat(ui): send the web access key on every API call; tell the user to reload on 403"
```

---

### Task 4: Dev proxy and README

**Files:**
- Modify: `ui/vite.config.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the key file path rule (Global Constraints) — duplicated in the vite config on purpose, because the UI's TypeScript project cannot import from `server/`.

- [ ] **Step 1: Replace `ui/vite.config.ts`**

```ts
// file: ui/vite.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same path rule as server/src/web-key.ts (kept in sync by hand: the UI's
// TypeScript project cannot import from server/).
function readWebKey(): string | null {
  const file = process.env.COLLAB_WEB_KEY_FILE || join(
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) : join(homedir(), '.local', 'share'),
    'collab', 'web', 'key',
  );
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev: forward API calls to the Node backend on 7473 with its access key.
      '/api': {
        target: 'http://127.0.0.1:7473',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = readWebKey(); // per request: the key changes on every server restart
            if (key) proxyReq.setHeader('x-collab-key', key);
            proxyReq.removeHeader('origin'); // the dev page's origin (port 5173) is not the server's
          });
        },
      },
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
    globals: true,
  },
});
```

- [ ] **Step 2: README**

In `README.md`, at the end of the section `## Optional: the web UI`, add:

```markdown
### REST API access

The web server only answers its own UI. Every `/api` request needs the header
`X-Collab-Key`; the key is new on every server start and is written to
`%LOCALAPPDATA%\collab\web\key` (Windows) or `~/.local/share/collab/web/key`.
A script on this machine can read that file:

    curl -H "X-Collab-Key: $(cat ~/.local/share/collab/web/key)" http://127.0.0.1:7473/api/collab/stats

Requests from other websites, with a wrong Host/Origin, or with a non-JSON body are refused.
```

- [ ] **Step 3: Check**

Run: `cd ui && npx vitest run`
Expected: all UI tests PASS (the config still loads).

- [ ] **Step 4: Commit**

```bash
git add ui/vite.config.ts README.md
git commit -m "feat(ui): dev proxy forwards the web access key; document REST API access"
```

---

### Task 5: Final check (no code)

- [ ] Run: `npm -w @collab-mcp/server run build && npx tsx --test test/**/*.test.mts` → all PASS.
- [ ] Run: `cd ui && npx vitest run` → all PASS.
- [ ] Run: `npx tsc --noEmit -p server` → clean.
- [ ] `git log --oneline collabv1..HEAD` shows 4 commits; `git status` clean; no `dist/`, `vendor/`, key files committed.
- [ ] Write a short run log (what passed, any deviation from this plan and why) as the last commit message body or a reply to the dispatcher. By-hand checks (open the UI; a foreign-site `fetch` fails) are done by the user on their laptop after merge.
