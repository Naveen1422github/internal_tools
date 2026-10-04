# Collab Web UI, part 1 of 4: Lock the local web server

Status: design approved in conversation 2026-10-04, awaiting spec review. Series: (1) lock the web server, (2) sync visibility + conflicts, (3) this-laptop sync controls, (4) team admin on the post-office laptop.

## In one paragraph (plain language)

The web UI's server (`server/`, port 7473) only listens on this laptop, but today it accepts any request that reaches it, including one sent by any website open in your browser. Such a page could quietly edit or delete notes now, and once parts 3 and 4 add buttons, it could share a client module with the team or revoke a laptop. Part 1 makes the server accept only requests from its own UI: a secret key created at every start, delivered inside the UI page, and checked on every API call along with the Host, Origin and Content-Type headers. Nothing changes for you: you still open `http://127.0.0.1:7473`.

## Why this is first

- The hole exists today (`server/src/server.ts`: the request handler runs any matched route with no checks), so fixing it protects the existing edit/delete/supersede/upsert routes too.
- Parts 3 and 4 put team-admin actions (share a module, add a member, revoke) behind HTTP. Those are only safe once this lands.

## Threats covered

| Attack | How it works | Stopped by |
|---|---|---|
| Cross-site request forgery (CSRF) | A web page you have open sends a hidden `POST http://127.0.0.1:7473/api/...` | Key header (the page cannot know it) + Origin check + JSON-only bodies |
| "Simple" form posts | `Content-Type: text/plain` / form posts skip the browser's CORS preflight | Non-empty bodies must be `application/json` (and the key header is required anyway) |
| DNS rebinding | An attacker domain is pointed at 127.0.0.1 so the browser treats it as same-site, then reads `index.html` to steal the key | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` |
| Key leaks | Key appears in logs or API responses | Never logged; never in any `/api` response; only in `index.html` and the key file |

Out of scope: other programs running as you on this laptop (they can read the key file; same trust level as reading `collab.db` directly), and other users on a shared machine beyond file permissions.

## Design

### 1. The key
- Created on every server start: 32 random bytes, hex.
- Written to `%LOCALAPPDATA%/collab/web/key` (Linux/macOS: `~/.local/share/collab/web/key`), file mode 0600 where the OS supports it. Overwritten each start; removed on clean shutdown is NOT required.
- Served inside `index.html` as `<meta name="collab-key" content="...">`, injected by `serveStatic` when it serves `index.html` (including the SPA fallback). Static assets are not changed.

### 2. One gate in `server.ts`, before any route
For every request whose path starts with `/api/`:
1. `Host` must equal `127.0.0.1:<port>` or `localhost:<port>`; else 403.
2. If `Origin` is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`; else 403.
3. `X-Collab-Key` must equal the key (constant-time compare, `crypto.timingSafeEqual`); else 403.
4. A request with a non-empty body must have `Content-Type` starting with `application/json`; else 415. (Empty-body POSTs such as doctor are allowed; the key header already forces a CORS preflight, so this is defence in depth.)
- No CORS headers are ever sent, so preflights fail and cross-origin JS cannot read anything.
- The `Host` check also applies to static files (`index.html` carries the key).
- A refusal logs one line: method, path, which check failed. Never the key or the header value.
- Code lives in a new `server/src/guard.ts` (pure function `checkRequest(req, {port, key}) → null | {status, reason}`) so it is unit-testable without a socket.

### 3. The UI
- Every UI request already goes through `ui/src/api/client.ts` (`getJson` / `postJson`; verified 2026-10-04, no other `fetch(` in `ui/src`). Those two functions add `X-Collab-Key`, read once from the meta tag. One choke point, and new code that uses the client cannot forget the header.
- If the meta tag is missing (UI opened from a stale build or the wrong server), the app shows one line: "This page can't talk to collab. Restart the collab web server and reload."

- The key file path can be overridden with `COLLAB_WEB_KEY_FILE` (tests use a temp file, never the real one).

### 4. Dev mode and tests
- `ui/vite.config.ts`: the `/api` proxy reads the key file and adds `X-Collab-Key`, and rewrites `Host`/`Origin` to the server's address (`changeOrigin`).
- API tests (`test/api.*.test.mts`, `test/golden/rest.golden.test.mts`): a shared helper starts the server and sends the key; existing assertions stay unchanged.

## Testing ("done" = all pass)

Unit (`server/test/guard.test.ts`, new): no key → 403; wrong key → 403; key of different length → 403 without throwing; foreign Origin → 403; missing Origin with right key → allowed (same-origin GETs and curl-with-key); `Host: evil.example:7473` → 403; `text/plain` POST → 415; correct JSON POST → allowed.
Integration: real server on a random port: `index.html` contains the meta key; no `/api` response body contains the key; an existing route (search) still works with the key; existing API tests green with the helper.
UI (vitest): the fetch wrapper adds the header to `/api` only, not to other origins.
By hand: open the UI, use search/edit; then from a browser console on another site, `fetch('http://127.0.0.1:7473/api/collab/stats')` fails.

## Risks and open items
- Anything outside the repo that calls the REST API without the key will start getting 403. A search of the repo found none (only the UI, the vite proxy and the tests). Documented in the README's "REST API" section with how to read the key file.
- The key changes on every restart, so an open UI tab from before a restart will fail; the "can't talk to collab" line tells you to reload.
