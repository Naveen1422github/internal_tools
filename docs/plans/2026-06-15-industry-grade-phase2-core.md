# internal-tools Industry-Grade — Phase 2: Extract `core` + rewire MCP adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Project commit policy:** Agents do NOT `git commit`. "Commit" steps mean `git add` + hand to the user. Agents MAY run the verify commands (`tsc`, `node --test`, `tsx --test`, `npm run build`).
>
> **GATE:** After every task that touches logic, the MCP golden suite must stay **byte-identical**. Run: `cd internal-tools/mcp && npm run test:golden`. A diff = a regression; fix before continuing. To intentionally inspect a diff, never `UPDATE_GOLDEN=1` in this phase — the whole point is that nothing changes.

**Goal:** Move the canonical domain logic out of `mcp/src` into a standalone `@emp1st/core` TypeScript package, and make `mcp/` a thin adapter that imports it — with zero behaviour change, proven by the golden baseline from Phase 1.

**Architecture:** `mcp/src/db.ts` → `core/src/db.ts`; `mcp/src/tools/*` → `core/src/ops/*` (internal sibling imports unchanged). `core/src/index.ts` is the public barrel. `mcp/` (and later `server/`) depend on `@emp1st/core` as a workspace package and import compiled `dist`. The DB schema/migrations are untouched.

**Tech Stack:** npm workspaces, TypeScript 5.3 (ESM), tsx, better-sqlite3, `node --test`.

**Spec:** `internal-tools/docs/2026-06-15-internal-tools-industry-grade-design.md` · **Builds on:** `2026-06-15-industry-grade-phase0-1.md`

---

## Decisions locked for this phase
- **Package name:** `@emp1st/core` (matches existing `@emp1st/collab-mcp` scope).
- **Folder rename:** `tools/` → `ops/` (clearer; safe because sibling imports are unaffected by the parent folder name).
- **Resolution strategy:** `core` **builds to `dist/`**; consumers import the compiled output (`main: dist/index.js`, `types: dist/index.d.ts`). The root `build` script builds `core` first. This avoids TS-source-in-`node_modules` resolution pitfalls and keeps `tsc` happy for `mcp`.
- **Migrations stay in `mcp/migrations/`** for now (referenced by path). `core/src/db.ts` keeps pointing at `../../mcp/migrations` until Phase 4 optionally relocates them. (Out of scope here.)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `core/package.json` | create | `@emp1st/core`, ESM, `tsc` build, owns `better-sqlite3` dep |
| `core/tsconfig.json` | create | extends `../tsconfig.base.json`, `outDir: dist` |
| `core/src/db.ts` | move from `mcp/src/db.ts` | connection + migrate + estimateTokens |
| `core/src/ops/*.ts` | move from `mcp/src/tools/*.ts` | all domain operations (sibling imports unchanged) |
| `core/src/index.ts` | create | public barrel re-exporting db + every op |
| `mcp/package.json` | modify | depend on `@emp1st/core`; drop moved deps if unused |
| `mcp/src/server.ts` | modify | import from `@emp1st/core` instead of `./db.js` / `./tools/*` |
| `mcp/src/scripts/*.ts` | modify | repoint imports to `@emp1st/core` |
| `mcp/test/golden/{seed,tools.golden.test}.ts` | modify | repoint imports to `@emp1st/core` (snapshots unchanged) |
| `package.json` (root) | modify | `build` builds `core` first |
| `core/db.js`, `core/constants.js` | leave for now | still used by `server/` (JS) until Phase 4; not touched here |

> Note: the old JS `core/db.js` + `core/constants.js` coexist with the new `core/src/*.ts` during this phase. They are the *server's* current modules and are removed in Phase 4 when `server/` moves to `@emp1st/core`. Keeping them avoids breaking the REST server now.

---

## Task 1: Scaffold the `core` package

**Files:**
- Create: `internal-tools/core/package.json`
- Create: `internal-tools/core/tsconfig.json`

- [ ] **Step 1: Create `core/package.json`**

```json
{
  "name": "@emp1st/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Domain core for internal-tools: db + collab operations, transport-agnostic.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0"
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

- [ ] **Step 2: Create `core/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Install so the workspace link is created**

Run:
```bash
cd internal-tools
npm install
```
Expected: `@emp1st/core` is symlinked into `node_modules/@emp1st/core`. No build yet (no `src` files) — that's fine.

- [ ] **Step 4: Commit (stage + hand to user)**

```bash
git add internal-tools/core/package.json internal-tools/core/tsconfig.json internal-tools/package-lock.json
# user commits: "build(core): scaffold @emp1st/core package"
```

---

## Task 2: Move `db.ts` and `tools/` into `core/src`

This is a pure relocation. Use `git mv` so history follows.

**Files:**
- Move: `mcp/src/db.ts` → `core/src/db.ts`
- Move: `mcp/src/tools/*.ts` → `core/src/ops/*.ts`

- [ ] **Step 1: Move the files**

Run:
```bash
cd internal-tools
mkdir -p core/src/ops
git mv mcp/src/db.ts core/src/db.ts
git mv mcp/src/tools core/src/ops
```
Expected: `core/src/db.ts` and `core/src/ops/*.ts` exist; `mcp/src/tools/` is gone.

- [ ] **Step 2: Verify internal imports are intact**

The ops import each other by sibling path (`./add.js`) and the db by `../db.js`. After the move, `core/src/ops/*` → `../db.js` resolves to `core/src/db.ts` — identical relative shape. Confirm nothing references the old layout:

Run:
```bash
cd internal-tools
grep -rn "tools/" core/src/ops || echo "no stale tools/ refs (good)"
grep -rn "from \"\.\./db" core/src/ops | head
```
Expected: no `tools/` references; the `../db.js` imports are present and unchanged.

- [ ] **Step 3: Create the public barrel `core/src/index.ts`**

```ts
// Public surface of @emp1st/core. Transport adapters import from here.
export * from './db.js';
export * from './ops/search.js';
export * from './ops/get.js';
export * from './ops/list-recent.js';
export * from './ops/add.js';
export * from './ops/update.js';
export * from './ops/supersede.js';
export * from './ops/module.js';
export * from './ops/doctor.js';
export * from './ops/task.js';
export * from './ops/rollup.js';
export * from './ops/ingest.js';
export * from './ops/export.js';
export * from './ops/savings.js';
```

> If two ops export a colliding name, `tsc` (Step 4) will error with `TS2308`. Resolve by re-exporting explicitly from the owning module (e.g. `export { searchEntries, type SearchArgs } from './ops/search.js';`) rather than `export *`. Fix only the colliding lines.

- [ ] **Step 4: Build `core` standalone**

Run:
```bash
cd internal-tools/core
npm run build
```
Expected: `core/dist/index.js` + `.d.ts` emitted, no TS errors. If `TS2308` (re-export conflict) appears, apply the Step 3 note and rebuild.

- [ ] **Step 5: Commit (stage + hand to user)**

```bash
cd internal-tools
git add core/src core/dist 2>/dev/null; git add core/src
# (dist is gitignored; only src is staged)
# user commits: "refactor(core): relocate db + ops from mcp/src into @emp1st/core"
```

---

## Task 3: Repoint `mcp/` at `@emp1st/core`

`mcp/src` no longer has `db.ts` or `tools/`. Update its imports to the package.

**Files:**
- Modify: `mcp/package.json` (add dep)
- Modify: `mcp/src/server.ts`
- Modify: `mcp/src/scripts/*.ts` (those that imported `../db.js` or `../tools/*`)
- Modify: `mcp/src/migrate.ts` (imported `./db.js`)

- [ ] **Step 1: Add the dependency to `mcp/package.json`**

In `mcp/package.json` `"dependencies"`, add:

```json
    "@emp1st/core": "*",
```

- [ ] **Step 2: Repoint `mcp/src/server.ts` imports**

Replace the block of tool/db imports near the top:

```ts
import { getDb, migrate } from "./db.js";
import { searchEntries } from "./tools/search.js";
import { addEntry } from "./tools/add.js";
import { updateEntry } from "./tools/update.js";
import { getEntry } from "./tools/get.js";
import { listRecent } from "./tools/list-recent.js";
import {
  createTask, transitionTask, assignTask, getTask,
  type TaskStatus, type Priority,
} from "./tools/task.js";
import { initModule, getModule } from "./tools/module.js";
import { ingestDraft } from "./tools/ingest.js";
import { rollup, archive } from "./tools/rollup.js";
import { supersede } from "./tools/supersede.js";
import { exportEntries } from "./tools/export.js";
import { doctor } from "./tools/doctor.js";
import { savingsReport, formatSavingsReport } from "./tools/savings.js";
```

with a single import from the package:

```ts
import {
  getDb, migrate,
  searchEntries, addEntry, updateEntry, getEntry, listRecent,
  createTask, transitionTask, assignTask, getTask, type TaskStatus, type Priority,
  initModule, getModule, ingestDraft, rollup, archive, supersede,
  exportEntries, doctor, savingsReport, formatSavingsReport,
} from "@emp1st/core";
```

> If any name above isn't exported by the barrel, `tsc` will flag it — add the missing `export` to `core/src/index.ts` and rebuild core.

- [ ] **Step 3: Repoint the scripts and `migrate.ts`**

Run to find every stale import:
```bash
cd internal-tools
grep -rn "from \"\.\./db\|from \"\./db\|tools/" mcp/src/scripts mcp/src/migrate.ts
```
For each hit, change the source to `@emp1st/core`. Example — `mcp/src/migrate.ts`:

```ts
// before: import { getDb, migrate } from "./db.js";
import { getDb, migrate } from "@emp1st/core";
```
Apply the same substitution to each script the grep reports (`scripts/seed.ts`, `scripts/module-card.ts`, `scripts/manual-search.ts`, `scripts/check-handoff-needed.ts`, `scripts/parse-codex-output.ts`, `scripts/add-log.ts` — whichever appear).

- [ ] **Step 4: Build mcp (proves the rewire type-checks)**

Run:
```bash
cd internal-tools
npm -w @emp1st/core run build   # ensure core dist is current
npm -w @emp1st/collab-mcp run build
```
Expected: both compile with no errors.

- [ ] **Step 5: Commit (stage + hand to user)**

```bash
cd internal-tools
git add mcp/package.json mcp/src package-lock.json
# user commits: "refactor(mcp): import domain logic from @emp1st/core (thin adapter)"
```

---

## Task 4: Repoint the MCP golden tests and prove byte-identical

The golden tests still import `../../src/db.js` and `../../src/tools/*` — now moved. Update them to `@emp1st/core`. **Snapshots must not change.**

**Files:**
- Modify: `mcp/test/golden/seed.ts`
- Modify: `mcp/test/golden/tools.golden.test.ts`

- [ ] **Step 1: Repoint `seed.ts` imports**

```ts
// before:
//   import { getDb, migrate, closeDb } from '../../src/db.js';
//   import { addEntry } from '../../src/tools/add.js';
import { getDb, migrate, closeDb, addEntry } from '@emp1st/core';
```

- [ ] **Step 2: Repoint `tools.golden.test.ts` imports**

Replace the five `../../src/tools/*` imports with one barrel import:

```ts
import {
  searchEntries, type SearchArgs,
  getEntry, listRecent, getModule, doctor,
} from '@emp1st/core';
```
(Keep the `./snapshot.js` and `./seed.js` imports as-is.)

- [ ] **Step 3: Run the golden suite — MUST be byte-identical**

Run:
```bash
cd internal-tools/mcp
npm run test:golden
```
Expected: **PASS with zero snapshot writes** (snapshots already exist from Phase 1; they must match). If any `golden mismatch` appears, the relocation changed behaviour — STOP and diff the offending `__snapshots__/*.json` against git; do not update snapshots.

- [ ] **Step 4: Run the REST golden suite too (server still uses old JS core — must also be unchanged)**

Run:
```bash
cd internal-tools
node --test test/golden/rest.golden.test.js
```
Expected: PASS (this phase didn't touch `server/`, so REST is trivially unchanged — this is a regression tripwire).

- [ ] **Step 5: Commit (stage + hand to user)**

```bash
cd internal-tools
git add mcp/test/golden/seed.ts mcp/test/golden/tools.golden.test.ts
# user commits: "test(mcp): repoint golden tests at @emp1st/core (snapshots unchanged)"
```

---

## Task 5: Workspace build ordering + full verification

`core` must build before its consumers.

**Files:**
- Modify: `internal-tools/package.json` (root `build` script)

- [ ] **Step 1: Make root `build` build `core` first**

Replace the root `"build"` script:

```json
    "build": "npm -w @emp1st/core run build && npm run build --workspaces --if-present",
```

- [ ] **Step 2: Clean build everything from root**

Run:
```bash
cd internal-tools
npm run build
```
Expected: `core` builds, then `mcp` (and `ui` if present) build, no errors.

- [ ] **Step 3: Full golden gate (both transports)**

Run:
```bash
cd internal-tools && node --test test/golden/rest.golden.test.js && cd mcp && npm run test:golden
```
Expected: both PASS, no snapshot writes.

- [ ] **Step 4: Smoke-test the live MCP server boots**

Run:
```bash
cd internal-tools/mcp
timeout 5 npm run dev || true
```
Expected: server logs its boot lines (it imports `@emp1st/core` at runtime); no module-resolution crash. (It will be killed by `timeout` — that's fine; we're only proving it starts.)

- [ ] **Step 5: Commit (stage + hand to user)**

```bash
cd internal-tools
git add package.json
# user commits: "build: build @emp1st/core before dependent workspaces"
```

---

## Phase 2 Done — Checkpoint

`core` now owns the domain logic; `mcp/` is a thin adapter importing `@emp1st/core`; both golden suites are byte-identical to the Phase 1 baseline. **Committable stopping point.**

Remaining:
- **Phase 3 (next plan):** rewire `server/` to `@emp1st/core` (CJS-JS → ESM-TS), delete `server/tools/collab.js` domain logic + the now-redundant `core/db.js` / `core/constants.js`, `ai.js` uses core validators. REST golden must stay byte-identical.
- **Phase 4 (next plan):** Track C — CI, per-package READMEs, `CONTRIBUTING`, demo seed + clean-room check, `LICENSE` (MIT).

**Dispatch note:** Tasks 2–4 are mechanical (moves + import repointing) — well-suited to agy under Claude review, with the golden gate as the objective pass/fail. Task 1 and the barrel/build-ordering decisions (Tasks 1, 5) are quick Claude-owned setup.
