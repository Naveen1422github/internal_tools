# internal-tools Industry-Grade — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project commit policy (overrides skill default):** Agents do NOT run `git commit`. Each "Commit" step means **stage the changes and hand off to the user** to commit — the user is the integration gatekeeper. Do NOT run `npm run build` or `npm test` automatically beyond the explicit verify commands in this plan.

**Goal:** Lay the tooling foundation (npm workspaces, shared TS/lint config, hygiene) and capture behaviour-locking golden tests for every MCP tool and REST route — the de-risking checkpoint before any domain logic is moved.

**Architecture:** No logic moves in these two phases. Phase 0 adds workspace + config scaffolding and removes dead code. Phase 1 captures in-process golden snapshots (REST via the existing `test/helpers/server.js`; MCP via direct calls to the already-pure `mcp/src/tools/*` functions) that later phases re-assert to prove no behaviour changed.

**Tech Stack:** Node 20 (ESM for `mcp/`/`ui/`/`gemini-mcp/`, CJS for `server/`/`core/` until Phase 4), npm workspaces, TypeScript 5.3, `node --test`, `tsx`, better-sqlite3.

**Spec:** `internal-tools/docs/2026-06-15-internal-tools-industry-grade-design.md`

---

## File Structure (created/modified in this plan)

| File | Responsibility |
|---|---|
| `.gitignore` (modify) | Block agent exhaust (`*.log`, `*.stackdump`, `**/.npm-cache/`) |
| `server/server.js` (modify) | Remove dead `PUBLIC_DIR` fallback (dir was deleted) |
| `.nvmrc` (create) | Pin Node 20 for contributors/CI |
| `package.json` (modify) | Add `engines`, `workspaces`, root `lint` script |
| `tsconfig.base.json` (create) | Shared compiler baseline all TS packages extend |
| `eslint.config.js` (create) | Flat ESLint config across workspaces |
| `.prettierrc.json` (create) | Shared formatting |
| `test/golden/snapshot.js` (create) | Tiny JSON snapshot helper (write-on-miss, assert-on-hit) |
| `test/golden/rest.golden.test.js` (create) | REST route snapshots (CJS, `node --test`) |
| `test/golden/__snapshots__/*.json` (create) | Frozen REST outputs |
| `mcp/test/golden/seed.ts` (create) | Deterministic temp-DB seeder for MCP golden tests |
| `mcp/test/golden/snapshot.ts` (create) | Snapshot helper (ESM/TS twin of the REST one) |
| `mcp/test/golden/tools.golden.test.ts` (create) | MCP tool-function snapshots (run via `tsx --test`) |
| `mcp/test/golden/__snapshots__/*.json` (create) | Frozen MCP tool outputs |
| `mcp/package.json` (modify) | Add `test:golden` script (`tsx --test`) |

---

## Phase 0 — Tooling foundation & hygiene

### Task 0.1: Harden `.gitignore` against agent exhaust

**Files:**
- Modify: `internal-tools/.gitignore`

- [ ] **Step 1: Append exhaust patterns**

Add to the end of `.gitignore`:

```gitignore

# Agent exhaust — logs, crash dumps, stray package caches
*.log
*.stackdump
**/.npm-cache/
```

- [ ] **Step 2: Verify the patterns match**

Run:
```bash
cd internal-tools
git check-ignore -v gemini-1c.log mcp/bash.exe.stackdump gemini-mcp/.npm-cache/x 2>&1 || true
printf 'x' > probe.log && git check-ignore probe.log && rm probe.log
```
Expected: each path prints a `.gitignore:<line>` match; `probe.log` is reported ignored.

- [ ] **Step 3: Commit (stage + hand to user)**

```bash
git add internal-tools/.gitignore
# user commits: "chore(internal-tools): ignore agent exhaust (logs, stackdumps, npm caches)"
```

---

### Task 0.2: Remove the dead `PUBLIC_DIR` fallback in `server.js`

`server/public/` was deleted; `serveStatic` still falls back to it when `ui/dist` is missing, producing confusing 404s. Make "UI not built" an explicit, honest error.

**Files:**
- Modify: `internal-tools/server/server.js`

- [ ] **Step 1: Remove the `PUBLIC_DIR` constant**

Delete this line (near the top, after `UI_DIST`):

```js
const PUBLIC_DIR = path.join(__dirname, 'public');
```

- [ ] **Step 2: Replace the `serveStatic` root resolution**

Find in `serveStatic`:

```js
  const root = uiBuilt() ? UI_DIST : PUBLIC_DIR;
  const rel = urlPath === '/' ? '/index.html' : urlPath;
```

Replace with:

```js
  if (!uiBuilt()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('UI not built. Run `npm run ui:build` first.');
    return;
  }
  const root = UI_DIST;
  const rel = urlPath === '/' ? '/index.html' : urlPath;
```

- [ ] **Step 3: Verify the existing API tests still pass**

Run:
```bash
cd internal-tools
node --test test/api.search.test.js test/api.stats.test.js
```
Expected: PASS (these hit `/api/collab/*`, not static files, so they are unaffected).

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/server/server.js
# user commits: "refactor(server): drop deleted public/ fallback, 503 when UI unbuilt"
```

---

### Task 0.3: Pin Node and add `engines`

**Files:**
- Create: `internal-tools/.nvmrc`
- Modify: `internal-tools/package.json`

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Add `engines` to root `package.json`**

Insert after the `"description"` line:

```json
  "engines": { "node": ">=20.9.0" },
```

- [ ] **Step 3: Verify JSON is valid**

Run:
```bash
cd internal-tools
node -e "require('./package.json'); console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/.nvmrc internal-tools/package.json
# user commits: "chore: pin Node 20 (.nvmrc + engines)"
```

---

### Task 0.4: Convert root to an npm workspace

Unifies install/build/test/lint across `core`, `mcp`, `server`, `ui`, `gemini-mcp`. `gemini-mcp` is a member for tooling only (its internals stay out of scope).

**Files:**
- Modify: `internal-tools/package.json`

- [ ] **Step 1: Add `workspaces` + aggregate scripts**

Replace the `"scripts"` block and add `"workspaces"`:

```json
  "workspaces": ["core", "mcp", "server", "ui", "gemini-mcp"],
  "scripts": {
    "start": "node server/server.js",
    "dev": "nodemon server/server.js",
    "test": "node --test",
    "build": "npm run build --workspaces --if-present",
    "test:all": "npm run test --workspaces --if-present && node --test",
    "lint": "eslint .",
    "format": "prettier --write .",
    "mcp:dev": "npm --prefix mcp run dev",
    "mcp:build": "npm --prefix mcp run build",
    "ui:dev": "npm --prefix ui run dev",
    "ui:build": "npm --prefix ui run build"
  },
```

> Note: `core/` has no `package.json` yet, so it is not a workspace until Phase 2 creates it. Listing it now is harmless — npm warns and skips a missing member. If the warning is undesirable, omit `"core"` here and add it in Phase 2.

- [ ] **Step 2: Re-install at the workspace root**

Run:
```bash
cd internal-tools
npm install
```
Expected: completes; hoists shared deps to root `node_modules`; no errors (a warning for the not-yet-existing `core` workspace is acceptable).

- [ ] **Step 3: Verify aggregate build still works**

Run:
```bash
cd internal-tools
npm run mcp:build
```
Expected: `mcp/` compiles to `mcp/dist` (proves the prefix scripts survive the workspace conversion).

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/package.json internal-tools/package-lock.json
# user commits: "build: convert internal-tools to npm workspaces"
```

---

### Task 0.5: Shared TypeScript, ESLint, and Prettier baseline

**Files:**
- Create: `internal-tools/tsconfig.base.json`
- Create: `internal-tools/eslint.config.js`
- Create: `internal-tools/.prettierrc.json`
- Modify: `internal-tools/package.json` (devDependencies)

- [ ] **Step 1: Create `tsconfig.base.json`** (mirrors `mcp/tsconfig.json` so it can later `extends` this)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

- [ ] **Step 3: Create flat `eslint.config.js`** (ESM — root has no `type:module`, but `.js` ESLint flat config is loaded as ESM by eslint v9; if your eslint is v8, rename to `eslint.config.mjs`)

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/__snapshots__/**', 'mcp/collab.db*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
```

- [ ] **Step 4: Add dev dependencies at root**

Run:
```bash
cd internal-tools
npm install -D -W eslint@^9 @eslint/js@^9 typescript-eslint@^8 prettier@^3 typescript@~5.3.3
```
Expected: installs to root `node_modules`, updates root `package.json` devDependencies + lockfile.

- [ ] **Step 5: Verify lint runs (report-only is fine)**

Run:
```bash
cd internal-tools
npx eslint . || true
```
Expected: eslint executes and prints findings (or none). Pre-existing findings are acceptable here — this task wires up the tool, it does not fix all violations.

- [ ] **Step 6: Commit (stage + hand to user)**

```bash
git add internal-tools/tsconfig.base.json internal-tools/eslint.config.js internal-tools/.prettierrc.json internal-tools/package.json internal-tools/package-lock.json
# user commits: "build: shared tsconfig base, eslint flat config, prettier"
```

---

## Phase 1 — Behaviour-locking golden tests

These tests are the safety rail for Phases 2–4. They run **in-process** against a **seeded temp DB** and snapshot outputs. After later phases move logic, the import paths update but the snapshots must stay byte-identical — any diff is a regression.

### Task 1.1: REST golden snapshot helper

**Files:**
- Create: `internal-tools/test/golden/snapshot.js`

- [ ] **Step 1: Write the helper**

```js
// Tiny snapshot util: first run writes the snapshot; later runs assert equality.
// Set UPDATE_GOLDEN=1 to re-record intentionally.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const DIR = path.join(__dirname, '__snapshots__');

function matchSnapshot(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.json`);
  const actual = JSON.stringify(value, null, 2);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.strictEqual(actual, expected, `golden mismatch for ${name}`);
}

module.exports = { matchSnapshot };
```

- [ ] **Step 2: Sanity-check the helper in isolation**

Run:
```bash
cd internal-tools
node -e "const {matchSnapshot}=require('./test/golden/snapshot');matchSnapshot('selftest',{a:1});matchSnapshot('selftest',{a:1});console.log('ok');require('fs').rmSync('./test/golden/__snapshots__/selftest.json')"
```
Expected: prints `ok` (write then assert-equal passes), then removes the probe snapshot.

- [ ] **Step 3: Commit (stage + hand to user)**

```bash
git add internal-tools/test/golden/snapshot.js
# user commits: "test: add JSON golden snapshot helper (REST side)"
```

---

### Task 1.2: Capture REST route golden snapshots

Snapshots every read-shaped `/api/collab/*` route against a fixed seed. **Normalize volatile fields** (ids, timestamps) so snapshots are deterministic.

**Files:**
- Create: `internal-tools/test/golden/rest.golden.test.js`

- [ ] **Step 1: Write the golden test**

```js
const { test, before, after } = require('node:test');
const { startTestServer, seedEntry } = require('../helpers/server');
const { matchSnapshot } = require('./snapshot');

let srv;

// Replace volatile fields so snapshots are stable across runs/machines.
function stable(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => {
    if (k === 'id' || k === 'entry_id') return '<id>';
    if (k === 'created_at' || k === 'updated_at') return '<ts>';
    if (k === 'tokens_estimate') return '<tok>';
    return v;
  }));
}

before(async () => {
  srv = await startTestServer();
  seedEntry(srv.db, { type: 'decision', category: 'Reference', title: 'Alpha decision', module: 'demo' });
  seedEntry(srv.db, { type: 'changelog', category: 'Activity', title: 'Beta change', module: 'demo' });
  seedEntry(srv.db, { type: 'gotcha', category: 'Reference', title: 'Gamma gotcha', module: 'other' });
});
after(() => srv.close());

const get = async (p) => stable(await (await fetch(srv.baseUrl + p)).json());

test('golden: search all', async () => {
  matchSnapshot('rest_search_all', await get('/api/collab/search'));
});
test('golden: search by module', async () => {
  matchSnapshot('rest_search_module_demo', await get('/api/collab/search?module=demo'));
});
test('golden: search by category', async () => {
  matchSnapshot('rest_search_category_reference', await get('/api/collab/search?category=Reference'));
});
test('golden: stats', async () => {
  matchSnapshot('rest_stats', await get('/api/collab/stats'));
});
test('golden: modules', async () => {
  matchSnapshot('rest_modules', await get('/api/collab/modules'));
});
test('golden: module-card demo', async () => {
  matchSnapshot('rest_module_card_demo', await get('/api/collab/module-card?slug=demo'));
});
test('golden: doctor', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/doctor', { method: 'POST' });
  matchSnapshot('rest_doctor', stable(await res.json()));
});
```

- [ ] **Step 2: Record the snapshots (first run writes them)**

Run:
```bash
cd internal-tools
node --test test/golden/rest.golden.test.js
```
Expected: PASS; `test/golden/__snapshots__/rest_*.json` files are created.

- [ ] **Step 3: Re-run to prove they assert (determinism check)**

Run:
```bash
cd internal-tools
node --test test/golden/rest.golden.test.js
```
Expected: PASS again with snapshots now compared (not rewritten). If any test fails on this second run, a field is still volatile — add it to `stable()`.

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/test/golden/rest.golden.test.js internal-tools/test/golden/__snapshots__/
# user commits: "test: REST golden snapshots for /api/collab/* (behaviour lock)"
```

---

### Task 1.3: MCP/core golden snapshot helper + deterministic seeder

The MCP tools are ESM/TS, so this side runs under `tsx`, under `mcp/`.

**Files:**
- Create: `internal-tools/mcp/test/golden/snapshot.ts`
- Create: `internal-tools/mcp/test/golden/seed.ts`
- Modify: `internal-tools/mcp/package.json` (add `test:golden` script)

- [ ] **Step 1: Write the ESM snapshot helper** (`mcp/test/golden/snapshot.ts`)

```ts
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__snapshots__');

export function matchSnapshot(name: string, value: unknown): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.json`);
  const actual = JSON.stringify(value, null, 2);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.strictEqual(actual, expected, `golden mismatch for ${name}`);
}

// Replace volatile fields so snapshots are stable.
export function stable<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (k, v) =>
      k === 'id' || k === 'entry_id' ? '<id>'
      : k === 'created_at' || k === 'updated_at' ? '<ts>'
      : k === 'tokens_estimate' ? '<tok>'
      : v),
  );
}
```

- [ ] **Step 2: Write the deterministic seeder** (`mcp/test/golden/seed.ts`) — builds a fresh temp DB and returns a handle.

```ts
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, migrate, closeDb } from '../../src/db.js';
import { addEntry } from '../../src/tools/add.js';

export function freshDb() {
  const tmp = path.join(os.tmpdir(), `collab-golden-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmp;
  const db = getDb(tmp);
  migrate(db);
  addEntry(db, { type: 'decision', title: 'Alpha decision', summary: 'a', description: 'd', agent: 'Claude', module: 'demo' });
  addEntry(db, { type: 'changelog', title: 'Beta change', summary: 'b', description: 'd', agent: 'Claude', module: 'demo' });
  addEntry(db, { type: 'gotcha', title: 'Gamma gotcha', summary: 'g', description: 'd', agent: 'Claude', module: 'other' });
  return { db, tmp, close: () => { closeDb(); } };
}
```

> Verify `getDb`'s signature accepts an explicit path; `core/db.js` does (`getDb(dbPath = DEFAULT_DB_PATH)`). Confirm `mcp/src/db.ts` matches before relying on it — if `getDb` there takes no arg, set `process.env.COLLAB_DB_PATH` before the first `getDb()` call instead (the env is already set above, so dropping the arg is safe).

- [ ] **Step 3: Add the `test:golden` script to `mcp/package.json`**

In `mcp/package.json` `"scripts"`, add:

```json
    "test:golden": "tsx --test test/golden/*.test.ts",
```

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/mcp/test/golden/snapshot.ts internal-tools/mcp/test/golden/seed.ts internal-tools/mcp/package.json
# user commits: "test(mcp): golden snapshot helper + deterministic seeder"
```

---

### Task 1.4: Capture MCP tool golden snapshots

**Files:**
- Create: `internal-tools/mcp/test/golden/tools.golden.test.ts`

- [ ] **Step 1: Write the golden test** — imports the pure tool functions and snapshots their output.

```ts
import { test, after } from 'node:test';
import { matchSnapshot, stable } from './snapshot.js';
import { freshDb } from './seed.js';
import { searchEntries } from '../../src/tools/search.js';
import { getEntry } from '../../src/tools/get.js';
import { listRecent } from '../../src/tools/list-recent.js';
import { getModule } from '../../src/tools/module.js';
import { doctor } from '../../src/tools/doctor.js';

const h = freshDb();
after(() => h.close());

test('golden: searchEntries all', () => {
  matchSnapshot('mcp_search_all', stable(searchEntries(h.db, { q: '' })));
});
test('golden: searchEntries module demo', () => {
  matchSnapshot('mcp_search_module_demo', stable(searchEntries(h.db, { q: '', module: 'demo' })));
});
test('golden: listRecent', () => {
  matchSnapshot('mcp_list_recent', stable(listRecent(h.db, { kind: 'any' })));
});
test('golden: getEntry first row', () => {
  const first = (searchEntries(h.db, { q: '' }) as any).results?.[0]?.id ?? 1;
  matchSnapshot('mcp_get_entry', stable(getEntry(h.db, first)));
});
test('golden: getModule demo', () => {
  matchSnapshot('mcp_module_demo', stable(getModule(h.db, 'demo')));
});
test('golden: doctor', () => {
  matchSnapshot('mcp_doctor', stable(doctor(h.db)));
});
```

> The exact arg/return shapes (`searchEntries` filter keys, whether it returns `{results}` or an array) must match the real signatures in `mcp/src/tools/*.ts`. Before running, open each imported file and confirm the call matches; adjust the call sites here to the real signatures (this is reading, not guessing — the files are short).

- [ ] **Step 2: Record the snapshots**

Run:
```bash
cd internal-tools/mcp
npm run test:golden
```
Expected: PASS; `mcp/test/golden/__snapshots__/mcp_*.json` created.

- [ ] **Step 3: Re-run for determinism**

Run:
```bash
cd internal-tools/mcp
npm run test:golden
```
Expected: PASS with snapshots compared. Any failure = a volatile field to add to `stable()`.

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/mcp/test/golden/tools.golden.test.ts internal-tools/mcp/test/golden/__snapshots__/
# user commits: "test(mcp): tool-function golden snapshots (behaviour lock)"
```

---

## Phase 0–1 Done — Checkpoint

At this point you have: a workspace with shared TS/lint/format config, hardened hygiene, and a frozen behavioural baseline for both transports. **This is a committable, independently valuable stopping point.** Phases 2–5 (extract `core`, rewire `mcp/`, rewire `server/`, Track C) get their own plans, each gated by re-running:

```bash
cd internal-tools && node --test test/golden/rest.golden.test.js && cd mcp && npm run test:golden
```
A green run after a later phase is the proof that no behaviour changed.
