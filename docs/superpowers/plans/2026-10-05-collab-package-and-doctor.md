# Collab easy setup, piece 1: package + notebook home + `collab doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** collab installs as one prebuilt package with one `collab` command, notebooks live in a per-user data folder with a clear rule for which one a project uses, and `collab doctor` explains every setup problem in plain words with the exact fix.

**Architecture:** Everything new that the MCP, web server and CLI share lives in `@collab-mcp/core` (notebook registry, notebook choice, settings, build identity, heartbeats, add-on check, setup doctor). A new `cli/` workspace provides the `collab` command and routes subcommands to the existing courier, post-office, MCP and web server code. A packaging script assembles one installable folder from the built workspaces; an "install root" marker file lets code find migrations, the add-on and the UI no matter where it is installed.

**Tech Stack:** Node >= 20.9, TypeScript 5.3 (ESM, `"type": "module"`), better-sqlite3, cr-sqlite v0.16.3 loadable extension, `node:test` + `tsx` for core/cli/courier/post-office tests, vitest for ui, React + Vite UI.

**Spec:** `docs/superpowers/specs/2026-10-05-collab-package-and-doctor-design.md` (decisions P1-P14). Read it before starting; this plan argues from it.

## Global Constraints

- Code and notes are separate: no install, update or uninstall step writes a notebook file (spec rule 1).
- Nothing resolves a notebook inside the install folder (E-550). A missing notebook is never created empty unless the caller explicitly allows creation (E-689).
- Every program says which notebook it opened and why, in its first log line, on stderr (stdout is the MCP channel).
- Day-one compatibility: `COLLAB_DB_PATH`, today's `.mcp.json` (`node internal-tools/mcp/dist/server.js` + `COLLAB_DB_PATH`), Codex runs, the courier's config folder, `node courier/dist/bin.js …`, `node post-office/dist/bin.js …`, `npm start`, and the existing `mcp/collab.db` all keep working unchanged.
- Every problem is reported as a plain sentence plus the exact fix command. No bare error codes.
- `--fix` never touches notebook data (no migrate, adopt, reindex).
- Notebook names: `^[a-z0-9][a-z0-9-]{0,39}$`.
- Data folder: Windows `%LOCALAPPDATA%\collab`, macOS `~/Library/Application Support/collab`, Linux `$XDG_DATA_HOME/collab` or `~/.local/share/collab`; override `COLLAB_DATA_DIR` (tests).
- Heartbeat refresh 30 s; stale after 90 s or when the pid is gone.
- cr-sqlite version pinned at `v0.16.3`.
- Doctor exit codes: 0 all fine, 1 warnings only, 2 something broken.
- Working package name `@collab-mcp/collab` (open item O1: rename before the first public publish). Command name is `collab`.
- Never commit `collab.db*`, `store.db*`, `.env`, `vendor/crsqlite/*` binaries, `dist-package/`.
- Tests that touch notebooks set `COLLAB_DATA_DIR` and `COLLAB_DB_PATH` to temp paths. Nothing in a test may read or write the real data folder or a real notebook.

## Review Focus

1. A `.collab` file in a parent folder and a different one in a nested project folder (the user's `frontend2/` contains `ingxt-supportHub/`): the nearest one must win. Test in Task 2.
2. `COLLAB_DB_PATH` set in a user-scope MCP config while a project's `.collab` names a different notebook: must not be silent (stderr warning on open + doctor ✗). Test in Task 2 and Task 6.
3. An adopted notebook inside a git repo: heartbeats and backups must never be written next to it. Test in Task 4.
4. A rebuild with no version bump while the MCP keeps running: doctor must report the MCP as running older code. Test in Task 4 (build identity changes) and Task 7 (programs check).
5. `config.json` hand-edited into invalid JSON: commands that need it stop with the file path; nothing rewrites it; `COLLAB_DB_PATH` still works. Test in Task 1 and Task 2.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `core/src/install-root.ts` | Find the install root (folder holding `addon-manifest.json`) | 1 |
| `core/src/notebooks.ts` | Data folder, `config.json` registry, per-notebook runtime folders | 1 |
| `core/src/db.ts` (modify) | 6-rule notebook choice, clash detection, "opened" log, migrations dir via install root | 2 |
| `core/src/settings.ts`, `server/src/env.ts` (modify) | `settings.env` in the data folder | 3 |
| `scripts/write-build-info.mjs`, `core/src/build-info.ts`, `core/src/heartbeat.ts` | Build identity + "I'm alive" files | 4 |
| `addon-manifest.json`, `core/src/addon.ts`, `scripts/fetch-crsqlite.mjs` (rewrite), `core/src/sync/extension.ts` (modify) | Pinned, hash-checked add-on | 5 |
| `core/src/setup/*.ts` | Setup doctor engine and the 7 check groups | 6, 7 |
| `cli/` (new workspace) | The `collab` command | 8 |
| `mcp/src/server.ts`, `courier/src/cli.ts`, `server/src/server.ts` (modify) | Fail loudly at start, heartbeats | 9 |
| `server/src/tools/setup.ts`, `ui/…`, `mcp/src/server.ts` | Doctor in the web UI and MCP | 10 |
| `scripts/package.mjs`, `package/package.template.json`, `README.md` | Assemble + smoke-test the installable package; retire `scripts/bundle.mjs` | 11 |

---

### Task 1: Install root and notebook registry

**Files:**
- Create: `addon-manifest.json` (placeholder content in this task, real hashes in Task 5)
- Create: `core/src/install-root.ts`
- Create: `core/src/notebooks.ts`
- Modify: `core/src/index.ts` (export both)
- Test: `core/test/notebooks.test.ts`

**Interfaces:**
- Produces:
  - `installRoot(): string`: nearest ancestor of core's own folder containing `addon-manifest.json`; `COLLAB_INSTALL_ROOT` overrides.
  - `NOTEBOOK_NAME: RegExp`
  - `collabDataDir(env?, platform?, home?): string`
  - `interface NotebookConfig { default: string | null; notebooks: Record<string, { path: string }> }`
  - `class NotebookConfigError extends Error { file: string }`
  - `readNotebookConfig(dataDir?): NotebookConfig` (missing file = empty config; invalid = throws `NotebookConfigError`)
  - `writeNotebookConfig(cfg, dataDir?): void` (atomic)
  - `notebookDataDir(name, dataDir?): string`
  - `unnamedDataDir(absPath, dataDir?): string`
  - `samePath(a, b): boolean`
  - `addNotebook(name, path, dataDir?): void`
  - `setDefaultNotebook(name, dataDir?): void`
  - `nameForPath(path, dataDir?): string | null`

- [ ] **Step 1: Create the install-root marker**

`addon-manifest.json` at the repo root (Task 5 fills in real platform entries):

```json
{
  "version": "v0.16.3",
  "platforms": {}
}
```

- [ ] **Step 2: Write the failing tests**

`core/test/notebooks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collabDataDir, readNotebookConfig, writeNotebookConfig, addNotebook, setDefaultNotebook,
  notebookDataDir, unnamedDataDir, nameForPath, NotebookConfigError, NOTEBOOK_NAME,
} from '../src/notebooks.js';
import { installRoot } from '../src/install-root.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'collab-nb-'));

test('data folder per OS, COLLAB_DATA_DIR wins', () => {
  assert.equal(collabDataDir({ COLLAB_DATA_DIR: '/x' }, 'linux', '/h'), '/x');
  assert.equal(collabDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h'), 'C:\\L\\collab');
  assert.equal(collabDataDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/collab');
  assert.equal(collabDataDir({ XDG_DATA_HOME: '/d' }, 'linux', '/h'), '/d/collab');
  assert.equal(collabDataDir({}, 'linux', '/h'), '/h/.local/share/collab');
});

test('missing config.json reads as empty; round trip is atomic and exact', () => {
  const d = tmp();
  try {
    assert.deepEqual(readNotebookConfig(d), { default: null, notebooks: {} });
    writeNotebookConfig({ default: 'a', notebooks: { a: { path: '/p/a.db' } } }, d);
    assert.deepEqual(readNotebookConfig(d), { default: 'a', notebooks: { a: { path: '/p/a.db' } } });
    assert.equal(existsSync(join(d, 'config.json.tmp')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('invalid config.json throws with the file path and is never rewritten', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'config.json'), '{ not json');
    assert.throws(() => readNotebookConfig(d), (e: any) => e instanceof NotebookConfigError && e.file === join(d, 'config.json'));
    assert.throws(() => addNotebook('a', '/p/a.db', d), NotebookConfigError);
    assert.equal(readFileSync(join(d, 'config.json'), 'utf8'), '{ not json');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('addNotebook: first one becomes default; refuses bad names, duplicate names and duplicate paths', () => {
  const d = tmp();
  try {
    addNotebook('emp1st', '/p/one.db', d);
    assert.equal(readNotebookConfig(d).default, 'emp1st');
    addNotebook('acme', '/p/two.db', d);
    assert.equal(readNotebookConfig(d).default, 'emp1st');
    assert.throws(() => addNotebook('Bad Name', '/p/3.db', d), /name/);
    assert.throws(() => addNotebook('acme', '/p/4.db', d), /already/);
    assert.throws(() => addNotebook('other', '/p/two.db', d), /already registered as "acme"/);
    assert.equal(nameForPath('/p/two.db', d), 'acme');
    setDefaultNotebook('acme', d);
    assert.equal(readNotebookConfig(d).default, 'acme');
    assert.throws(() => setDefaultNotebook('nope', d), /no notebook named "nope"/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('runtime folders live in the data folder, keyed by name or by a hash of the path', () => {
  assert.equal(notebookDataDir('acme', '/data'), join('/data', 'notebooks', 'acme'));
  const u1 = unnamedDataDir('/repo/mcp/collab.db', '/data');
  assert.match(u1, /notebooks[\\/]_path-[0-9a-f]{12}$/);
  assert.equal(u1, unnamedDataDir('/repo/mcp/collab.db', '/data'));
  assert.notEqual(u1, unnamedDataDir('/other/collab.db', '/data'));
});

test('names follow the slug rule', () => {
  assert.ok(NOTEBOOK_NAME.test('supporthub'));
  assert.ok(NOTEBOOK_NAME.test('team-2'));
  assert.ok(!NOTEBOOK_NAME.test('-x'));
  assert.ok(!NOTEBOOK_NAME.test('UPPER'));
});

test('installRoot finds the folder that holds addon-manifest.json', () => {
  assert.ok(existsSync(join(installRoot(), 'addon-manifest.json')));
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd core && npx tsx --test test/notebooks.test.ts`
Expected: FAIL, `Cannot find module '../src/notebooks.js'`.

- [ ] **Step 4: Implement**

`core/src/install-root.ts`:

```ts
// file: core/src/install-root.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Code belongs to the install; data belongs to the user (spec rule 1). The
// install root is the folder holding addon-manifest.json: the repo root in a
// checkout, the package folder when installed. Found by walking up, so it
// works from core/src (tsx), core/dist (built) and node_modules/@collab-mcp/core/dist.
let cached: string | null = null;

export function installRoot(): string {
  if (process.env.COLLAB_INSTALL_ROOT) return process.env.COLLAB_INSTALL_ROOT;
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "addon-manifest.json"))) return (cached = dir);
    const up = dirname(dir);
    if (up === dir) throw new Error("[collab] install root not found: no addon-manifest.json above " + fileURLToPath(import.meta.url));
    dir = up;
  }
}
```

`core/src/notebooks.ts`:

```ts
// file: core/src/notebooks.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

// Spec P5/P6: every notebook has a folder in the per-user data folder, keyed
// by NAME, holding its runtime files (running/, backups/) wherever its .db is.

export const NOTEBOOK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function collabDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.COLLAB_DATA_DIR) return env.COLLAB_DATA_DIR;
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "collab");
}

export interface NotebookConfig {
  default: string | null;
  notebooks: Record<string, { path: string }>;
}

export class NotebookConfigError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[collab] ${file} can't be read: ${reason}. Fix the file by hand (it is never rewritten automatically); COLLAB_DB_PATH still works meanwhile.`);
    this.name = "NotebookConfigError";
  }
}

const configFile = (dataDir: string) => join(dataDir, "config.json");

export function readNotebookConfig(dataDir: string = collabDataDir()): NotebookConfig {
  const file = configFile(dataDir);
  if (!existsSync(file)) return { default: null, notebooks: {} };
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new NotebookConfigError(file, (e as Error).message); }
  if (!raw || typeof raw !== "object" || typeof raw.notebooks !== "object" || raw.notebooks === null) {
    throw new NotebookConfigError(file, 'expected { "default": ..., "notebooks": { ... } }');
  }
  for (const [name, v] of Object.entries(raw.notebooks)) {
    if (!NOTEBOOK_NAME.test(name) || typeof (v as any)?.path !== "string") throw new NotebookConfigError(file, `bad entry "${name}"`);
  }
  const def = raw.default ?? null;
  if (def !== null && !(def in raw.notebooks)) throw new NotebookConfigError(file, `default "${def}" is not in the list`);
  return { default: def, notebooks: raw.notebooks };
}

export function writeNotebookConfig(cfg: NotebookConfig, dataDir: string = collabDataDir()): void {
  mkdirSync(dataDir, { recursive: true });
  const file = configFile(dataDir);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, file);
}

export function notebookDataDir(name: string, dataDir: string = collabDataDir()): string {
  return join(dataDir, "notebooks", name);
}

/** Runtime folder for a notebook opened by path but not registered (COLLAB_DB_PATH, ./collab.db). */
export function unnamedDataDir(absPath: string, dataDir: string = collabDataDir()): string {
  const key = process.platform === "win32" ? resolve(absPath).toLowerCase() : resolve(absPath);
  return join(dataDir, "notebooks", "_path-" + createHash("sha256").update(key).digest("hex").slice(0, 12));
}

export function samePath(a: string, b: string): boolean {
  const ra = resolve(a), rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function addNotebook(name: string, path: string, dataDir: string = collabDataDir()): void {
  if (!NOTEBOOK_NAME.test(name)) throw new Error(`"${name}" is not a valid notebook name: use lowercase letters, digits and hyphens`);
  const cfg = readNotebookConfig(dataDir);
  if (cfg.notebooks[name]) throw new Error(`a notebook named "${name}" already exists (${cfg.notebooks[name].path})`);
  const other = Object.entries(cfg.notebooks).find(([, v]) => samePath(v.path, path));
  if (other) throw new Error(`${path} is already registered as "${other[0]}"`);
  cfg.notebooks[name] = { path: resolve(path) };
  if (cfg.default === null) cfg.default = name;
  writeNotebookConfig(cfg, dataDir);
}

export function setDefaultNotebook(name: string, dataDir: string = collabDataDir()): void {
  const cfg = readNotebookConfig(dataDir);
  if (!cfg.notebooks[name]) throw new Error(`no notebook named "${name}". Known: ${Object.keys(cfg.notebooks).join(", ") || "none"}`);
  cfg.default = name;
  writeNotebookConfig(cfg, dataDir);
}

export function nameForPath(path: string, dataDir: string = collabDataDir()): string | null {
  const cfg = readNotebookConfig(dataDir);
  return Object.entries(cfg.notebooks).find(([, v]) => samePath(v.path, path))?.[0] ?? null;
}
```

Note: the expected paths in the test use `join`, which is the host's separator. `collabDataDir` with explicit `platform` uses `win32`/`posix` joins on purpose, mirroring `core/src/sync/courier-paths.ts`.

Add to `core/src/index.ts`:

```ts
export * from './install-root.js';
export * from './notebooks.js';
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd core && npx tsx --test test/notebooks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add addon-manifest.json core/src/install-root.ts core/src/notebooks.ts core/src/index.ts core/test/notebooks.test.ts
git commit -m "feat(core): install root marker and per-user notebook registry"
```

---

### Task 2: Which notebook (6 rules), clash detection, "opened" log

**Files:**
- Modify: `core/src/db.ts` (`resolveDbPath`, `getDb`, `MIGRATIONS_DIR`, `MissingDatabaseError` text)
- Modify: `core/test/db-path.test.ts` (the cwd-fallback tests change meaning)
- Test: `core/test/notebook-choice.test.ts`

**Interfaces:**
- Consumes (Task 1): `readNotebookConfig`, `collabDataDir`, `samePath`, `installRoot`.
- Produces:
  - `type DbPathSource = "argument" | "notebook-flag" | "COLLAB_DB_PATH" | "collab-file" | "cwd-existing" | "cwd-create" | "default"`
  - `interface DbPathResolution { path: string; source: DbPathSource; name: string | null; collabFile: string | null; clash: { collabFile: string; collabName: string; collabPath: string | null } | null }`
  - `findCollabFile(startDir: string): { file: string; name: string } | null`
  - `class NoNotebookError extends Error { known: string[] }`
  - `class UnknownNotebookError extends Error { name: string; from: string; known: string[] }`
  - `resolveDbPath(explicit?: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv; dataDir?: string; allowCreate?: boolean }): DbPathResolution`
  - `describeResolution(r: DbPathResolution): string`: "emp1st (from .collab in C:\…)"
  - `latestAvailableMigration(): string | null`: newest released migration file name without `.sql`

Rules, first match wins (spec P7): (0) explicit path argument → `argument`; (1) `env.COLLAB_NOTEBOOK` (set by `collab --notebook`) → `notebook-flag`; (2) `env.COLLAB_DB_PATH` → `COLLAB_DB_PATH`; (3) nearest `.collab` → `collab-file`; (4) `<cwd>/collab.db` if it exists → `cwd-existing`; (5) config default → `default`; (6) if `allowCreate`, `<cwd>/collab.db` → `cwd-create`; else throw `NoNotebookError`.

Clash: only when the source is `COLLAB_DB_PATH` and a `.collab` exists whose notebook resolves to a different path (or isn't registered). Unknown name in `COLLAB_NOTEBOOK` or `.collab` → `UnknownNotebookError`, never fall through.

- [ ] **Step 1: Write the failing tests**

`core/test/notebook-choice.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDbPath, findCollabFile, NoNotebookError, UnknownNotebookError, describeResolution } from '../src/db.js';
import { addNotebook } from '../src/notebooks.js';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'collab-choice-'));
  const data = join(root, 'data');
  const proj = join(root, 'frontend2');
  const nested = join(proj, 'ingxt-supportHub', 'server');
  mkdirSync(nested, { recursive: true });
  addNotebook('emp1st', join(root, 'emp1st.db'), data);
  addNotebook('supporthub', join(root, 'sh.db'), data);
  return { root, data, proj, nested, done: () => rmSync(root, { recursive: true, force: true }) };
}
const env = (o: Record<string, string> = {}) => ({ ...o }) as NodeJS.ProcessEnv;

test('explicit argument beats everything', () => {
  const w = world();
  try {
    const r = resolveDbPath('/x.db', { cwd: w.proj, env: env({ COLLAB_DB_PATH: '/e.db', COLLAB_NOTEBOOK: 'emp1st' }), dataDir: w.data });
    assert.equal(r.source, 'argument');
    assert.equal(r.path, '/x.db');
  } finally { w.done(); }
});

test('--notebook (COLLAB_NOTEBOOK) beats COLLAB_DB_PATH; unknown name is an error, not a fall-through', () => {
  const w = world();
  try {
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_NOTEBOOK: 'supporthub', COLLAB_DB_PATH: '/e.db' }), dataDir: w.data });
    assert.deepEqual([r.source, r.name, r.path], ['notebook-flag', 'supporthub', resolve(w.root, 'sh.db')]);
    assert.throws(() => resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_NOTEBOOK: 'nope' }), dataDir: w.data }),
      (e: any) => e instanceof UnknownNotebookError && e.known.join() === 'emp1st,supporthub');
  } finally { w.done(); }
});

test('nearest .collab wins over a parent one', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = emp1st\n');
    writeFileSync(join(w.proj, 'ingxt-supportHub', '.collab'), '# team notes\nnotebook = supporthub\n');
    const inner = resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: w.data });
    assert.deepEqual([inner.source, inner.name], ['collab-file', 'supporthub']);
    assert.equal(inner.collabFile, join(w.proj, 'ingxt-supportHub', '.collab'));
    const outer = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.equal(outer.name, 'emp1st');
    assert.match(describeResolution(inner), /^supporthub \(from \.collab in .*ingxt-supportHub\)$/);
  } finally { w.done(); }
});

test('a .collab naming an unknown notebook is an error with the known names', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = typo\n');
    assert.throws(() => resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data }), /typo.*emp1st, supporthub/s);
  } finally { w.done(); }
});

test('COLLAB_DB_PATH wins over .collab but a disagreement is reported as a clash', () => {
  const w = world();
  try {
    writeFileSync(join(w.proj, '.collab'), 'notebook = supporthub\n');
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: join(w.root, 'emp1st.db') }), dataDir: w.data });
    assert.equal(r.source, 'COLLAB_DB_PATH');
    assert.equal(r.name, 'emp1st');
    assert.deepEqual(r.clash && [r.clash.collabName, r.clash.collabPath], ['supporthub', resolve(w.root, 'sh.db')]);
    const agree = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: join(w.root, 'sh.db') }), dataDir: w.data });
    assert.equal(agree.clash, null);
  } finally { w.done(); }
});

test('./collab.db only when it exists; then the default; then a clear error', () => {
  const w = world();
  try {
    const d = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.deepEqual([d.source, d.name], ['default', 'emp1st']);
    writeFileSync(join(w.proj, 'collab.db'), '');
    const c = resolveDbPath(undefined, { cwd: w.proj, env: env(), dataDir: w.data });
    assert.deepEqual([c.source, c.path], ['cwd-existing', join(w.proj, 'collab.db')]);
    const empty = join(w.root, 'empty-data');
    assert.throws(() => resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: empty }),
      (e: any) => e instanceof NoNotebookError && /collab notebook/.test(e.message));
    const cr = resolveDbPath(undefined, { cwd: w.nested, env: env(), dataDir: empty, allowCreate: true });
    assert.deepEqual([cr.source, cr.path], ['cwd-create', join(w.nested, 'collab.db')]);
  } finally { w.done(); }
});

test('an invalid config.json does not block COLLAB_DB_PATH', () => {
  const w = world();
  try {
    writeFileSync(join(w.data, 'config.json'), '{ broken');
    const r = resolveDbPath(undefined, { cwd: w.proj, env: env({ COLLAB_DB_PATH: '/e.db' }), dataDir: w.data });
    assert.deepEqual([r.source, r.path, r.name], ['COLLAB_DB_PATH', '/e.db', null]);
  } finally { w.done(); }
});

test('findCollabFile walks up to the filesystem root and returns null when none', () => {
  const w = world();
  try {
    assert.equal(findCollabFile(w.nested), null);
    writeFileSync(join(w.root, '.collab'), 'notebook=emp1st');
    assert.deepEqual(findCollabFile(w.nested), { file: join(w.root, '.collab'), name: 'emp1st' });
  } finally { w.done(); }
});
```

Update `core/test/db-path.test.ts`: the old test "falls back to collab.db in the CURRENT WORKING DIRECTORY" now expects `NoNotebookError` when no file exists and no notebooks are registered (set `COLLAB_DATA_DIR` to an empty temp folder inside the test), and `source === 'cwd-existing'` after creating the file. Change every assertion of `'cwd-fallback'` to the new source names. Keep the "explicit argument wins" and "COLLAB_DB_PATH" tests unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `cd core && npx tsx --test test/notebook-choice.test.ts test/db-path.test.ts`
Expected: FAIL (`findCollabFile` is not exported; sources differ).

- [ ] **Step 3: Implement in `core/src/db.ts`**

Replace the `DbPathSource`/`DbPathResolution`/`resolveDbPath` block with:

```ts
export type DbPathSource =
  | "argument" | "notebook-flag" | "COLLAB_DB_PATH" | "collab-file" | "cwd-existing" | "cwd-create" | "default";

export interface DbPathResolution {
  path: string;
  source: DbPathSource;
  /** Registered notebook name, or null for a path that isn't in config.json. */
  name: string | null;
  /** The .collab file that decided (or that disagrees with COLLAB_DB_PATH). */
  collabFile: string | null;
  /** COLLAB_DB_PATH won, but the nearest .collab names a different notebook (spec P7). */
  clash: { collabFile: string; collabName: string; collabPath: string | null } | null;
}

export class NoNotebookError extends Error {
  constructor(readonly known: string[], cwd: string) {
    super(
      `[collab] no notebook for ${cwd}. ` +
        (known.length
          ? `You have: ${known.join(", ")}. Fix: \`collab notebook default <name>\`, or put a .collab file with "notebook = <name>" in the project folder.`
          : `No notebooks are registered. Fix: \`collab notebook adopt <path-to-collab.db> --name <name>\` or \`collab notebook new <name>\`.`),
    );
    this.name = "NoNotebookError";
  }
}

export class UnknownNotebookError extends Error {
  constructor(readonly name: string, readonly from: string, readonly known: string[]) {
    super(`[collab] ${from} names notebook "${name}", which doesn't exist. Known: ${known.join(", ") || "none"}. Fix the name, or register it with \`collab notebook adopt\`.`);
    this.name = "UnknownNotebookError";
  }
}

/** Nearest .collab file at or above `startDir` (spec P7 rule 3: nearest wins). */
export function findCollabFile(startDir: string): { file: string; name: string } | null {
  let dir = resolvePath(startDir);
  for (;;) {
    const file = join(dir, ".collab");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.replace(/#.*/, "").match(/^\s*notebook\s*=\s*(\S+)\s*$/);
        if (m) return { file, name: m[1] };
      }
      throw new Error(`[collab] ${file} has no "notebook = <name>" line`);
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function resolveDbPath(
  explicit?: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; dataDir?: string; allowCreate?: boolean } = {},
): DbPathResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dataDir = opts.dataDir ?? collabDataDir(env);
  const none = { collabFile: null, clash: null };
  if (explicit) return { path: explicit, source: "argument", name: null, ...none };

  // config.json is read lazily: a broken file must not block rules 0 and 2.
  let cfg: NotebookConfig | null = null;
  const config = () => (cfg ??= readNotebookConfig(dataDir));
  const lookup = (name: string, from: string) => {
    const nb = config().notebooks[name];
    if (!nb) throw new UnknownNotebookError(name, from, Object.keys(config().notebooks));
    return nb.path;
  };
  const nameOf = (p: string): string | null => {
    try { return Object.entries(config().notebooks).find(([, v]) => samePath(v.path, p))?.[0] ?? null; } catch { return null; }
  };

  if (env.COLLAB_NOTEBOOK) {
    return { path: lookup(env.COLLAB_NOTEBOOK, "--notebook"), source: "notebook-flag", name: env.COLLAB_NOTEBOOK, ...none };
  }
  const found = findCollabFile(cwd);
  if (env.COLLAB_DB_PATH) {
    const path = env.COLLAB_DB_PATH;
    let clash: DbPathResolution["clash"] = null;
    if (found) {
      let collabPath: string | null = null;
      try { collabPath = config().notebooks[found.name]?.path ?? null; } catch { collabPath = null; }
      if (!collabPath || !samePath(collabPath, path)) clash = { collabFile: found.file, collabName: found.name, collabPath };
    }
    return { path, source: "COLLAB_DB_PATH", name: nameOf(path), collabFile: found?.file ?? null, clash };
  }
  if (found) {
    return { path: lookup(found.name, found.file), source: "collab-file", name: found.name, collabFile: found.file, clash: null };
  }
  const local = join(cwd, "collab.db");
  if (existsSync(local)) return { path: local, source: "cwd-existing", name: nameOf(local), ...none };
  const c = config();
  if (c.default) return { path: c.notebooks[c.default].path, source: "default", name: c.default, ...none };
  if (opts.allowCreate) return { path: local, source: "cwd-create", name: null, ...none };
  throw new NoNotebookError(Object.keys(c.notebooks), cwd);
}

export function describeResolution(r: DbPathResolution): string {
  const who = r.name ?? r.path;
  switch (r.source) {
    case "collab-file": return `${who} (from .collab in ${dirname(r.collabFile!)})`;
    case "notebook-flag": return `${who} (from --notebook)`;
    case "COLLAB_DB_PATH": return `${who} (from COLLAB_DB_PATH)`;
    case "cwd-existing": return `${who} (collab.db in the current folder)`;
    case "cwd-create": return `${who} (new collab.db in the current folder)`;
    case "default": return `${who} (the default notebook)`;
    default: return `${who} (given by the caller)`;
  }
}
```

Imports to add at the top of `db.ts`: `readFileSync` from `node:fs` (with `existsSync`), `dirname, resolve as resolvePath` from `node:path`, and `{ collabDataDir, readNotebookConfig, samePath, type NotebookConfig }` from `./notebooks.js`, `{ installRoot }` from `./install-root.js`.

In `getDb`, replace `const { path, source } = resolveDbPath(dbPath);` and the two `console.error` lines with:

```ts
  const mayCreate = opts.create === true || process.env.COLLAB_DB_CREATE === "1";
  const r = resolveDbPath(dbPath, { allowCreate: mayCreate });
  const { path, source } = r;
  if (path !== ":memory:" && !mayCreate && !existsSync(path)) {
    throw new MissingDatabaseError(path, source);
  }
  // First line of every program (spec P12): which notebook and why. stderr: stdout is the MCP channel.
  console.error(`[collab] opened ${describeResolution(r)}: ${path}`);
  if (r.clash) {
    console.error(
      `[collab] WARNING: COLLAB_DB_PATH chose ${path}, but ${r.clash.collabFile} says notebook "${r.clash.collabName}". ` +
        `Notes are going to ${path}. Remove COLLAB_DB_PATH from this program's settings to use the project's notebook.`,
    );
  }
```

(Delete the old `mayCreate` line above it, which this replaces.) Export `lastResolution(): DbPathResolution | null` by storing `r` next to `_dbPath`; doctor and heartbeats use it.

Change `MIGRATIONS_DIR` to `join(installRoot(), "mcp", "migrations")` (same folder in a checkout; correct in the installed package). Add:

```ts
/** Newest RELEASED migration this install knows (doctor check 3). */
export function latestAvailableMigration(): string | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return files.length ? files[files.length - 1].replace(/\.sql$/, "") : null;
}
```

Update `MissingDatabaseError`'s message to say which rule chose the path (`(chosen by ${source})`) and to suggest `collab notebook new <name>` / `collab notebook adopt` alongside the existing `COLLAB_DB_CREATE=1` hint.

- [ ] **Step 4: Run to verify they pass, then the whole core suite**

Run: `cd core && npx tsx --test test/notebook-choice.test.ts test/db-path.test.ts`
Expected: PASS.
Run: `cd core && npx tsx --test test/*.test.ts`
Expected: all pass. A test that relied on `cwd-fallback` creating a fresh DB in cwd must set `COLLAB_DB_PATH` (or `COLLAB_DB_CREATE=1`) explicitly. Fix the test's setup, never the rule.

- [ ] **Step 5: Commit**

```bash
git add core/src/db.ts core/test/notebook-choice.test.ts core/test/db-path.test.ts
git commit -m "feat(core): which notebook, 6 rules, nearest .collab wins, COLLAB_DB_PATH clash is loud"
```

---

### Task 3: Settings file for `collab web`

**Files:**
- Create: `core/src/settings.ts`
- Modify: `core/src/index.ts`, `server/src/env.ts`
- Test: `core/test/settings.test.ts`

**Interfaces:**
- Consumes: `collabDataDir` (Task 1).
- Produces: `settingsPath(dataDir?): string` (`<data>/settings.env`); `loadSettings(file?, env?): string[]` (sets only keys not already in `env`, returns the keys it set).

Order of precedence: real environment > repo `.env` (checkout only) > `settings.env`.

- [ ] **Step 1: Failing test** `core/test/settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, settingsPath } from '../src/settings.js';

test('reads KEY=VALUE, skips comments and blanks, strips quotes, never overrides', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-set-'));
  try {
    const f = join(d, 'settings.env');
    writeFileSync(f, '# web\nPORT=7473\n\nGROQ_MODEL="groq/compound-mini"\nGROQ_API_KEY=abc=def\nBAD LINE\n');
    const env: NodeJS.ProcessEnv = { PORT: '9000' };
    const set = loadSettings(f, env);
    assert.deepEqual(set.sort(), ['GROQ_API_KEY', 'GROQ_MODEL']);
    assert.equal(env.PORT, '9000');
    assert.equal(env.GROQ_MODEL, 'groq/compound-mini');
    assert.equal(env.GROQ_API_KEY, 'abc=def');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a missing file sets nothing', () => {
  assert.deepEqual(loadSettings(join(tmpdir(), 'nope-' + Date.now(), 'settings.env'), {}), []);
});

test('settings.env lives in the data folder', () => {
  assert.equal(settingsPath('/data'), join('/data', 'settings.env'));
});
```

- [ ] **Step 2: Run, expect FAIL** (`cd core && npx tsx --test test/settings.test.ts`).

- [ ] **Step 3: Implement** `core/src/settings.ts`:

```ts
// file: core/src/settings.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collabDataDir } from "./notebooks.js";

// Spec P14: an installed collab has no repo .env, so the web server's port and
// AI key live in the per-user data folder. Never package-relative (E-550).
export function settingsPath(dataDir: string = collabDataDir()): string {
  return join(dataDir, "settings.env");
}

export function loadSettings(file: string = settingsPath(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (env[key] !== undefined) continue;
    env[key] = rawVal.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    set.push(key);
  }
  return set;
}
```

Export from `core/src/index.ts`. In `server/src/env.ts`, after the existing `dotenv.config(...)` line, add:

```ts
import { loadSettings } from '@collab-mcp/core';
// Installed package: no repo .env exists, so this is where PORT and the AI key come from (spec P14).
loadSettings();
```

(Keep the import at the top with the others; ES module imports are hoisted, so keep `env.ts` free of DB access as it is today.)

- [ ] **Step 4: Run, expect PASS.** Then `npm -w @collab-mcp/server run build` (no errors).
- [ ] **Step 5: Commit** `git commit -m "feat: settings.env in the user data folder for the web server"` (add the three files).

---

### Task 4: Build identity and heartbeat files

**Files:**
- Create: `scripts/write-build-info.mjs`, `core/src/build-info.ts`, `core/src/heartbeat.ts`
- Modify: root `package.json` (`build` script), `.gitignore` (`build-info.json`), `core/src/index.ts`
- Test: `core/test/heartbeat.test.ts`, `test/build-info.test.mts`

**Interfaces:**
- Consumes: `installRoot`, `notebookDataDir`, `unnamedDataDir`, `collabDataDir` (Task 1); `DbPathResolution` (Task 2).
- Produces:
  - `interface BuildInfo { version: string; build: string; builtAt: string }`, `readBuildInfo(): BuildInfo` (re-reads the file every call; missing → `{ version: "dev", build: "unknown", builtAt: "" }`)
  - `type ProgramName = "mcp" | "courier" | "web"`
  - `interface Heartbeat { program: ProgramName; version: string; build: string; pid: number; startedAt: string; beatAt: string; dbPath: string; notebook: string | null }`
  - `runtimeDirFor(r: { path: string; name: string | null }, dataDir?): string`
  - `startHeartbeat(runtimeDir: string, hb: { program; version; build; dbPath; notebook }, opts?: { intervalMs?: number }): { stop(): void }`
  - `readHeartbeats(runtimeDir: string, now?: Date, isAlive?: (pid: number) => boolean): Array<Heartbeat & { file: string; stale: boolean }>`
  - `removeStaleHeartbeats(runtimeDir, now?, isAlive?): string[]` (returns removed files)

- [ ] **Step 1: Failing tests**

`core/test/heartbeat.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHeartbeat, readHeartbeats, removeStaleHeartbeats, runtimeDirFor } from '../src/heartbeat.js';

test('an adopted notebook inside a repo gets its runtime folder in the DATA folder, never next to the file', () => {
  const data = '/data';
  assert.equal(runtimeDirFor({ path: '/repo/internal-tools/mcp/collab.db', name: 'emp1st' }, data), join(data, 'notebooks', 'emp1st'));
  assert.match(runtimeDirFor({ path: '/repo/internal-tools/mcp/collab.db', name: null }, data), /notebooks[\\/]_path-/);
});

test('heartbeat is written, refreshed, and removed on stop', async () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    const h = startHeartbeat(d, { program: 'mcp', version: '0.1.0', build: 'b1', dbPath: '/x.db', notebook: 'emp1st' }, { intervalMs: 20 });
    const [hb] = readHeartbeats(d);
    assert.deepEqual([hb.program, hb.build, hb.pid, hb.stale], ['mcp', 'b1', process.pid, false]);
    const first = hb.beatAt;
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(readHeartbeats(d)[0].beatAt, first);
    h.stop();
    assert.equal(readdirSync(join(d, 'running')).length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('stale = pid gone or beat older than 90 s; removeStale deletes only those', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    mkdirSync(join(d, 'running'));
    const now = new Date('2026-10-05T10:00:00Z');
    const mk = (pid: number, beatAt: string) =>
      writeFileSync(join(d, 'running', `web-${pid}.json`), JSON.stringify({ program: 'web', version: 'v', build: 'b', pid, startedAt: beatAt, beatAt, dbPath: '/x', notebook: null }));
    mk(1, '2026-10-05T09:59:30Z'); // fresh, alive
    mk(2, '2026-10-05T09:57:00Z'); // too old
    mk(3, '2026-10-05T09:59:50Z'); // fresh but dead
    const alive = (pid: number) => pid !== 3;
    const stale = readHeartbeats(d, now, alive).filter((h) => h.stale).map((h) => h.pid).sort();
    assert.deepEqual(stale, [2, 3]);
    assert.equal(removeStaleHeartbeats(d, now, alive).length, 2);
    assert.deepEqual(readHeartbeats(d, now, alive).map((h) => h.pid), [1]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unreadable heartbeat file is reported stale, not thrown', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-hb-'));
  try {
    mkdirSync(join(d, 'running'));
    writeFileSync(join(d, 'running', 'mcp-9.json'), '{');
    const [h] = readHeartbeats(d);
    assert.equal(h.stale, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

`test/build-info.test.mts` (root suite):

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('build identity changes when built code changes, even with the same version', () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-bi-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    mkdirSync(join(root, 'core', 'dist'), { recursive: true });
    writeFileSync(join(root, 'core', 'dist', 'a.js'), 'one');
    const run = () => { execFileSync(process.execPath, ['scripts/write-build-info.mjs', root]); return JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8')); };
    const a = run();
    writeFileSync(join(root, 'core', 'dist', 'a.js'), 'two');
    const b = run();
    assert.equal(a.version, '0.1.0');
    assert.equal(b.version, '0.1.0');
    assert.notEqual(a.build, b.build);
    assert.match(a.build, /^[0-9a-f]{12}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run, expect FAIL** (`cd core && npx tsx --test test/heartbeat.test.ts`; `npx tsx --test test/build-info.test.mts`).

- [ ] **Step 3: Implement**

`scripts/write-build-info.mjs`:

```js
#!/usr/bin/env node
// Writes build-info.json at the install root: { version, build, builtAt }.
// build = first 12 hex of sha256 over every file in the workspaces' dist folders
// (sorted path + content), so a rebuild of changed code gets a new identity even
// when no version was bumped (spec P9). Usage: node scripts/write-build-info.mjs [root]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not import.meta.dirname: that needs Node 20.11+, and the floor is 20.9.
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = ['core/dist', 'courier/dist', 'post-office/dist', 'mcp/dist', 'server/dist', 'cli/dist', 'ui/dist'];
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
for (const d of DIST) if (existsSync(join(root, d))) walk(join(root, d));
files.sort();
const h = createHash('sha256');
for (const f of files) { h.update(relative(root, f).replaceAll('\\', '/')); h.update('\0'); h.update(readFileSync(f)); }
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const info = { version, build: h.digest('hex').slice(0, 12), builtAt: new Date().toISOString() };
writeFileSync(join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${info.version} ${info.build}`);
```

Root `package.json` `build` script becomes:
`"build": "npm -w @collab-mcp/core run build && npm run build --workspaces --if-present && node scripts/write-build-info.mjs"`

Add `build-info.json` to `.gitignore`.

`core/src/build-info.ts`:

```ts
// file: core/src/build-info.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "./install-root.js";

export interface BuildInfo { version: string; build: string; builtAt: string }

/** Read fresh every call: doctor compares what's installed NOW with what a program started with. */
export function readBuildInfo(): BuildInfo {
  const f = join(installRoot(), "build-info.json");
  if (!existsSync(f)) return { version: "dev", build: "unknown", builtAt: "" };
  try { return JSON.parse(readFileSync(f, "utf8")) as BuildInfo; } catch { return { version: "dev", build: "unknown", builtAt: "" }; }
}
```

`core/src/heartbeat.ts`:

```ts
// file: core/src/heartbeat.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collabDataDir, notebookDataDir, unnamedDataDir } from "./notebooks.js";

// Spec P9: "I'm alive" files so doctor can tell which code a running program
// has loaded. Always in the DATA folder (P5), never next to an adopted .db.

export type ProgramName = "mcp" | "courier" | "web";
export interface Heartbeat {
  program: ProgramName; version: string; build: string; pid: number;
  startedAt: string; beatAt: string; dbPath: string; notebook: string | null;
}
const STALE_MS = 90_000;

export function runtimeDirFor(r: { path: string; name: string | null }, dataDir: string = collabDataDir()): string {
  return r.name ? notebookDataDir(r.name, dataDir) : unnamedDataDir(r.path, dataDir);
}

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
};

export function startHeartbeat(
  runtimeDir: string,
  hb: { program: ProgramName; version: string; build: string; dbPath: string; notebook: string | null },
  opts: { intervalMs?: number } = {},
): { stop(): void } {
  const dir = join(runtimeDir, "running");
  const file = join(dir, `${hb.program}-${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const body: Heartbeat = { ...hb, pid: process.pid, startedAt, beatAt: new Date().toISOString() };
      writeFileSync(file + ".tmp", JSON.stringify(body));
      renameSync(file + ".tmp", file);
    } catch { /* spec failure table: the program keeps running; doctor reports "can't see running programs" */ }
  };
  write();
  const timer = setInterval(write, opts.intervalMs ?? 30_000);
  timer.unref();
  const remove = () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } };
  const onExit = () => remove();
  process.once("exit", onExit);
  return {
    stop() { clearInterval(timer); process.removeListener("exit", onExit); remove(); },
  };
}

export function readHeartbeats(
  runtimeDir: string,
  now: Date = new Date(),
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Array<Heartbeat & { file: string; stale: boolean }> {
  const dir = join(runtimeDir, "running");
  if (!existsSync(dir)) return [];
  const out: Array<Heartbeat & { file: string; stale: boolean }> = [];
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(dir, n);
    try {
      const h = JSON.parse(readFileSync(file, "utf8")) as Heartbeat;
      const stale = !isAlive(h.pid) || now.getTime() - Date.parse(h.beatAt) > STALE_MS;
      out.push({ ...h, file, stale });
    } catch {
      const m = n.match(/^(mcp|courier|web)-(\d+)\.json$/);
      out.push({ program: (m?.[1] ?? "mcp") as ProgramName, version: "?", build: "?", pid: Number(m?.[2] ?? 0), startedAt: "", beatAt: "", dbPath: "", notebook: null, file, stale: true });
    }
  }
  return out;
}

export function removeStaleHeartbeats(runtimeDir: string, now?: Date, isAlive?: (pid: number) => boolean): string[] {
  const gone = readHeartbeats(runtimeDir, now, isAlive).filter((h) => h.stale).map((h) => h.file);
  for (const f of gone) rmSync(f, { force: true });
  return gone;
}
```

Export both from `core/src/index.ts`.

- [ ] **Step 4: Run, expect PASS.** Then `npm run build` and confirm `build-info.json` appears at the repo root and is ignored by git (`git status --short` doesn't list it).
- [ ] **Step 5: Commit** `git commit -m "feat(core): build identity + heartbeat files in the data folder"`.

---

### Task 5: Pinned, hash-checked sync add-on

**Files:**
- Modify: `addon-manifest.json` (real entries)
- Create: `core/src/addon.ts`
- Rewrite: `scripts/fetch-crsqlite.mjs` (thin wrapper over `core/dist/addon.js`)
- Modify: `core/src/sync/extension.ts` (`DEFAULT_BASE` via `installRoot()`), `core/src/index.ts`
- Test: `core/test/addon.test.ts`

**Interfaces:**
- Consumes: `installRoot` (Task 1).
- Produces:
  - `interface AddonManifest { version: string; platforms: Record<string, { asset: string; zipSha256: string; lib: string; libSha256: string }> }`
  - `readAddonManifest(root?): AddonManifest`
  - `platformKey(platform?, arch?): string` (e.g. `win32-x64`)
  - `type AddonState = { state: "ok"; path: string; version: string } | { state: "missing"; key: string } | { state: "unsupported"; key: string } | { state: "hash-mismatch"; path: string } | { state: "override"; path: string }`
  - `checkAddon(opts?: { root?: string; platform?; arch?; env? }): AddonState`
  - `installAddon(opts?: { root?: string; fetchImpl?: typeof fetch; platform?; arch? }): Promise<AddonState>`
  - `sha256File(path: string): string`

- [ ] **Step 1: Fill the manifest with real hashes.** For each platform in the table in today's `scripts/fetch-crsqlite.mjs` (`win32-x64` → `crsqlite-win-x86_64.zip`, `linux-x64` → `crsqlite-linux-x86_64.zip`, `linux-arm64` → `crsqlite-linux-aarch64.zip`, `darwin-arm64` → `crsqlite-darwin-aarch64.zip`, `darwin-x64` → `crsqlite-darwin-x86_64.zip`), download `https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/<asset>`, compute the zip's SHA-256, unzip, find `crsqlite.(dll|so|dylib)`, compute its SHA-256. Write:

```json
{
  "version": "v0.16.3",
  "platforms": {
    "win32-x64":   { "asset": "crsqlite-win-x86_64.zip",     "zipSha256": "<computed>", "lib": "crsqlite.dll",   "libSha256": "<computed>" },
    "linux-x64":   { "asset": "crsqlite-linux-x86_64.zip",   "zipSha256": "<computed>", "lib": "crsqlite.so",    "libSha256": "<computed>" },
    "linux-arm64": { "asset": "crsqlite-linux-aarch64.zip",  "zipSha256": "<computed>", "lib": "crsqlite.so",    "libSha256": "<computed>" },
    "darwin-arm64":{ "asset": "crsqlite-darwin-aarch64.zip", "zipSha256": "<computed>", "lib": "crsqlite.dylib", "libSha256": "<computed>" },
    "darwin-x64":  { "asset": "crsqlite-darwin-x86_64.zip",  "zipSha256": "<computed>", "lib": "crsqlite.dylib", "libSha256": "<computed>" }
  }
}
```

`<computed>` means the 64-hex value you computed in this step; the committed file must contain the real values. Record in the commit message how they were computed (command used). If an asset doesn't exist for a platform, leave that platform out (it becomes "unsupported").

- [ ] **Step 2: Failing tests** `core/test/addon.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkAddon, platformKey } from '../src/addon.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fakeRoot(libContent: string | null, libSha: string) {
  const root = mkdtempSync(join(tmpdir(), 'collab-addon-'));
  writeFileSync(join(root, 'addon-manifest.json'), JSON.stringify({
    version: 'v0.16.3',
    platforms: { 'linux-x64': { asset: 'a.zip', zipSha256: 'z', lib: 'crsqlite.so', libSha256: libSha } },
  }));
  if (libContent !== null) { mkdirSync(join(root, 'vendor', 'crsqlite'), { recursive: true }); writeFileSync(join(root, 'vendor', 'crsqlite', 'crsqlite.so'), libContent); }
  return root;
}

test('platform keys', () => { assert.equal(platformKey('win32', 'x64'), 'win32-x64'); });

test('ok when the file is there and its hash matches', () => {
  const root = fakeRoot('LIB', sha('LIB'));
  try { assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'ok'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('hash mismatch is refused', () => {
  const root = fakeRoot('TAMPERED', sha('LIB'));
  try { assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'hash-mismatch'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing, unsupported, and COLLAB_CRSQLITE_PATH override', () => {
  const root = fakeRoot(null, sha('LIB'));
  try {
    assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: {} }).state, 'missing');
    assert.equal(checkAddon({ root, platform: 'aix', arch: 'ppc', env: {} }).state, 'unsupported');
    assert.equal(checkAddon({ root, platform: 'linux', arch: 'x64', env: { COLLAB_CRSQLITE_PATH: '/x/crsqlite' } }).state, 'override');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

Plus one `installAddon` test with a `fetchImpl` stub that returns bytes whose SHA doesn't match `zipSha256`: expect state `hash-mismatch`, and `vendor/crsqlite` must contain no `crsqlite.*` afterwards.

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement** `core/src/addon.ts`:

```ts
// file: core/src/addon.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "./install-root.js";

// Spec P3/P4: the cr-sqlite add-on is downloaded per OS/CPU from a pinned
// version and checked against SHA-256 values shipped in the package before it
// is ever loaded. A damaged or altered file is deleted, never loaded.

export interface AddonManifest {
  version: string;
  platforms: Record<string, { asset: string; zipSha256: string; lib: string; libSha256: string }>;
}
export type AddonState =
  | { state: "ok"; path: string; version: string }
  | { state: "missing"; key: string }
  | { state: "unsupported"; key: string }
  | { state: "hash-mismatch"; path: string }
  | { state: "override"; path: string };

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;
export function readAddonManifest(root: string = installRoot()): AddonManifest {
  return JSON.parse(readFileSync(join(root, "addon-manifest.json"), "utf8"));
}
const vendorDir = (root: string) => join(root, "vendor", "crsqlite");

export function checkAddon(o: { root?: string; platform?: string; arch?: string; env?: NodeJS.ProcessEnv } = {}): AddonState {
  const env = o.env ?? process.env;
  if (env.COLLAB_CRSQLITE_PATH) return { state: "override", path: env.COLLAB_CRSQLITE_PATH };
  const root = o.root ?? installRoot();
  const m = readAddonManifest(root);
  const key = platformKey(o.platform, o.arch);
  const p = m.platforms[key];
  if (!p) return { state: "unsupported", key };
  const file = join(vendorDir(root), p.lib);
  if (!existsSync(file)) return { state: "missing", key };
  if (sha256File(file) !== p.libSha256) return { state: "hash-mismatch", path: file };
  return { state: "ok", path: file, version: m.version };
}

export async function installAddon(o: { root?: string; fetchImpl?: typeof fetch; platform?: string; arch?: string } = {}): Promise<AddonState> {
  const root = o.root ?? installRoot();
  const m = readAddonManifest(root);
  const key = platformKey(o.platform, o.arch);
  const p = m.platforms[key];
  if (!p) return { state: "unsupported", key };
  const out = vendorDir(root);
  mkdirSync(out, { recursive: true });
  const url = `https://github.com/vlcn-io/cr-sqlite/releases/download/${m.version}/${p.asset}`;
  const res = await (o.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== p.zipSha256) return { state: "hash-mismatch", path: url };
  const staging = join(out, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const zip = join(staging, p.asset);
  writeFileSync(zip, bytes);
  // Windows: the OS tar by full path (under Git Bash, plain `tar` is GNU tar and misreads "C:\").
  if (process.platform === "win32") execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", staging]);
  else execFileSync("unzip", ["-o", zip, "-d", staging]);
  const lib = readdirSync(staging).find((f) => f === p.lib);
  if (!lib || sha256File(join(staging, lib)) !== p.libSha256) {
    rmSync(staging, { recursive: true, force: true });
    return { state: "hash-mismatch", path: join(staging, p.lib) };
  }
  renameSync(join(staging, lib), join(out, p.lib));
  rmSync(staging, { recursive: true, force: true });
  return checkAddon({ root, platform: o.platform, arch: o.arch, env: {} });
}
```

`scripts/fetch-crsqlite.mjs` becomes:

```js
#!/usr/bin/env node
// Downloads and verifies the pinned cr-sqlite add-on (addon-manifest.json).
// Needs core built first: npm -w @collab-mcp/core run build
import { installAddon } from '../core/dist/addon.js';
const r = await installAddon();
if (r.state !== 'ok') { console.error(`cr-sqlite: ${r.state}${'key' in r ? ' (' + r.key + ')' : ''}${'path' in r ? ' ' + r.path : ''}`); process.exit(1); }
console.log(`cr-sqlite ${r.version} -> ${r.path} (verified)`);
```

In `core/src/sync/extension.ts`, change `DEFAULT_BASE` to `join(installRoot(), "vendor", "crsqlite", "crsqlite")` (import `installRoot`). Its error message's fix text becomes: "Fix: `collab doctor --fix` (or in a checkout: `npm run fetch:crsqlite`)".

- [ ] **Step 5: Run, expect PASS.** Also run `npm -w @collab-mcp/core run build && node scripts/fetch-crsqlite.mjs` and confirm "verified".
- [ ] **Step 6: Commit** `git commit -m "feat: pinned, hash-checked cr-sqlite add-on (manifest + verified install)"`.

---

### Task 6: Setup doctor engine + groups 1-3 (install, notebook, version)

**Files:**
- Create: `core/src/setup/types.ts`, `core/src/setup/engine.ts`, `core/src/setup/check-install.ts`, `core/src/setup/check-notebook.ts`, `core/src/setup/check-version.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/setup-doctor.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces (`core/src/setup/types.ts`):

```ts
export type GroupId = "install" | "notebook" | "version" | "programs" | "sync" | "claude" | "notes";
export type Mark = "ok" | "warn" | "error" | "skipped";
export interface SetupCheck { group: GroupId; id: string; mark: Mark; text: string; fix?: string }
export interface SetupReport {
  checks: SetupCheck[];
  errors: number;
  warnings: number;
  exitCode: 0 | 1 | 2;
  notebook: { name: string | null; path: string; source: string; described: string } | null;
}
export interface SetupContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  now: Date;
  /** Network probe of the post office; doctor never opens a socket in tests unless a stub is given. */
  probePostOffice: ((db: import("../db.js").DB) => Promise<"ok" | "unreachable" | "cert-changed">) | null;
  claudeConfigFiles: string[];
  isAlive: (pid: number) => boolean;
  /** Only these groups run (startup checks use ["install", "notebook"]). */
  groups?: GroupId[];
}
export interface GroupState { resolution: import("../db.js").DbPathResolution | null; db: import("../db.js").DB | null; dbOpenError: string | null }
export type GroupRunner = (ctx: SetupContext, st: GroupState) => Promise<SetupCheck[]> | SetupCheck[];
```

- `runSetupDoctor(partial?: Partial<SetupContext>): Promise<SetupReport>` in `engine.ts`.
- `startupProblem(partial?): Promise<SetupCheck | null>`: runs only install + notebook; returns the first `error` check or null.

Engine rules:
- Groups run in order install → notebook → version → programs → sync → claude → notes.
- Each check runs inside `try/catch`; a throw becomes `{ mark: "error", text: "doctor could not run this check: <message>" }` and the next check still runs.
- After `notebook`, if the notebook resolved and the file exists, the engine opens it **read-only** (`new Database(path, { readonly: true, fileMustExist: true })`) and loads cr-sqlite when `hasCrrTables`; failure sets `dbOpenError`.
- `version`, `programs`, `notes` need `st.resolution`; `version` and `notes` need `st.db`. Missing prerequisite → one check `{ mark: "skipped", text: "skipped: needs <group>" }` per group. `sync` runs only when `st.db` exists AND `isSyncEnabled(db)`; otherwise one `skipped` check with `text: "sharing is off for this notebook"`.
- The engine closes the DB at the end.
- `exitCode`: 2 if any `error`, else 1 if any `warn`, else 0. `skipped` counts as neither.

Group checks (texts are user-facing; keep them exactly this plain):

`check-install.ts`:
- `install.node`: compare `process.versions.node` with the `engines.node` range from the install root `package.json` (support only `>=X.Y.Z`; parse it, compare numerically). Fail → `error`, text `Node ${v} is older than collab needs (${range})`, fix `install Node ${min} or newer from nodejs.org`.
- `install.sqlite`: `new Database(":memory:").close()` from `better-sqlite3` inside try. Fail with message matching `/NODE_MODULE_VERSION|was compiled against a different Node/` → `error`, text `The database driver was built for a different Node version`, fix `npm rebuild -g @collab-mcp/collab (or reinstall collab)`. Other failure → `error` with the message, same fix.
- `install.addon`: `checkAddon()`. `ok` → `Sync add-on ${version}, checked`. `missing` → `error` "Sync add-on missing", fix `collab doctor --fix`. `hash-mismatch` → `error` "The sync add-on file was damaged or altered", fix `collab doctor --fix`. `unsupported` → `warn` "No sync add-on for ${key}: this computer can keep notes but can't share them". `override` → `warn` "Using a sync add-on from COLLAB_CRSQLITE_PATH (${path}); not checked".

`check-notebook.ts`:
- `notebook.choice`: `resolveDbPath(undefined, { cwd, env, dataDir })`. Success → `ok` with `describeResolution(r)`; store into `st.resolution`. `NoNotebookError`/`UnknownNotebookError`/`NotebookConfigError` → `error` whose `text` is the error message without the `[collab] ` prefix and whose `fix` is the command inside it.
- `notebook.file`: exists and writable (`accessSync(path, W_OK)`); missing → `error` "No notebook file at ${path}", fix `collab notebook adopt <path> --name <name> or collab notebook new <name>`.
- `notebook.location`: `samePath`-prefix check against `installRoot()`; inside → `error` "This notebook is inside the collab install folder; an update would put it at risk", fix `move it with collab's help: copy it elsewhere, then collab notebook adopt <new path> --name <name>`. Exception: when `installRoot()` is a git checkout (has `.git`), this is `warn` instead, with the same text plus "(fine for a repo checkout, not for an installed package)". That keeps NAVEEN's adopted `internal-tools/mcp/collab.db` from being an error.
- `notebook.clash`: `r.clash` → `error` "COLLAB_DB_PATH sends notes to ${path}, but ${clash.collabFile} says notebook "${clash.collabName}"", fix `remove COLLAB_DB_PATH from this program's settings (e.g. the collab entry in .mcp.json)`.
- `notebook.unregistered`: `r.name === null` → `warn` "This notebook isn't in collab's list", fix `collab notebook adopt "${path}" --name <name>`.

`check-version.ts`:
- `version.notebook`: `latestMigration(db)` vs `latestAvailableMigration()`. Equal → `ok` "Notebook on ${x}, matches this install". Notebook older → `warn` "Notebook is on ${a}; this install has ${b}", fix `collab update (piece 3); until then: npm --prefix mcp run migrate in a checkout`. Notebook newer → `error` "This notebook is on ${a} but this install only knows up to ${b}", fix `update collab on this computer`.
- `version.office`: only when sync is enabled. Read the courier status via `readSyncOverview(db)`. State `needs-update` → `error` "The post office and this laptop are on different versions; sync is paused", fix `update whichever is older (the post office first)`. Otherwise `ok` "In step with the post office (as far as the courier knows)".

- [ ] **Step 1: Failing tests** `core/test/setup-doctor.test.ts`. Build each scenario with a temp data dir, a temp project dir, and a migrated temp notebook (`getDb(path, { create: true })` + `migrate`, then `closeDb()`); pass `env` with only `COLLAB_DATA_DIR`; `probePostOffice: null`; `claudeConfigFiles: []`; `groups` limited to what's tested:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupDoctor, startupProblem } from '../src/setup/engine.js';
import { getDb, closeDb, migrate } from '../src/db.js';
import { addNotebook } from '../src/notebooks.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'collab-doc-'));
  const data = join(root, 'data'); const proj = join(root, 'proj'); mkdirSync(proj, { recursive: true });
  const nb = join(root, 'nb.db');
  const db = getDb(nb, { create: true }); migrate(db); closeDb();
  const base = { cwd: proj, env: { COLLAB_DATA_DIR: data } as NodeJS.ProcessEnv, dataDir: data, now: new Date(), probePostOffice: null, claudeConfigFiles: [], isAlive: () => true };
  return { root, data, proj, nb, base, done: () => rmSync(root, { recursive: true, force: true }) };
}
const by = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

test('no notebook: notebook.choice is an error with the fix; dependent groups are skipped, not passed', async () => {
  const s = setup();
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version', 'notes'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').fix, /collab notebook/);
    assert.ok(r.checks.filter((c: any) => c.group === 'version').every((c: any) => c.mark === 'skipped'));
    assert.equal(r.exitCode, 2);
  } finally { s.done(); }
});

test('registered default notebook on the latest migration: notebook + version are ok', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version'] });
    assert.equal(by(r, 'notebook.choice').mark, 'ok');
    assert.match(by(r, 'notebook.choice').text, /emp1st \(the default notebook\)/);
    assert.equal(by(r, 'version.notebook').mark, 'ok');
    assert.equal(r.exitCode, 0);
    assert.equal(r.notebook?.name, 'emp1st');
  } finally { s.done(); }
});

test('COLLAB_DB_PATH vs .collab disagreement is an error', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const other = join(s.root, 'other.db'); const db = getDb(other, { create: true }); migrate(db); closeDb();
    addNotebook('supporthub', other, s.data);
    writeFileSync(join(s.proj, '.collab'), 'notebook = supporthub\n');
    const r = await runSetupDoctor({ ...s.base, env: { ...s.base.env, COLLAB_DB_PATH: s.nb }, groups: ['notebook'] });
    assert.equal(by(r, 'notebook.clash').mark, 'error');
    assert.match(by(r, 'notebook.clash').fix, /COLLAB_DB_PATH/);
  } finally { s.done(); }
});

test('a check that throws becomes an error line and the rest still run', async () => {
  const s = setup();
  mkdirSync(s.data, { recursive: true });
  writeFileSync(join(s.data, 'config.json'), '{ broken');
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['install', 'notebook'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').text, /config\.json/);
    assert.ok(by(r, 'install.node'));
  } finally { s.done(); }
});

test('startupProblem returns the first blocking error, or null', async () => {
  const s = setup();
  try {
    assert.equal((await startupProblem({ ...s.base }))?.id, 'notebook.choice');
    addNotebook('emp1st', s.nb, s.data);
    const p = await startupProblem({ ...s.base });
    assert.ok(p === null || p.group === 'install', 'only an install problem (e.g. add-on missing in CI) may remain');
  } finally { s.done(); }
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the engine and three group files per the rules above. `engine.ts` exports `runSetupDoctor` and `startupProblem`; defaults: `cwd = process.cwd()`, `env = process.env`, `dataDir = collabDataDir(env)`, `now = new Date()`, `probePostOffice = defaultProbe` (Task 7), `claudeConfigFiles = defaultClaudeConfigFiles(cwd)` (Task 7), `isAlive` = `process.kill(pid, 0)` probe.
- [ ] **Step 4: Run, expect PASS.** Run the whole core suite.
- [ ] **Step 5: Commit** `git commit -m "feat(core): setup doctor engine with install, notebook and version checks"`.

---

### Task 7: Setup doctor groups 4-7 (programs, sync, Claude Code, notes) + text formatter

**Files:**
- Create: `core/src/setup/check-programs.ts`, `core/src/setup/check-sync.ts`, `core/src/setup/check-claude.ts`, `core/src/setup/check-notes.ts`, `core/src/setup/format.ts`
- Modify: `core/src/setup/engine.ts` (register the groups, `defaultProbe`, `defaultClaudeConfigFiles`), `core/src/index.ts`
- Test: extend `core/test/setup-doctor.test.ts`; new `core/test/setup-format.test.ts`

**Interfaces:**
- Consumes: `readHeartbeats`, `runtimeDirFor`, `readBuildInfo` (Task 4); `readSyncOverview`, `isSyncEnabled`, `postOfficeTargetFromDb`, `connectPinned`, `PinMismatchError` (existing core); `doctor(db)` (existing); Task 6 types.
- Produces: `formatSetupReport(r: SetupReport): string`; `defaultClaudeConfigFiles(cwd: string): string[]`; `defaultProbe(db): Promise<"ok" | "unreachable" | "cert-changed">`.

Checks:

`programs` (needs `st.resolution`; runtime dir = `runtimeDirFor(st.resolution, ctx.dataDir)`; installed = `readBuildInfo()`):
- One check per program `mcp`, `courier`, `web` (id `programs.<name>`). For each live (non-stale) heartbeat of that program: build equals installed build → `ok` "<Name> running (pid N)"; differs → `error` "The MCP is running older code than is installed (started <startedAt local HH:MM>, installed build <builtAt local HH:MM>)" with fixes: mcp → `type /mcp in Claude Code and reconnect collab`; courier → `collab sync stop, then collab sync start`; web → `stop the web server (Ctrl+C) and run collab web`. None running → courier: `warn` only if sync is enabled ("Courier not running: notes aren't being shared", fix `collab sync start`); web: `warn` "Web server not running", fix `collab web`; mcp: `ok` "MCP not running (Claude Code starts it when needed)".
- `programs.stale`: stale heartbeat files present → `warn` "N leftover status file(s) from programs that stopped", fix `collab doctor --fix`.
- When `installed.build === "unknown"` (a checkout that was built before Task 4), compare nothing: `warn` "Can't tell which code programs are running: this install has no build identity", fix `npm run build`.

`sync` (only when enabled):
- `sync.office`: `await ctx.probePostOffice(db)`: `ok` "Post office reachable, certificate matches"; `unreachable` → `error` "Can't reach the post office at <url>", fix `check the network, or ask whoever runs the post office`; `cert-changed` → `error` "The post office's certificate changed. Do not continue", fix `ask your admin before re-joining`. `probePostOffice === null` → `skipped` "network check not run".
- `sync.courier`: from `readSyncOverview(db)`: `connected` → `ok` "Connected, N change(s) waiting"; `offline` → `warn` "Courier offline since <lastContact>"; `needs-update` → covered by `version.office` (here `ok`-less: emit nothing); `revoked` → `error` "This laptop's access was revoked", fix `ask your admin for a new join code`.

`defaultProbe(db)`: `const t = postOfficeTargetFromDb(db); if (!t) return "unreachable"; try { (await connectPinned(t, 4000)).destroy(); return "ok"; } catch (e) { return e instanceof PinMismatchError ? "cert-changed" : "unreachable"; }`

`claude`:
- `defaultClaudeConfigFiles(cwd)`: `~/.claude.json` plus every `.mcp.json` from `cwd` up to the filesystem root.
- Parse each existing file (skip unreadable ones). Collect MCP server entries from `mcpServers` at the top level and, in `~/.claude.json`, from `projects[<cwd or a parent>].mcpServers`. An entry is collab's if its key is `collab` or its `args` contain `mcp/dist/server.js` or `["mcp"]` with `command` ending in `collab`.
- `claude.registered`: none → `warn` "collab isn't registered in Claude Code", fix `claude mcp add collab -- collab mcp`. Found with `command` `collab` and args `["mcp"]` → `ok` "Claude Code runs collab mcp (<file>)". Found with a `dist/server.js` path → `warn` "Claude Code runs collab from a file path (<file>)", fix `replace that entry with: "collab": { "command": "collab", "args": ["mcp"] }`. Found with an `env.COLLAB_DB_PATH` AND `st.resolution?.clash` → no extra line (already `notebook.clash`).

`notes` (needs `st.db`):
- Map each `doctor(db).checks` item to `{ group: "notes", id: "notes." + c.name, mark: c.severity === "ok" ? "ok" : c.severity === "warn" ? "warn" : "error", text: c.detail }`. Collapse all `ok` ones into one line "N checks passed" (keep warn/error lines individually).
- `notes.search`: count live entries missing from the search index. Use the same row-matching that `reindexFts` in `core/src/sync/changes.ts` relies on (entries_fts carries `ulid`): `SELECT COUNT(*) n FROM entries e WHERE <liveEntry(db,'e')> AND NOT EXISTS (SELECT 1 FROM entries_fts f WHERE f.ulid = e.ulid)` on a ≥0005 file; skip (`ok` "search index check needs migration 0005") on older files. N > 0 → `error` "N note(s) can't be found by search", fix `collab notebook reindex`.

`format.ts` produces exactly this shape (group headings in order, a blank line between groups, skipped groups shown as one dim line):

```
collab doctor

Install
  ✓ Node 22.11.0 (needs >=20.9.0)
  ✓ Sync add-on v0.16.3, checked

Programs
  ✗ The MCP is running older code than is installed (started 14:02, installed build 18:40)
      fix: type /mcp in Claude Code and reconnect collab

1 problem, 0 warnings.
```

Marks: `✓` ok, `!` warn, `✗` error, `-` skipped. Final line: `All good.` when exit 0, else `<errors> problem(s), <warnings> warning(s).`

- [ ] **Step 1: Failing tests.** Add to `setup-doctor.test.ts`:
  - programs: write a heartbeat with `build: 'old'` into `runtimeDirFor({ path: s.nb, name: 'emp1st' }, s.data)` for `process.pid`, set `COLLAB_INSTALL_ROOT` to a temp folder holding `addon-manifest.json`, `package.json` and a `build-info.json` with `build: 'new'`; expect `programs.mcp` `error` with fix `/mcp`. Restore `COLLAB_INSTALL_ROOT` in `finally`.
  - claude: a temp `.mcp.json` in the project with `{ "mcpServers": { "collab": { "command": "node", "args": ["internal-tools/mcp/dist/server.js"] } } }` → `claude.registered` `warn` with the replacement fix; with `{ "command": "collab", "args": ["mcp"] }` → `ok`; no file → `warn` with `claude mcp add`.
  - notes: a notebook with one entry whose FTS row was deleted (`DELETE FROM entries_fts`) → `notes.search` `error` "1 note(s) can't be found by search".
  - sync skipped when sharing is off: `sync` group has exactly one `skipped` check.
  `core/test/setup-format.test.ts`: a fixed `SetupReport` with one ok, one warn with fix, one error with fix, one skipped group → compare the full string to a literal expected block (write it out in the test).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the four group files, `format.ts`, and wire them into `engine.ts`.
- [ ] **Step 4: Run, expect PASS**; whole core suite green.
- [ ] **Step 5: Commit** `git commit -m "feat(core): doctor checks for programs, sync, Claude Code and notes; text report"`.

---

### Task 8: The `collab` command (`cli/` workspace)

**Files:**
- Create: `cli/package.json`, `cli/tsconfig.json`, `cli/src/bin.ts`, `cli/src/main.ts`, `cli/src/notebook.ts`, `cli/src/doctor.ts`, `cli/src/postinstall.ts`
- Modify: root `package.json` (`workspaces` add `"cli"`), `courier/package.json` (remove its `bin`; the file `courier/dist/bin.js` stays and keeps working by path)
- Test: `cli/test/cli.test.ts`

**Interfaces:**
- Consumes: courier `runCli` (`courier/src/cli.ts`, signature `runCli(argv: string[], io: { out(l: string): void; err(l: string): void }, deps?) → Promise<{ code: number; stop?: () => Promise<void> }>`), post-office `runCli` (same io; result `{ code; office? }`), core APIs from Tasks 1-7.
- Produces: `main(argv: string[], io: Io, deps?: { importModule?: (spec: string) => Promise<unknown> }): Promise<{ code: number; stop?: () => Promise<void> }>` in `cli/src/main.ts`.

Command table:

| Command | Behaviour |
|---|---|
| `collab --version` | prints `collab <version> (build <build>, <builtAt>)` from `readBuildInfo()` |
| `collab [--notebook <name>] <cmd> …` | `--notebook` sets `process.env.COLLAB_NOTEBOOK = name` before dispatch (rule 1), then is removed from argv |
| `collab sync …` | `courier runCli(["sync", ...rest])`, same stop handling as `courier/src/bin.ts` |
| `collab office …` | `post-office runCli(rest)`, same `office.close` handling as `post-office/src/bin.ts` |
| `collab mcp` | `await import("collab-mcp/dist/server.js")` (top-level code starts the stdio server) |
| `collab web` | sets `COLLAB_UI_DIST` to `<installRoot>/ui/dist` when unset, then `await import("@collab-mcp/server/dist/server.js")` |
| `collab notebook list` | table: name, default marker `*`, migration (opened read-only), path |
| `collab notebook adopt <path> --name <name>` | file must exist and have `schema_migrations` (open read-only to check); `addNotebook`; prints "Added <name>. It stays where it is: <path>" |
| `collab notebook new <name>` | creates `notebookDataDir(name)/notebook.db` via `getDb(path, { create: true })` + `migrate`; refuses if the file exists; `addNotebook` |
| `collab notebook default <name>` | `setDefaultNotebook` |
| `collab notebook which` | `describeResolution(resolveDbPath())` + path; non-zero exit with the error text when none |
| `collab notebook reindex` | opens the resolved notebook read-write, loads cr-sqlite if needed, rebuilds every live entry's FTS row with `reindexFts(db, allLiveUlids)`, prints the count |
| `collab doctor [--json] [--fix]` | `runSetupDoctor()`; `--json` prints `JSON.stringify(report)`; else `formatSetupReport`. Exit code = `report.exitCode`. `--fix` first runs the safe repairs, then the report |
| anything else | usage text listing the commands; exit 2 |

`--fix` repairs (only these; spec P11): `install.addon` missing/hash-mismatch → `installAddon()`; `programs.courier` not running while sync enabled → courier `runCli(["sync", "start"])`; `programs.stale` → `removeStaleHeartbeats`. `programs.web` not running is NOT auto-started by `--fix` (it would block the terminal); its fix line stays. Print one line per repair attempted: "fixed: …" or "could not fix: … (<reason>)".

`cli/src/postinstall.ts`: `if (process.env.COLLAB_SKIP_ADDON === "1") exit 0`; else `await installAddon()` inside try; on any failure print `collab: the sync add-on could not be downloaded now (<reason>). Run "collab doctor --fix" later.` and **exit 0** (spec P4: never fail the install).

`cli/package.json`:

```json
{
  "name": "@collab-mcp/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "collab": "./dist/bin.js" },
  "scripts": { "build": "tsc", "test": "tsx --test test/*.test.ts" },
  "dependencies": {
    "@collab-mcp/core": "*",
    "@collab-mcp/courier": "*",
    "@collab-mcp/post-office": "*",
    "@collab-mcp/server": "*",
    "collab-mcp": "*"
  },
  "devDependencies": { "@types/node": "^20.14.0", "tsx": "^4.16.0", "typescript": "~5.3.3" },
  "engines": { "node": ">=20.9.0" }
}
```

`cli/tsconfig.json`: copy `courier/tsconfig.json` and adjust `outDir`/`rootDir` to `dist`/`src`.

- [ ] **Step 1: Failing tests** `cli/test/cli.test.ts` (all with `COLLAB_DATA_DIR` set to a temp folder; capture io lines):
  - `--version` prints a line starting `collab `.
  - `notebook new t` creates `<data>/notebooks/t/notebook.db`, registers it as default; a second `notebook new t` exits non-zero with "already".
  - `notebook adopt <tmp>/x.db --name x` on a migrated temp file → listed by `notebook list`; on a non-collab SQLite file → non-zero, "isn't a collab notebook".
  - `--notebook x notebook which` → prints `x (from --notebook)`.
  - `doctor --json` → parses as JSON with `exitCode` in {0,1,2} and checks for all 7 groups (`group` values).
  - `sync status` routes to the courier (inject `importModule` stub that returns `{ runCli: async (a) => { seen = a; return { code: 0 }; } }`; assert `seen` deep-equals `['sync', 'status']`).
  - unknown command → exit 2 and usage text contains `collab notebook`.
- [ ] **Step 2: Run, expect FAIL** (`cd cli && npx tsx --test test/cli.test.ts`).
- [ ] **Step 3: Implement** `main.ts` (routing + `--notebook`), `notebook.ts`, `doctor.ts`, `bin.ts` (calls `main(process.argv.slice(2), consoleIo)`, wires `stop` to SIGINT/SIGTERM, sets `process.exitCode`), `postinstall.ts`. Route via `deps.importModule ?? ((s) => import(s))` so tests can stub.
- [ ] **Step 4: Run, expect PASS.** `npm install` at the root (links the new workspace), `npm run build`, then `node cli/dist/bin.js --version` and `node cli/dist/bin.js doctor` by hand.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): the collab command: sync, office, mcp, web, notebook, doctor"`.

---

### Task 9: Fail loudly at start; heartbeats in the three programs

**Files:**
- Modify: `mcp/src/server.ts`, `courier/src/cli.ts` (the `run` and `start` cases), `server/src/server.ts`
- Test: `mcp/test/degraded.test.ts` (new; spawn-based), extend `courier/test/cli.test.ts` (or the existing courier CLI test file), `test/api.setup.test.mts` (Task 10 also adds to it)

**Interfaces:**
- Consumes: `startupProblem`, `runSetupDoctor`, `formatSetupReport` (Tasks 6-7); `startHeartbeat`, `runtimeDirFor`, `readBuildInfo` (Task 4); `lastResolution` (Task 2).

MCP (`mcp/src/server.ts`), spec P12. The MCP must never exit on a setup problem:

```ts
// Server boot (spec P12): a setup problem starts the server DEGRADED instead of
// exiting, because Claude Code shows an exited server only as "failed".
const problem = await startupProblem();
let db!: DB;
let degradedText: string | null = null;
if (problem) {
  degradedText = `collab can't work yet: ${problem.text}.${problem.fix ? ` Fix: ${problem.fix}` : ""} (Run collab_doctor for the full report.)`;
} else {
  try {
    db = getDb();
    const appliedMigrations = migrate(db);
    if (appliedMigrations.length > 0) console.error(`[collab-mcp] applied migrations: ${appliedMigrations.join(", ")}`);
  } catch (e) {
    degradedText = `collab can't open its notebook: ${(e as Error).message.replace(/^\[collab(-mcp)?\] /, "")}`;
  }
}
const server = new McpServer({ name: "collab", version: "0.2.0" });
if (degradedText) {
  console.error(`[collab-mcp] DEGRADED: ${degradedText}`);
  const register = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, _handler: unknown) =>
    register(name, config, async () =>
      name === "collab_doctor"
        ? { content: [{ type: "text" as const, text: formatSetupReport(await runSetupDoctor()) }] }
        : { content: [{ type: "text" as const, text: degradedText! }], isError: true });
} else {
  const r = lastResolution()!;
  startHeartbeat(runtimeDirFor(r), { program: "mcp", ...pick(readBuildInfo()), dbPath: r.path, notebook: r.name });
}
```

(`pick` = `({ version, build }) => ({ version, build })`; import `DB` type from core.) Before writing this, `grep -n "\bdb\b" mcp/src/server.ts` and confirm that `db` is used only inside tool handlers after boot. Any top-level use must move inside the `else` branch.

Courier (`courier/src/cli.ts`), in `run` and in `start` before launching: `const p = await startupProblem(); if (p?.mark === "error") { io.err(\`collab sync can't start: ${p.text}${p.fix ? \`\n  fix: ${p.fix}\` : ""}\`); return { code: 2 }; }`. In `run`, after the config is read, start the heartbeat for `{ path: cfg.dbPath, name: nameForPath(cfg.dbPath) }` with `program: "courier"` and stop it in the existing stop path.

Web server (`server/src/server.ts`): before `listen`, the same `startupProblem` check printing to stderr and `process.exit(2)`; after the DB opens, start the heartbeat with `program: "web"`.

- [ ] **Step 1: Failing tests.**
  - `mcp/test/degraded.test.ts`: spawn `node mcp/dist/server.js` with env `COLLAB_DATA_DIR=<empty temp>`, no `COLLAB_DB_PATH`, cwd = a temp folder. Send MCP `initialize`, `tools/list`, then `tools/call` for `collab_search`. Expect: the process is still alive, `tools/list` returns the normal tool names, the call result has `isError: true` and its text contains `collab notebook`; `tools/call collab_doctor` returns text containing `collab doctor` and `Notebook`. (Use the existing MCP test helpers in `mcp/test/` if one spawns the server over stdio; otherwise write JSON-RPC lines to stdin and read newline-delimited responses.)
  - courier: `runCli(["sync", "run"], io)` with an empty data dir and no notebook → `code: 2`, `io.err` contains "can't start".
  - root `test/api.setup.test.mts` (shared with Task 10): starting the web server with an empty data dir and no notebook exits with code 2 and stderr contains `fix:`.
- [ ] **Step 2: Run, expect FAIL** (after `npm run build`).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run, expect PASS**; then the courier, mcp and root suites.
- [ ] **Step 5: Commit** `git commit -m "feat: fail loudly at start (MCP degraded mode), heartbeats in mcp/courier/web"`.

---

### Task 10: Doctor in the web UI and the MCP tool

**Files:**
- Create: `server/src/tools/setup.ts`
- Modify: `server/src/server.ts` (spread `setup.routes`), `ui/src/api/client.ts`, `ui/src/pages/Health.tsx`, `ui/src/components/SyncBar.tsx`, `mcp/src/server.ts` (`collab_doctor` handler)
- Test: `test/api.setup.test.mts`, `ui/src/pages/Health.setup.test.tsx`

**Interfaces:**
- Consumes: `runSetupDoctor`, `formatSetupReport`, `SetupReport`.
- Produces: `GET /api/doctor/setup` → `SetupReport` JSON; `setupDoctor(): Promise<SetupReport>` in `ui/src/api/client.ts`.

`server/src/tools/setup.ts`:

```ts
// file: server/src/tools/setup.ts
import http from 'node:http';
import { runSetupDoctor } from '@collab-mcp/core';

type Send = (status: number, body: any) => void;
// Same report as `collab doctor --json` and the MCP collab_doctor tool (spec P10).
export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/doctor/setup': async (_req, _res, send) => send(200, await runSetupDoctor()),
};
```

Health page: add a "Setup" section above the existing checks that renders `report.checks` grouped by `group` in the order install, notebook, version, programs, sync, claude, notes; each line shows the mark (✓ ! ✗ -), the text, and the fix in a `<code>` element; a summary line with the same words as the terminal ("All good." / "N problem(s), M warning(s)."). Keep the existing data-check UI below it unchanged.

SyncBar: when `v` is shown, append a link "check setup" to `/health` (react-router `Link`, same styling as the bar text, `underline`).

MCP `collab_doctor` handler: prepend `formatSetupReport(await runSetupDoctor())` and a blank line to its existing text output; keep the existing data-check text after it. Update the tool's description: "Checks the whole setup (install, notebook, versions, running programs, sync, Claude Code) and the notes' schema + data integrity."

- [ ] **Step 1: Failing tests.**
  - `test/api.setup.test.mts`: start the server via the existing helper `test/helpers/server.mjs` against a migrated temp notebook (registered as default in a temp `COLLAB_DATA_DIR`), `GET /api/doctor/setup` with the web key header the helper provides → 200, `exitCode` in {0,1,2}, `checks.some(c => c.group === 'notebook' && c.mark === 'ok')`.
  - `ui/src/pages/Health.setup.test.tsx` (vitest + the existing testing setup used by `ui/src/components/AiPanel.test.tsx`): mock `setupDoctor` to return one error check with a fix → the fix text renders inside a `code` element and the summary reads "1 problem(s), 0 warning(s).".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; `cd ui && npx vitest run` and `npx tsc -p tsconfig.app.json --noEmit` green.
- [ ] **Step 5: Commit** `git commit -m "feat: setup doctor on the Health page, a 'check setup' link in the sync bar, and in collab_doctor"`.

---

### Task 11: Assemble the installable package, smoke-test it, retire the old bundle

**Files:**
- Create: `scripts/package.mjs`, `package/package.template.json`, `test/package.smoke.test.mts`
- Delete: `scripts/bundle.mjs`; remove the `"bundle"` script from root `package.json`
- Modify: root `package.json` (`"package": "node scripts/package.mjs"`), `.gitignore` (`dist-package/`), `README.md` (Install section)

**Interfaces:**
- Consumes: every built workspace; `build-info.json` (Task 4); `addon-manifest.json` (Task 5); `cli/dist/postinstall.js` (Task 8).
- Produces: `dist-package/collab/` (an npm-installable folder) and `dist-package/collab-mcp-collab-<version>.tgz` (from `npm pack`).

Package layout (paths inside `dist-package/collab/`):

```
package.json                  ← from package/package.template.json, version + deps filled in
addon-manifest.json           ← install root marker (Task 1)
build-info.json
cli/dist/**                   ← bin "collab" = cli/dist/bin.js
ui/dist/**
mcp/migrations/*.sql          ← released only; never mcp/migrations/staged
vendor/crsqlite/              ← empty; postinstall fills it
node_modules/@collab-mcp/core/{package.json,dist/**}
node_modules/@collab-mcp/courier/{package.json,dist/**}
node_modules/@collab-mcp/post-office/{package.json,dist/**}
node_modules/@collab-mcp/server/{package.json,dist/**}
node_modules/collab-mcp/{package.json,dist/**}
README.md, LICENSE (if present)
```

`package/package.template.json`:

```json
{
  "name": "@collab-mcp/collab",
  "version": "0.0.0",
  "description": "Collab: a shared, searchable notebook for people and AI agents, local-first with optional team sync.",
  "type": "module",
  "bin": { "collab": "./cli/dist/bin.js" },
  "scripts": { "postinstall": "node cli/dist/postinstall.js" },
  "engines": { "node": ">=20.9.0" },
  "dependencies": {},
  "bundleDependencies": ["@collab-mcp/core", "@collab-mcp/courier", "@collab-mcp/post-office", "@collab-mcp/server", "collab-mcp"],
  "files": ["addon-manifest.json", "build-info.json", "cli/dist", "ui/dist", "mcp/migrations", "vendor", "node_modules", "README.md"]
}
```

`scripts/package.mjs` steps (fail loudly on any missing input):
1. Require `build-info.json` and every `*/dist` folder to exist; else print "run npm run build first" and exit 1.
2. `rm -rf dist-package/collab`; create the layout above by copying (real files, never symlinks; workspaces are symlinked in `node_modules`, so copy from the workspace folders: `core/`, `courier/`, …, each `package.json` + `dist/`).
3. Copy `mcp/migrations/*.sql` only (no `staged/`). Create empty `vendor/crsqlite/.keep`.
4. Fill `package.json`: `version` from `build-info.json`; `dependencies` = union of the **third-party** runtime `dependencies` of all bundled workspaces (skip `@collab-mcp/*` and `collab-mcp`), with the highest declared range when two differ. Print the merged list.
5. Deny-list check over the whole output folder (carry over from `scripts/bundle.mjs`): any path matching `collab.db*`, `store.db*`, `.env`, `backups/`, `*.db-wal` → delete the output and exit 1 naming the file.
6. `npm pack` inside `dist-package/collab` → move the `.tgz` to `dist-package/`.

`test/package.smoke.test.mts` (skipped unless `COLLAB_PACKAGE_SMOKE=1`, because it builds and installs; the executor runs it once in Step 4):
- `npm run build && npm run package`.
- `npm install -g --prefix <tmp>/prefix <tgz>` with env `COLLAB_SKIP_ADDON=1` (offline-safe).
- The `collab` executable (`<prefix>/bin/collab` on Linux/macOS, `<prefix>/collab.cmd` on Windows) with env `COLLAB_DATA_DIR=<tmp>/data`, run from a temp cwd with **no repo above it**:
  - `--version` → exit 0.
  - `notebook new smoke` → exit 0; file exists under `<tmp>/data/notebooks/smoke/notebook.db`.
  - `doctor --json` → valid JSON; `install.addon` is `error` (skipped download) and its fix says `collab doctor --fix`; `notebook.choice` is `ok`.
  - `doctor --fix` with network available (only when `COLLAB_SMOKE_NETWORK=1`) → `install.addon` becomes `ok`.
- Assert the installed package contains no `collab.db`, `.env` or `store.db` anywhere.

README "Install" section (replace the clone-and-build instructions at the top; keep a "Working on collab itself" section below with the existing repo steps):

```markdown
## Install

Needs Node 20.9 or newer (Node 22 LTS recommended).

    npm install -g <package or release URL>
    collab notebook new my-team        # or: collab notebook adopt path/to/collab.db --name my-team
    claude mcp add collab -- collab mcp
    collab doctor

`collab doctor` checks everything and prints the exact fix for anything that's wrong.
Notebooks live in your user folder (Windows: %LOCALAPPDATA%\collab), never in the install folder.
A project picks its notebook with a `.collab` file containing `notebook = <name>`.
Settings for the web UI (PORT, GROQ_API_KEY, ...) go in `settings.env` in the same folder.
```

- [ ] **Step 1: Write `test/package.smoke.test.mts`** as described (guarded by `COLLAB_PACKAGE_SMOKE=1`).
- [ ] **Step 2: Run it, expect FAIL** (`COLLAB_PACKAGE_SMOKE=1 npx tsx --test test/package.smoke.test.mts`: no `scripts/package.mjs`).
- [ ] **Step 3: Implement** `scripts/package.mjs`, the template, the `.gitignore` line, the README section; delete `scripts/bundle.mjs` and its npm script.
- [ ] **Step 4: Run the smoke test, expect PASS.** Then the full suites: core, post-office, courier, cli, root (`bash -O globstar -c 'npx tsx --test test/**/*.test.mts'`), ui vitest. Record before/after counts.
- [ ] **Step 5: Commit** `git commit -m "feat: installable collab package (assembly + smoke test); retire bundle.mjs"`.

---

## Done means

- Every suite passes except the 4 golden failures that already fail on `collabv1` (search all / by module / by category, doctor; E-742, E-747). A new golden failure is a regression.
- The package smoke test passes on Linux in the run, and is listed for the user to run on Windows.
- `node cli/dist/bin.js doctor` on the build machine prints a report with all 7 groups.
- Nothing in this plan changed: the courier's config folder, `COLLAB_DB_PATH` behaviour, `.mcp.json` entries that use `node …/mcp/dist/server.js`, post-office data, migrations.
