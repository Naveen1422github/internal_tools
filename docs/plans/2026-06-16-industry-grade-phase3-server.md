# internal-tools Industry-Grade — Phase 3: Server → ESM-TS adapter on @emp1st/core (Option B)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.
>
> **Project commit policy:** Agents do NOT `git commit`. "Commit" = `git add` + hand to user. Agents MAY run `tsc`, `node --test`, `tsx --test`, `npm run build`.
>
> **GATE:** The REST golden suite must stay **byte-identical** to the Phase 1 baseline after every task. The MCP golden must also stay green. NEVER `UPDATE_GOLDEN` in this phase. A snapshot diff = regression → stop.

**Goal:** Convert `server/` from CommonJS-JS to ESM-TypeScript, importing `@emp1st/core` for shared primitives (db, constants, validation), while keeping every REST response **byte-identical** and the `ui/` untouched. Remove the `.cjs` bridge. Migrate the REST test harness to ESM (forced by the server going ESM).

**Architecture (Option B — decision #188):** `core` owns shared *logic* (db access, `KIND_BY_TYPE`/`CATEGORY_BY_TYPE`/`SLUG_REGEX`, entry validation). The server adapter keeps its **own REST DTOs** (the `search`/`module-card`/etc. shapes the UI depends on) — it just stops re-implementing the *logic*. REST and MCP remain deliberately different contracts.

**Tech Stack:** npm workspaces, TypeScript 5.3 (ESM), tsx, better-sqlite3, `node --test`/`tsx --test`.

**Spec:** `docs/2026-06-15-internal-tools-industry-grade-design.md` · **Decision:** collab #188 · **Builds on:** Phase 2 (`2026-06-15-industry-grade-phase2-core.md`)

---

## Why this phase is shaped this way
- REST `runSearch` and core `searchEntries` return **different shapes** (REST has `module`/`agent`/`snippet`; core has `score`/`auto_expanded`/`filters_applied`). The UI reads the REST shape. So the server keeps its own search/DTO code — only its *validation + constants + db* come from core.
- The server going ESM **breaks the CJS test harness** (`test/helpers/server.js` `require()`s `server.js`). The harness must move to ESM/tsx in this same phase (Task 6), or the REST golden can't run.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `core/src/constants.ts` | create | Single home for `EntryType`/`Category`/`Agent` + `KIND_BY_TYPE`/`CATEGORY_BY_TYPE`/`SLUG_REGEX` |
| `core/src/ops/add.ts` | modify | Import constants from `../constants.js` instead of defining them inline |
| `core/src/validate.ts` | create | `validateEntryInput()` — the shared entry-validation rules |
| `core/src/index.ts` | modify | Export constants + validate |
| `server/package.json` | create | `@emp1st/server`, ESM, `dev:tsx`, `build:tsc`, deps `@emp1st/core` + `dotenv` |
| `server/tsconfig.json` | create | extends `../tsconfig.base.json`, `outDir dist` |
| `server/src/server.ts` | move+convert | from `server/server.js` (ESM-TS) |
| `server/src/tools/collab.ts` | move+convert | from `server/tools/collab.js` — SQL/DTOs identical; logic from core |
| `server/src/tools/ai.ts` | move+convert | from `server/tools/ai.js` — uses core constants/validation/search |
| `core/db.cjs`, `core/constants.cjs` | delete | bridge no longer needed |
| `test/helpers/server.mjs` | move+convert | ESM harness using dynamic `import()` |
| `test/golden/rest.golden.test.mjs` | move+convert | ESM; run via `tsx --test` |
| `package.json` (root) | modify | `start`/`dev`/`test` point at the server workspace + ESM tests |

---

## Task 1: Consolidate constants into `core/src/constants.ts` (dedup #1)

The enums live inline in `core/src/ops/add.ts` AND are duplicated in `core/constants.cjs`. One home.

**Files:**
- Create: `core/src/constants.ts`
- Modify: `core/src/ops/add.ts`

- [ ] **Step 1: Create `core/src/constants.ts`** (copy the exact definitions currently in `ops/add.ts`)

```ts
export type EntryType =
  | 'handoff' | 'review' | 'proposal' | 'counter' | 'decision'
  | 'gotcha' | 'rollup' | 'session-note' | 'changelog';
export type Agent = 'Claude' | 'Codex' | 'Gemini' | 'User';
export type RefType = 'file' | 'task' | 'entry' | 'url';
export type Category = 'Index' | 'Reference' | 'Activity';

export const KIND_BY_TYPE: Record<EntryType, 'signal' | 'log'> = {
  handoff: 'signal', review: 'signal', proposal: 'signal', counter: 'signal',
  decision: 'signal', gotcha: 'signal', rollup: 'signal',
  'session-note': 'log', changelog: 'log',
};
export const CATEGORY_BY_TYPE: Record<EntryType, Category> = {
  handoff: 'Activity', review: 'Activity', proposal: 'Activity', counter: 'Activity',
  decision: 'Reference', gotcha: 'Reference', rollup: 'Activity',
  'session-note': 'Activity', changelog: 'Activity',
};
// Mirror of the regex enforced in module.ts / the old core/constants.cjs.
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;
```

> Verify the `SLUG_REGEX` matches the one in the current `core/constants.cjs` exactly (open it and compare) before deleting that file in Task 5.

- [ ] **Step 2: Make `ops/add.ts` import the constants instead of defining them**

In `core/src/ops/add.ts`, delete the inline `EntryType`/`Agent`/`RefType`/`Category` type aliases and the `KIND_BY_TYPE`/`CATEGORY_BY_TYPE` consts, and add at the top:

```ts
import { type EntryType, type Agent, type RefType, type Category, KIND_BY_TYPE, CATEGORY_BY_TYPE } from '../constants.js';
```
Keep `AddEntryArgs`, `RefInput`, and `addEntry` as-is. (Other ops that did `import type { EntryType } from './add.js'` still work because `add.ts` re-exports nothing new — but if `tsc` reports a missing export, change those imports to `from '../constants.js'`.)

- [ ] **Step 3: Export constants from the barrel** — in `core/src/index.ts` add:

```ts
export * from './constants.js';
```

- [ ] **Step 4: Build core + run MCP golden (gate)**

```bash
cd internal-tools && npm -w @emp1st/core run build && cd mcp && npm run test:golden
```
Expected: core compiles; MCP golden 7/7 byte-identical (constants move is behaviour-neutral).

- [ ] **Step 5: Commit** — `git add core/src/constants.ts core/src/ops/add.ts core/src/index.ts` → user commits `"refactor(core): single constants module"`.

---

## Task 2: Extract shared validation into `core/src/validate.ts` (dedup #2)

The entry-input rules are currently written three times (server `collab.js` upsert, `ai.js`, core `add.ts`). Centralize the *validation* (not the persistence).

**Files:**
- Create: `core/src/validate.ts`
- Test: `core/test/validate.test.ts`

- [ ] **Step 1: Write the failing test** (`core/test/validate.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { validateEntryInput } from '../src/validate.js';

test('rejects unknown type', () => {
  const r = validateEntryInput({ type: 'nope', title: 't', summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /invalid type/);
});
test('rejects rollup', () => {
  assert.equal(validateEntryInput({ type: 'rollup', title: 't', summary: 's' }).ok, false);
});
test('rejects summary > 200', () => {
  const r = validateEntryInput({ type: 'decision', title: 't', summary: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /summary exceeds 200/);
});
test('accepts a valid entry and resolves category', () => {
  const r = validateEntryInput({ type: 'decision', title: 't', summary: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.category, 'Reference');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd internal-tools/core && npx tsx --test test/validate.test.ts` → fails (module not found).

- [ ] **Step 3: Implement `core/src/validate.ts`** (mirrors the rules in `server/tools/collab.js:163-172`)

```ts
import { KIND_BY_TYPE, CATEGORY_BY_TYPE, type Category } from './constants.js';

export interface EntryInput {
  type: string; title?: string; summary?: string; category?: string;
}
export interface ValidationResult { ok: boolean; errors: string[]; category?: Category; }

export function validateEntryInput(e: EntryInput): ValidationResult {
  const errors: string[] = [];
  if (!e.type || !(e.type in KIND_BY_TYPE)) errors.push(`invalid type: ${e.type}`);
  else if (e.type === 'rollup') errors.push('rollup entries are system-generated; use collab.rollup');
  if (!e.title || !e.title.trim()) errors.push('title is required');
  if (!e.summary || !e.summary.trim()) errors.push('summary is required');
  else if (e.summary.length > 200) errors.push(`summary exceeds 200 chars (got ${e.summary.length})`);
  const category = (e.category || (e.type in CATEGORY_BY_TYPE ? CATEGORY_BY_TYPE[e.type as keyof typeof CATEGORY_BY_TYPE] : undefined)) as Category | undefined;
  if (!category || !['Index', 'Reference', 'Activity'].includes(category)) errors.push(`invalid category: ${category}`);
  return { ok: errors.length === 0, errors, category: category ?? undefined };
}
```

- [ ] **Step 4: Run test, expect PASS** — `cd internal-tools/core && npx tsx --test test/validate.test.ts` → 4/4.

- [ ] **Step 5: Export from barrel** — add `export * from './validate.js';` to `core/src/index.ts`, then `npm -w @emp1st/core run build`.

- [ ] **Step 6: Commit** — `git add core/src/validate.ts core/test/validate.test.ts core/src/index.ts` → `"feat(core): shared validateEntryInput"`.

---

## Task 3: Make `server/` an ESM-TS workspace package

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`

- [ ] **Step 1: Create `server/package.json`** (mirrors `mcp/`'s shape)

```json
{
  "name": "@emp1st/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "HTTP REST adapter + static host for the internal-tools UI.",
  "scripts": {
    "dev": "tsx src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@emp1st/core": "*",
    "better-sqlite3": "^11.3.0",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "~5.3.3"
  },
  "engines": { "node": ">=20.9.0" }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install** — `cd internal-tools && npm install` → `@emp1st/server` linked.

- [ ] **Step 4: Commit** — `git add server/package.json server/tsconfig.json package-lock.json` → `"build(server): make @emp1st/server an ESM-TS workspace"`.

---

## Task 4: Convert the server source to ESM-TS (logic from core, DTOs unchanged)

Move `server/*.js` → `server/src/*.ts`. **Preserve every SQL statement and every response shape exactly.** Only the module syntax and the source of validation/constants change.

**Files:**
- Move+convert: `server/server.js` → `server/src/server.ts`
- Move+convert: `server/tools/collab.js` → `server/src/tools/collab.ts`
- Move+convert: `server/tools/ai.js` → `server/src/tools/ai.ts`

- [ ] **Step 1: Move the files**

```bash
cd internal-tools
mkdir -p server/src/tools
git mv server/server.js server/src/server.ts
git mv server/tools/collab.js server/src/tools/collab.ts
git mv server/tools/ai.js server/src/tools/ai.ts
```

- [ ] **Step 2: Convert `server/src/server.ts`** — apply this exact transform:
  - `const http = require('http')` → `import http from 'node:http';` (same for `fs/promises`→`import fs from 'node:fs/promises'`, `fs`→`import fsSync from 'node:fs'`, `path`→`import path from 'node:path'`).
  - `require('dotenv').config(...)` → `import 'dotenv/config';` (or `import dotenv from 'dotenv'; dotenv.config({...})`).
  - `const { migrate } = require('../core/db.cjs')` → `import { migrate } from '@emp1st/core';`
  - `const collab = require('./tools/collab')` → `import * as collab from './tools/collab.js';` (same for `ai`).
  - ESM has no `__dirname`: add at top `import { fileURLToPath } from 'node:url'; const __dirname = path.dirname(fileURLToPath(import.meta.url));`
  - `module.exports = { start }` → `export { start };`
  - The `UI_DIST` path was `path.join(__dirname, '..', 'ui', 'dist')` from `server/`; now from `server/src/` it must be `path.join(__dirname, '..', '..', 'ui', 'dist')`. **Update it.** (Same for the `.env` path in dotenv config → `'..','..','.env'`.)
  - Keep all routing/serveStatic/handler logic identical.

- [ ] **Step 3: Convert `server/src/tools/collab.ts`** — apply this transform, preserving ALL SQL and route DTOs:
  - Line 1-2: `require('../../core/db.cjs')` + `require('../../core/constants.cjs')` → `import { getDb, estimateTokens, KIND_BY_TYPE, CATEGORY_BY_TYPE, SLUG_REGEX, validateEntryInput } from '@emp1st/core';`
  - In the `entry/upsert` handler, replace the inline validation block (`if (!type || !KIND_BY_TYPE[type])` … through the category check, lines 163-172) with:
    ```ts
    const v = validateEntryInput({ type, title, summary, category });
    if (!v.ok) return send(400, { error: v.errors[0] });
    const kind = KIND_BY_TYPE[type as keyof typeof KIND_BY_TYPE];
    const resolvedCategory = v.category!;
    ```
  - `module.exports.runSearch = runSearch; module.exports.routes = {...}` → `export { runSearch }; export const routes = {...};`
  - Type the handler params minimally (`req: http.IncomingMessage, res: http.ServerResponse, send: (s: number, b: unknown) => void, body?: any`). Use `any` where the existing JS was untyped — do NOT redesign types in this phase.
  - **Every `db.prepare(...).all/get/run(...)` stays exactly as written.**

- [ ] **Step 4: Convert `server/src/tools/ai.ts`** — `require('../../core/constants.cjs')`/`require('../../core/db.cjs')` → `import { ... } from '@emp1st/core';`. Replace `require('./collab').runSearch` usage with the core search it needs (it used `runSearch` for the AI search tool — keep using the server's `runSearch` via `import { runSearch } from './collab.js';` to preserve identical AI behaviour). `module.exports` → `export`.

- [ ] **Step 5: Build the server** — `cd internal-tools && npm -w @emp1st/core run build && npm -w @emp1st/server run build`. Fix any type errors with minimal `any` annotations (no redesign). Expected: `server/dist/` emitted.

- [ ] **Step 6: Commit** — `git add server/src package*.json` → `"refactor(server): ESM-TS adapter on @emp1st/core, DTOs unchanged"`.

---

## Task 5: Delete the `.cjs` bridge + update root scripts

**Files:**
- Delete: `core/db.cjs`, `core/constants.cjs`
- Modify: root `package.json`

- [ ] **Step 1: Confirm nothing still references the bridge**

```bash
cd internal-tools && grep -rn "core/db.cjs\|core/constants.cjs\|core/db'\|core/constants'" server test --include=*.ts --include=*.js --include=*.mjs || echo "no refs (good)"
```
Expected: no references (Task 4 + Task 6 removed them all). If any remain, fix before deleting.

- [ ] **Step 2: Delete the bridge** — `git rm core/db.cjs core/constants.cjs`.

- [ ] **Step 3: Update root `package.json` scripts** to drive the server workspace:

```json
    "start": "npm -w @emp1st/server run build && node server/dist/server.js",
    "dev": "npm -w @emp1st/server run dev",
```
(Keep `build` as the Phase-2 core-first version; it already builds all workspaces.)

- [ ] **Step 4: Commit** — `git add core package.json` → `"refactor(core): remove .cjs bridge; server runs from dist"`.

---

## Task 6: Migrate the REST golden harness to ESM (forced by the server going ESM)

The CJS harness `require()`s the server, which is now ESM → `ERR_REQUIRE_ESM`. Convert the harness + the golden test to ESM and run via `tsx --test`.

**Files:**
- Move+convert: `test/helpers/server.js` → `test/helpers/server.mjs`
- Move+convert: `test/golden/rest.golden.test.js` → `test/golden/rest.golden.test.mjs`
- Modify: root `package.json` test script (and the other `test/api.*.test.js` — convert or run via tsx)

- [ ] **Step 1: Convert `test/helpers/server.mjs`** — ESM with dynamic import of the built server:

```js
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startTestServer() {
  const tmpFile = path.join(os.tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
  process.env.COLLAB_DB_PATH = tmpFile;
  // dynamic import AFTER env is set so the singleton binds to the temp DB
  const { start } = await import(path.join(__dirname, '..', '..', 'server', 'dist', 'server.js'));
  const { getDb } = await import('@emp1st/core');
  const { server, port } = await start(0, '127.0.0.1');
  const db = getDb();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(() => {
    for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(tmpFile + s); } catch {} }
    resolve();
  }));
  return { baseUrl, db, close };
}

export function seedEntry(db, opts = {}) { /* keep the existing seedEntry body verbatim */ }
```
(Copy the existing `seedEntry` body unchanged.)

- [ ] **Step 2: Convert `test/golden/rest.golden.test.mjs`** — change `require('../helpers/server')` → `import { startTestServer, seedEntry } from '../helpers/server.mjs';` and `require('./snapshot')` → keep `snapshot.js` (CJS) via `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { matchSnapshot } = require('./snapshot.js');` OR convert `snapshot.js` → `snapshot.mjs`. Prefer converting `snapshot.js` → `snapshot.mjs` (`export function matchSnapshot`). The test body (seed + fetch + `stable()` + `matchSnapshot`) is otherwise unchanged.

- [ ] **Step 3: Update root `package.json` test script** — the API tests now need the built server + tsx/ESM:

```json
    "test": "npm -w @emp1st/server run build && tsx --test test/**/*.test.mjs",
```
> The legacy `test/api.*.test.js` files also `require` the old harness. Either convert them to `.mjs` the same way, or (faster) point them at `helpers/server.mjs` via `createRequire`. Convert them — consistency beats a mixed harness.

- [ ] **Step 4: Run the REST golden — GATE (byte-identical)**

```bash
cd internal-tools && npm -w @emp1st/server run build && tsx --test test/golden/rest.golden.test.mjs
```
Expected: 7/7 PASS, zero snapshot writes. The proof: the REST DTOs are unchanged, so the snapshots match. Any diff = a DTO changed during conversion → find and revert it.

- [ ] **Step 5: Commit** — `git add test package.json` → `"test: migrate REST harness + golden to ESM/tsx"`.

---

## Task 7: Full verification

- [ ] **Step 1: Clean build** — `cd internal-tools && npm run build` → core, server, mcp, ui all compile.
- [ ] **Step 2: Both golden suites**

```bash
cd internal-tools && tsx --test test/golden/rest.golden.test.mjs
cd internal-tools/mcp && npm run test:golden
```
Expected: REST 7/7 + MCP 7/7, byte-identical.

- [ ] **Step 3: Smoke-test the server boots from dist**

```bash
cd internal-tools && timeout 5 node server/dist/server.js || true
```
Expected: boot log, no module-resolution error.

- [ ] **Step 4: Smoke-test the UI is still served** — with the server running, `curl -s http://127.0.0.1:7473/api/collab/stats` returns JSON (proves the REST adapter works end-to-end against the real DB).

- [ ] **Step 5: Commit any remaining staged files** → user commits.

---

## Phase 3 Done — Checkpoint

The server is now a thin ESM-TS adapter: it imports `@emp1st/core` for db + constants + validation, keeps its own REST DTOs, and the `.cjs` bridge is gone. Constants and entry-validation exist in exactly one place. REST + MCP golden both byte-identical; `ui/` untouched.

**Remaining:**
- **Phase 4 (next plan):** Track C — GitHub Actions CI (lint/build/test across workspaces), per-package READMEs, `CONTRIBUTING.md`, demo seed + clean-room check (ship schema + migrations + demo seed only), `LICENSE` (MIT). Optionally relocate `mcp/migrations` → `core/` and unpause **Phase 2B (AI panel)**, which can now build on the clean core.

**Dispatch note:** Tasks 1–2 (core constants/validate) and Task 4 (mechanical CJS→ESM transform, SQL preserved) are agy-suited under Claude review, with the golden gate as objective pass/fail. The ESM-cascade bits (Tasks 3, 6 — packaging + harness) are quick Claude-owned setup where resolution details matter.
