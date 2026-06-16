# internal-tools — Industry-Grade Refactor (Design Spec)

**Date:** 2026-06-15 · **Module:** `workspace-redesign` · **Status:** approved design, pending implementation plan
**Scope decision:** Track A+B+C (open-source grade). **Core language decision:** TypeScript (Approach A). **Module system:** ESM (anchored on `mcp/`; see §3.3).

---

## 1. Goal

Bring `internal-tools/` to a quality bar we'd be comfortable open-sourcing, **without changing observable behaviour** of the live Collab MCP. Three tracks:

- **A — Hygiene & tooling:** npm workspaces, shared TS/lint/format config, `.gitignore` hardening, dead-code removal, engines/`.nvmrc`.
- **B — Shared domain core:** eliminate the duplicated domain logic by extracting one TypeScript `core` package that both transports import (ports-and-adapters).
- **C — Open-source readiness:** CI, per-package docs, contribution guide, demo seed + clean-room verification, license.

## 2. Current state & the problem

`internal-tools` is four Node sub-projects sharing one SQLite file (`mcp/collab.db`):

| Project | Lang | Role |
|---|---|---|
| `mcp/` | TS | Collab MCP server (stdio) — the canonical tools, owns schema + migrations |
| `server/` + `core/` | JS | HTTP REST + static host for the UI |
| `ui/` | TS (React/Vite) | Dashboard SPA |
| `gemini-mcp/` | TS | Separate read-side MCP wrapping the `gemini` CLI (out of scope) |

**Core defect:** domain logic is implemented **twice** —
- `server/tools/collab.js` (JS, ~549 LOC): `runSearch`, get, upsert, delete, supersede, reassign-module, stats, doctor, tasks, modules, module-card.
- `mcp/src/tools/*.ts` (TS, ~2,273 LOC): the canonical equivalents (`search`, `add`, `get`, `supersede`, `module`, `doctor`, `update`, `task`, `rollup`, `ingest`, `export`, `savings`, `list-recent`).

There are also **two DB modules** (`core/db.js` and `mcp/src/db.ts`) opening the same file. Two implementations of one behaviour = guaranteed drift (already visible: `runSearch` lives in both, and `ai.js` re-derives validators from `core/constants.js` instead of reusing the MCP validators).

Secondary issues: no monorepo tooling (manual `npm --prefix` scripts), JS/TS split, `server.js` references a deleted `PUBLIC_DIR`, `.gitignore` not hardened against agent exhaust (`*.log`, `*.stackdump`).

## 3. Target architecture — ports & adapters

One typed domain core; the two servers become thin transport adapters that translate protocol ⇄ core calls and own nothing but wiring.

```
            ┌───────────────────────────────────────────────┐
            │  core/  (TypeScript domain package)            │
            │  • db: connection + migrations (single owner)  │
            │  • constants/validation (enums, slug, limits)  │
            │  • operations: search, get, listRecent, add/   │
            │    upsert, update, supersede, reassignModule,  │
            │    module, moduleCard, doctor, stats, rollup,  │
            │    ingest, export, savings, task.*             │
            │  Pure functions: (db, params) -> result.       │
            │  No HTTP, no MCP, no process concerns.          │
            └───────────────┬───────────────────┬────────────┘
              imports core   │                   │  imports core
            ┌────────────────▼─────┐   ┌─────────▼──────────────┐
            │ mcp/  (MCP adapter)  │   │ server/ (HTTP adapter) │
            │ registers MCP tools; │   │ routes map REST ⇄ core;│
            │ each tool = validate │   │ each handler = parse → │
            │ args → core fn → MCP │   │ core fn → JSON. Static │
            │ result shape.        │   │ host for ui/dist.      │
            └──────────────────────┘   └────────────────────────┘
                       │                          │
                       └──────────  ui/  ─────────┘ (unchanged; talks REST)
```

**Why:** each unit has one purpose and a defined interface. `core` is testable without a server; adapters are testable as thin mappers; behaviour can't drift because there's one implementation.

### 3.1 `core` package shape (proposed)

```
core/
  package.json            # name: @internal-tools/core, type: module, tsc build
  tsconfig.json           # extends repo base
  src/
    db.ts                 # getDb / closeDb / migrate / estimateTokens (replaces core/db.js + mcp/src/db.ts)
    constants.ts          # KIND_BY_TYPE, CATEGORY_BY_TYPE, SLUG_REGEX, limits (replaces core/constants.js)
    validate.ts           # entry/task validators (single source; ai.js + add both use this)
    ops/
      search.ts get.ts list-recent.ts add.ts update.ts
      supersede.ts module.ts doctor.ts stats.ts rollup.ts
      ingest.ts export.ts savings.ts task.ts
    index.ts              # public surface
  test/                   # unit tests per op (node:test)
```

Each op is a pure function `(db, params) => result`. The MCP tool files and REST handlers call these; they no longer contain SQL.

### 3.2 Adapters after refactor
- **mcp/src/tools/*.ts** shrink to: arg schema (zod/existing) → `core.<op>()` → MCP content shape. No SQL.
- **server/tools/collab.js** → **collab.ts** (now TS): route table → `core.<op>()` → JSON. `runSearch` deleted (uses `core.search`). `ai.js` imports `core.validate` + `core.search`.

> **Note — core extraction is mostly relocation, not rewrite.** The `mcp/src/tools/*.ts` functions are already pure `(db, params) => result` exports (e.g. `getEntry(db, id)`, `searchEntries(db, …)`), and `mcp/src/db.ts` is already the typed connection module. So Phase 2 = move `mcp/src/db.ts` + `mcp/src/tools/*` into `core/src/` and generalize; Phase 3 = point `mcp/src/server.ts` imports at `core` instead of `./tools`. The genuine rewrite is concentrated in **Phase 4** (`server/` CJS-JS → ESM-TS adapter). This lowers risk on Phases 2–3.

### 3.3 Module system (resolved)

The backend triad unifies on **ESM + TypeScript**, anchored on the canonical `mcp/`:

| Project | Today | After |
|---|---|---|
| `mcp/` | ESM TS (`type: module`, `module: ESNext`, `moduleResolution: bundler`) | unchanged — the anchor |
| `core/` | CJS JS (`db.js`, `constants.js`) | **→ ESM TS**, matches `mcp/` tsconfig |
| `server/` | CJS JS (`require`/`module.exports`) | **→ ESM TS**, `tsc` build, imports compiled `core` |
| `ui/`, `gemini-mcp/` | ESM | unchanged |

No CJS↔ESM interop layer is needed — all backend packages emit ESM, so `import` works natively across `core` → `mcp`/`server`. `core/package.json` is `type: module`; `server/` gets `type: module` + a `build` (tsc → `dist`) step and runs the compiled output. Tests run via `node --test` with `tsx`/compiled output (decided in Phase 0 tooling).

## 4. Monorepo (Track A)

**npm workspaces, light.** Keep current top-level dirs as workspaces — **no `packages/` move** (avoids rewriting `.mcp.json` and import paths). Root `package.json`:

```jsonc
{
  "workspaces": ["core", "mcp", "server", "ui", "gemini-mcp"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test":  "npm run test  --workspaces --if-present",
    "lint":  "eslint .",
    "dev":   "..."   // unchanged dev entry
  }
}
```

`server/` gains a `build` (tsc) step since it becomes TS and imports compiled `core`. Shared baseline: root `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.nvmrc` (Node 20), `engines` field. Hardened `.gitignore`: `*.log`, `*.stackdump`, `**/.npm-cache/`, `*.tsbuildinfo` (already), build dirs.

`gemini-mcp/` is included as a workspace for unified install/lint only — its internals are **out of scope**.

## 5. Safety rail — behaviour must not change (non-negotiable)

The `mcp__collab__*` tools and `/api/collab/*` routes are **live and in active use**. The refactor is a pure internal reshaping.

1. **Characterization tests first.** Before moving any logic, capture current outputs as golden tests against a **seeded temp DB**, all **in-process** (no stdio, no live server):
   - **REST side:** extend the existing in-process harness `test/helpers/server.js` — drive each `/api/collab/*` route and snapshot the JSON.
   - **MCP/core side:** import the tool functions directly (`getEntry`, `searchEntries`, `addEntry`, `supersede`, `doctor`, …) and call them against the seeded DB — they are already pure `(db, params) => result`, so no MCP transport is involved. Snapshot each result.
   - Snapshots live in `test/golden/`; the same snapshots are re-asserted after Phases 3 and 4, so a single corpus guards both adapters. (Phase 1 below.)
2. **Green after every step.** Golden + existing `test/` suites must pass after each phase; a diff = a regression to fix before proceeding.
3. **DB schema untouched.** No migration changes in this refactor. `collab.db` data and `mcp/migrations/*.sql` are unchanged; only the *code* that reads them moves.
4. **One DB owner.** `core/src/db.ts` becomes the sole connection module; `core/db.js` and `mcp/src/db.ts` are deleted after both adapters point at core.

## 6. Track C — open-source readiness

- **CI:** GitHub Actions — `install → lint → build → test` across workspaces on PR.
- **Docs:** refresh root `README`, per-package `README` (core/mcp/server/ui/gemini-mcp), `DESIGN.md` updated to ports-and-adapters, `CONTRIBUTING.md`.
- **Clean-room:** demo seed DB (`seed` script already exists in `mcp/`) + a check that ships only schema + migrations + demo seed — never the populated `collab.db` or git history (per clean-room gate §5).
- **License:** add an OSS `LICENSE` (user picks; default MIT).

## 7. Phasing (each phase independently shippable; later phases dispatchable to agy under review)

| Phase | Work | Risk | Owner |
|---|---|---|---|
| **0** | Tooling foundation: workspaces, base tsconfig/eslint/prettier, `.nvmrc`/engines, `.gitignore` harden, remove dead `PUBLIC_DIR`. No logic moves. | Very low | Claude/agy |
| **1** | Characterization tests: golden snapshots of all MCP tools + REST routes against a seeded temp DB. | Low | Claude (design) + agy (fill) |
| **2** | Build `core` TS package: move db + constants + validators + each op, unit-tested. Nothing imports it yet. | Medium | Claude (API/db/validate) + agy (op bodies) |
| **3** | Rewire `mcp/` adapter to call `core`; delete duplicated SQL from `mcp/src/tools/*`. Golden green. | Medium (contracts) | Claude review-heavy |
| **4** | Rewire `server/` adapter (→ TS) to import `core`; delete `server/tools/collab.js` logic; `ai.js` uses core. REST + golden green. | Medium | Claude + agy |
| **5** | Track C: CI, docs, license, seed/clean-room. | Low | agy + Claude review |

**Division of labor** (per collab model): Claude owns the `core` public API, the db/validation modules, the contract-sensitive adapter rewires (Phases 2–4 design + review). agy executes mechanical moves and test scaffolding under Claude review. No agent commits — user is integration gatekeeper.

## 8. Out of scope
- `gemini-mcp/` internals (separate concern; workspace membership only).
- Any schema/migration change.
- New features (Phase 2B AI panel is **paused** until this lands — building it on the pre-refactor code is the thing we're explicitly avoiding).
- `packages/` directory restructure (deferred; light workspaces chosen).

## 9. Risks & mitigations
- **Contract drift during rewire** → characterization tests (Phase 1) gate every later phase.
- **`server/` build step is new** → introduced in Phase 0 tooling before logic moves; dev flow documented in README.
- **Concurrent agent work re-introducing mess** → no parallel feature dispatch until refactor lands; hardened `.gitignore` stops exhaust.
- **Effort:** ~20–30h across phases; Phases 0–1 are quick wins (~4–6h) that de-risk the rest.
