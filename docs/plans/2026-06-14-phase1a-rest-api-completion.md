# Phase 1A — REST API Completion + Test Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small REST-API gaps the new React UI needs (dashboard stats, category/since search filters, supersede, bulk module-reassign) and add the project's first automated test harness — all without touching the storage engine or MCP tools.

**Architecture:** The Node http server (`server/server.js`) dispatches `METHOD PATH` keys to handler maps. `server/tools/collab.js` already implements most endpoints against a `better-sqlite3` singleton from `core/db.js`. We add four endpoints to that same file (following the existing pattern), refactor `server.js` so it can be started programmatically against a temp DB, and add `node:test` HTTP-level tests (zero new dependencies — matches the project's lightweight ethos).

**Tech Stack:** Node 20, `better-sqlite3`, FTS5, built-in `node:test` + `node:assert`, global `fetch`.

---

## Why this plan (context for the engineer)

The design (`internal-tools/docs/2026-06-14-knowledge-workspace-redesign-design.md`) calls for a React SPA over the existing collab DB. Most of the API already exists in `server/tools/collab.js`:
`GET /api/collab/search`, `GET /api/collab/entry`, `POST /api/collab/entry/upsert`, `POST /api/collab/entry/delete`, `GET /api/collab/tasks`, `POST /api/collab/task/upsert|transition|assign|delete`, `GET /api/collab/modules`, `POST /api/collab/module/upsert|delete`, `GET /api/collab/module-card`, `POST /api/collab/doctor`, `GET /api/collab/export`, `GET /api/collab/dispatches`.

This plan adds only what the v1 screens need beyond that, and gives us tests so the SPA builds on a verified contract.

## Data model facts you need

- `entries` columns used here: `id` (alias of `rowid`, INTEGER PK), `type`, `kind`, `category` (`Index|Reference|Activity`), `title`, `summary`, `description`, `status` (`draft|active|resolved|deprecated`), `agent`, `module`, `task_id`, `superseded_by`, `deprecated` (0/1), `created_at`.
- `entry_modules(entry_id, module, is_primary)` — many-to-many module membership.
- `modules(slug PRIMARY KEY, ...)`.
- Supersede semantics (mirror of `mcp/src/tools/supersede.ts`): `UPDATE entries SET superseded_by = <by>, deprecated = 1 WHERE id = <id>`; validate `by` exists, `by` not in `ids`, all `ids` exist.
- `core/db.js` reads `COLLAB_DB_PATH` env var for the DB file, and `migrate(db)` applies every `.sql` in `mcp/migrations/`.

## File structure

- Modify: `server/server.js` — export a `start(port, host)` function; only auto-listen when run directly.
- Modify: `server/tools/collab.js` — add 4 endpoints; extend `search`.
- Create: `test/helpers/server.js` — boots the server on an ephemeral port against a fresh temp DB; returns `{ baseUrl, db, close }`.
- Create: `test/api.stats.test.js`
- Create: `test/api.search.test.js`
- Create: `test/api.supersede.test.js`
- Create: `test/api.reassign-module.test.js`
- Modify: `package.json` — add `"test": "node --test"` script.

---

## Task 1: Make the server startable for tests

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Wrap listen in an exported `start()` and guard auto-start**

Replace the bottom of `server/server.js` (currently `server.listen(PORT, HOST, () => {...});`) so the `http.createServer(...)` result is assigned to `const server` (already is), then replace the final `server.listen(...)` block with:

```js
function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      if (require.main === module) {
        console.log(`Internal tools server:  http://${host}:${actualPort}/`);
        console.log('Press Ctrl+C to stop.');
      }
      resolve({ server, port: actualPort, host });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start();
}
```

- [ ] **Step 2: Verify the server still starts manually (executor runs; user may prefer to do this)**

Run: `node server/server.js`
Expected: prints `Internal tools server: http://127.0.0.1:7473/`. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "refactor(server): export start() and guard auto-listen for tests"
```

---

## Task 2: Test harness helper

**Files:**
- Create: `test/helpers/server.js`
- Modify: `package.json`

- [ ] **Step 1: Write the helper**

Create `test/helpers/server.js`:

```js
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Boots the real http server on an ephemeral port against a fresh temp DB.
// Must be called before anything else requires core/db (it sets COLLAB_DB_PATH
// and lazy-requires server/db so the singleton binds to the temp file).
async function startTestServer() {
  const tmpFile = path.join(os.tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmpFile;

  // Lazy requires AFTER env is set.
  const { start } = require(path.join(__dirname, '..', '..', 'server', 'server.js'));
  const { getDb } = require(path.join(__dirname, '..', '..', 'core', 'db.js'));

  const { server, port } = await start(0, '127.0.0.1');
  const db = getDb();
  const baseUrl = `http://127.0.0.1:${port}`;

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try { fs.unlinkSync(tmpFile + suffix); } catch {}
        }
        resolve();
      });
    });

  return { baseUrl, db, close };
}

// Convenience: insert an entry directly via SQL for fixtures.
function seedEntry(db, { type = 'decision', kind = 'signal', category = 'Reference',
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

module.exports = { startTestServer, seedEntry };
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "node --test"
```

- [ ] **Step 3: Smoke-check the harness boots**

Create a throwaway check, run it, then delete it:

Run: `node -e "require('./test/helpers/server').startTestServer().then(async s => { const r = await fetch(s.baseUrl + '/api/collab/modules'); console.log('status', r.status); await s.close(); })"`
Expected: prints `status 200`.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/server.js package.json
git commit -m "test: add node:test HTTP harness with temp-db isolation"
```

---

## Task 3: `GET /api/collab/stats` (dashboard aggregates)

**Files:**
- Test: `test/api.stats.test.js`
- Modify: `server/tools/collab.js`

- [ ] **Step 1: Write the failing test**

Create `test/api.stats.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, seedEntry } = require('./helpers/server');

let srv;
before(async () => {
  srv = await startTestServer();
  seedEntry(srv.db, { category: 'Reference', type: 'decision', module: 'alpha' });
  seedEntry(srv.db, { category: 'Activity', type: 'changelog', module: 'alpha' });
  seedEntry(srv.db, { category: 'Reference', type: 'gotcha', deprecated: 1 }); // excluded
});
after(() => srv.close());

test('stats returns non-deprecated totals grouped by category and type', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/stats');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.total, 2); // deprecated one excluded
  assert.strictEqual(body.by_category.Reference, 1);
  assert.strictEqual(body.by_category.Activity, 1);
  assert.strictEqual(body.by_type.decision, 1);
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.top_modules.some((m) => m.module === 'alpha' && m.count === 2));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/api.stats.test.js`
Expected: FAIL — `stats` route missing, likely 404 (status assertion fails).

- [ ] **Step 3: Implement the route**

In `server/tools/collab.js`, add inside the `module.exports.routes = { ... }` object (e.g. after the `search` route):

```js
  'GET /api/collab/stats': async (req, res, send) => {
    try {
      const total = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE deprecated = 0').get().c;
      const rowsToMap = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.c]));
      const by_category = rowsToMap(
        db.prepare(`SELECT COALESCE(category,'(none)') AS category, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY category`).all(),
        'category'
      );
      const by_type = rowsToMap(
        db.prepare(`SELECT type, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY type`).all(),
        'type'
      );
      const by_status = rowsToMap(
        db.prepare(`SELECT status, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY status`).all(),
        'status'
      );
      const top_modules = db.prepare(`
        SELECT module, COUNT(*) AS count
        FROM entry_modules GROUP BY module ORDER BY count DESC, module ASC LIMIT 10
      `).all();
      const recent = db.prepare(`
        SELECT rowid AS id, type, category, title, summary, agent, module, created_at
        FROM entries WHERE deprecated=0 ORDER BY created_at DESC LIMIT 10
      `).all();
      send(200, { total, by_category, by_type, by_status, top_modules, recent });
    } catch (err) { send(500, { error: err.message }); }
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/api.stats.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tools/collab.js test/api.stats.test.js
git commit -m "feat(api): add GET /api/collab/stats dashboard aggregates"
```

---

## Task 4: Extend `GET /api/collab/search` with `category` + `since`

**Files:**
- Test: `test/api.search.test.js`
- Modify: `server/tools/collab.js`

- [ ] **Step 1: Write the failing test**

Create `test/api.search.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, seedEntry } = require('./helpers/server');

let srv;
before(async () => {
  srv = await startTestServer();
  seedEntry(srv.db, { category: 'Reference', type: 'decision', title: 'Ref one' });
  seedEntry(srv.db, { category: 'Activity', type: 'changelog', title: 'Act one' });
});
after(() => srv.close());

test('search filters by category', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/search?category=Reference');
  assert.strictEqual(res.status, 200);
  const { results } = await res.json();
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.category === 'Reference'));
});

test('search since=9999-01-01 returns nothing', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/search?since=9999-01-01');
  const { results } = await res.json();
  assert.strictEqual(results.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/api.search.test.js`
Expected: FAIL — `category` filter not applied (Activity rows leak in) / `since` ignored.

- [ ] **Step 3: Add the two filters to the existing `search` route**

In `server/tools/collab.js`, in the `'GET /api/collab/search'` handler, after the existing `const kind = ...` line add:

```js
    const category = url.searchParams.get('category');
    const since = url.searchParams.get('since');
```

Then, inside the `try` block, after the existing `if (agent) { ... }` block and BEFORE the `if (q.trim()) { ... }` block, add:

```js
      if (category) {
        query += ` AND e.category = ?`;
        params.push(category);
      }
      if (since) {
        query += ` AND e.created_at >= ?`;
        params.push(since);
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/api.search.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tools/collab.js test/api.search.test.js
git commit -m "feat(api): add category and since filters to search"
```

---

## Task 5: `POST /api/collab/entry/supersede`

**Files:**
- Test: `test/api.supersede.test.js`
- Modify: `server/tools/collab.js`

- [ ] **Step 1: Write the failing test**

Create `test/api.supersede.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, seedEntry } = require('./helpers/server');

let srv, oldId, newId;
before(async () => {
  srv = await startTestServer();
  oldId = seedEntry(srv.db, { title: 'old' });
  newId = seedEntry(srv.db, { title: 'new' });
});
after(() => srv.close());

async function post(path, body) {
  return fetch(srv.baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('supersede marks old entry deprecated and sets superseded_by', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [oldId], by: newId });
  assert.strictEqual(res.status, 200);
  const row = srv.db.prepare('SELECT superseded_by, deprecated FROM entries WHERE id = ?').get(oldId);
  assert.strictEqual(row.superseded_by, newId);
  assert.strictEqual(row.deprecated, 1);
});

test('supersede rejects by-in-ids', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [newId], by: newId });
  assert.strictEqual(res.status, 400);
});

test('supersede rejects missing by', async () => {
  const res = await post('/api/collab/entry/supersede', { ids: [oldId], by: 999999 });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/api.supersede.test.js`
Expected: FAIL — route missing (404).

- [ ] **Step 3: Implement the route (mirrors mcp/src/tools/supersede.ts)**

In `server/tools/collab.js`, add after the `'POST /api/collab/entry/delete'` route:

```js
  'POST /api/collab/entry/supersede': async (req, res, send, body) => {
    const { ids, by } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(400, { error: "supersede requires a non-empty 'ids' array" });
    }
    if (typeof by !== 'number') {
      return send(400, { error: "'by' must be a numeric entry id" });
    }
    if (ids.includes(by)) {
      return send(400, { error: "'by' cannot be one of the superseded 'ids'" });
    }
    try {
      const byRow = db.prepare('SELECT id FROM entries WHERE id = ?').get(by);
      if (!byRow) return send(400, { error: `'by' entry ${by} does not exist` });

      const uniqueIds = [...new Set(ids)];
      const placeholders = uniqueIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM entries WHERE id IN (${placeholders})`).all(...uniqueIds);
      const foundSet = new Set(found.map((r) => r.id));
      const missing = uniqueIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        return send(400, { error: `these ids do not exist: ${missing.join(', ')}` });
      }

      const update = db.prepare('UPDATE entries SET superseded_by = ?, deprecated = 1 WHERE id = ?');
      const tx = db.transaction((targetIds) => { for (const id of targetIds) update.run(by, id); });
      tx(uniqueIds);
      send(200, { ok: true, superseded: uniqueIds, by });
    } catch (err) { send(500, { error: err.message }); }
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/api.supersede.test.js`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tools/collab.js test/api.supersede.test.js
git commit -m "feat(api): add POST /api/collab/entry/supersede (parity with MCP)"
```

---

## Task 6: `POST /api/collab/entry/reassign-module` (one-click health fix)

**Files:**
- Test: `test/api.reassign-module.test.js`
- Modify: `server/tools/collab.js`

This is the bulk fix for the "44 entries with unknown module" health problem: point a set of entries at an existing module slug, updating both `entries.module` and the `entry_modules` join.

- [ ] **Step 1: Write the failing test**

Create `test/api.reassign-module.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, seedEntry } = require('./helpers/server');

let srv, e1, e2;
before(async () => {
  srv = await startTestServer();
  srv.db.prepare("INSERT INTO modules (slug, name) VALUES ('target', 'Target')").run();
  e1 = seedEntry(srv.db, { title: 'orphan 1', module: 'ghost' });
  e2 = seedEntry(srv.db, { title: 'orphan 2', module: 'ghost' });
});
after(() => srv.close());

async function post(path, body) {
  return fetch(srv.baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('reassign-module repoints entries to an existing module', async () => {
  const res = await post('/api/collab/entry/reassign-module', { ids: [e1, e2], module: 'target' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.updated, 2);
  for (const id of [e1, e2]) {
    const row = srv.db.prepare('SELECT module FROM entries WHERE id = ?').get(id);
    assert.strictEqual(row.module, 'target');
    const jm = srv.db.prepare("SELECT module FROM entry_modules WHERE entry_id = ? AND module = 'target'").get(id);
    assert.ok(jm, 'entry_modules row exists for target');
  }
});

test('reassign-module rejects unknown target module', async () => {
  const res = await post('/api/collab/entry/reassign-module', { ids: [e1], module: 'does-not-exist' });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/api.reassign-module.test.js`
Expected: FAIL — route missing (404).

- [ ] **Step 3: Implement the route**

In `server/tools/collab.js`, add after the `'POST /api/collab/entry/supersede'` route:

```js
  'POST /api/collab/entry/reassign-module': async (req, res, send, body) => {
    const { ids, module } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(400, { error: "reassign requires a non-empty 'ids' array" });
    }
    if (!module || typeof module !== 'string') {
      return send(400, { error: "'module' (target slug) is required" });
    }
    try {
      const exists = db.prepare('SELECT slug FROM modules WHERE slug = ?').get(module);
      if (!exists) return send(400, { error: `target module '${module}' does not exist` });

      const uniqueIds = [...new Set(ids)];
      const setPrimary = db.prepare('UPDATE entries SET module = ? WHERE id = ?');
      const clearOld = db.prepare('DELETE FROM entry_modules WHERE entry_id = ? AND is_primary = 1');
      const addJoin = db.prepare('INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, 1)');
      let updated = 0;
      const tx = db.transaction((targetIds) => {
        for (const id of targetIds) {
          const r = setPrimary.run(module, id);
          if (r.changes > 0) {
            clearOld.run(id);
            addJoin.run(id, module);
            updated += 1;
          }
        }
      });
      tx(uniqueIds);
      send(200, { ok: true, updated, module });
    } catch (err) { send(500, { error: err.message }); }
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/api.reassign-module.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: all test files PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tools/collab.js test/api.reassign-module.test.js
git commit -m "feat(api): add POST /api/collab/entry/reassign-module for health fixes"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** Dashboard ← `stats`; Knowledge browser category filter ← `search` extension; AI/detail-drawer supersede ← `supersede`; Knowledge Health one-click fix ← `reassign-module`. Tasks/Modules/Search/entry CRUD/doctor/export already exist (no task needed). AI assistant + screens are out of scope for 1A (see roadmap).
- **Placeholder scan:** none — every step has concrete code and exact run commands.
- **Type consistency:** response field names (`total`, `by_category`, `by_type`, `top_modules`, `recent`, `superseded`, `updated`) are used identically in tests and handlers. `is_primary` join semantics match the existing `entry/upsert` handler.

---

## Roadmap — remaining Phase 1 (separate plans)

**1B — React/Vite/Tailwind scaffold (write plan after 1A):**
- `npm create vite@latest ui -- --template react`, add Tailwind.
- API client module wrapping `/api/collab/*` (typed fetch helpers).
- App shell: left nav (Dashboard, Knowledge, Modules, Tasks, Health), ⌘K search palette, right-side drawer primitive, persistent AI panel slot.
- `ui:build` output served by `server/server.js` static handler (extend `serveStatic` to fall back to the built `index.html` for client-side routes).

**1C — Screens (write plan after Claude Design output exists):**
- Dashboard, Knowledge browser + detail drawer, Modules, Tasks, Knowledge Health.
- Visual components come from Claude Design (`DesignSync`); each screen task = integrate the generated component against the API client above.

**Phase 2 (AI assistant + Health logic) and Phase 3 (open-source clean-room)** follow per the design doc.
