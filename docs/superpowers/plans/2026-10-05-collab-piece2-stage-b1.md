# Collab piece 2, stage B1: projects and solo numbering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** you can create a solo project (`collab project create supporthub --code SH`), point a folder at it, and every note written there is numbered `SH-1, SH-2…` on the laptop, never waits for a post office and is never sent; everything that exists today (all `E-` notes, modules, sync) behaves exactly as before.

**Architecture:** migration 0009 adds a local `projects` table, `entries.series` + `entries.project_ulid` (through the existing CRR-alter path, proven by spike S3) and `dispatches.entry_ulid`. A note reference becomes `{ series, id }` (`NoteRef`): bare numbers, `#n` and `E-n` mean series `E`, so every existing reference keeps its meaning. Every lookup by bare number is restricted to series `E`. A new `core/src/projects.ts` owns projects; the folder's `.collab` file names the current project; writes, search and list default to it when it is set and behave as today when it isn't.

**Tech Stack:** TypeScript 5.3 ESM, better-sqlite3 + cr-sqlite, node:test + tsx, React + vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-collab-projects-design.md` (rules 1-5, 7, 8; P1-P5, P10; build order B1). Number-site inventory: `docs/superpowers/specs/2026-10-05-collab-join-spikes-verdict.md` on branch `collab-join-spikes` (`git show origin/collab-join-spikes:docs/superpowers/specs/2026-10-05-collab-join-spikes-verdict.md`), section "Inventory". Read both.

## Global Constraints

- **Rule 1, the hard one:** a notebook with no projects behaves byte-for-byte as before, apart from entry payloads gaining `series` (always `"E"`) and `project_ulid` (always `null`). Before Task 1, record the output of every golden test (root `test/golden` and `mcp/test/golden`) to a scratch folder; after every task, the diff against that baseline may only add those two keys. The 6 goldens already failing at baseline (root: search all / by module / by category, doctor; mcp: getModule, doctor) must fail with the same diff plus at most those two keys.
- Every lookup that takes a bare number (`ownerOf`, `getEntry`, the ref trigger, REST `?id=`, MCP `id`) resolves in series `E` only. A team or solo note is reached only with its series (`SH-12`).
- Series code: `^[A-Z][A-Z0-9]{1,7}$` (2-8 chars, starts with a letter), never `E`. Input is case-insensitive and stored upper-case.
- Parsed reference forms: `760`, `#760`, `E760`, `E-760`, `E-00760` → `{ series: "E", id: 760 }`; `SH-12`, `sh-12`, `SH-0012` → `{ series: "SH", id: 12 }`. Anything else → `null`. `formatEntryRef(id, series)` prints `E-00760` and `SH-12` (only `E` is zero-padded to 5, as today; project series are not padded).
- Solo projects: no network call while saving, ever; the courier never sends a note whose `project_ulid` is not NULL (team projects arrive in stage C).
- No post office change in this stage. No build commands (`npm run build`); `tsc --noEmit` and test runs are fine.
- Tests use temp folders only; every connection with cr-sqlite loaded runs `SELECT crsql_finalize()` before close (collab E-764).
- One commit per task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Bare number with clashing series:** `E-1` and `SH-1` both exist. `collab_get(1)`, `GET /api/collab/entry?id=1`, a ref `"1"` and `ownerOf(db, 1)` all reach `E-1`, even when `SH-1` has the lower ULID. (Task 2 + Task 1 tests.)
2. **Sync-enabled notebook, office unreachable, solo note tagged with a shared module** (e.g. `module: "portfolio"`): saves instantly, makes no network call, and the courier never sends it. (Task 4 tests.)
3. **`.collab` names a project that isn't in this notebook:** a clear error naming the file and suggesting `collab project list`, never a silent fall back to `E`. (Task 5 test.)
4. **Odd input:** `" sh-0012 "` → `SH-12`; `"SH12"`, `"S-1"`, `"1SH-2"`, `"SH-0"`, `"E-"` → null (and the SQL trigger agrees on every one). (Task 2 parity test.)
5. **Hard-deleted solo note:** its number is never handed out again. (Task 2 test.)

---

### Task 1: migration 0009 (projects, series, project_ulid, dispatches.entry_ulid; series-aware ref trigger)

**Files:**
- Create: `mcp/migrations/0009_projects.sql`
- Modify: `core/src/db.ts` (`CRR_ALTERS`, an `AFTER_MIGRATION` hook next to `BEFORE_MIGRATION`), `core/src/sync/enable.ts` (`trg_refs_fill_target_ulid` guarded SQL; export the guarded-trigger installer), `core/src/schema.ts` (`hasSeries(db)`)
- Test: `core/test/migration-0009.test.ts`, `core/test/ref-trigger-series.test.ts`

**Interfaces:**
- Produces: columns `entries.series TEXT NOT NULL DEFAULT 'E'`, `entries.project_ulid TEXT` (NULL = no project), `dispatches.entry_ulid TEXT`; table `projects`; `hasSeries(db): boolean` in `core/src/schema.ts`; `installGuardedTriggers(db)` exported from `core/src/sync/enable.ts`.

- [ ] **Step 1: Failing tests** `core/test/migration-0009.test.ts` (temp notebook via `getDb(path, { create: true })` + `migrate`; `closeDb()` in `finally`):
  - fresh notebook: `projects` exists with the columns below; `entries` has `series` (default `'E'`) and `project_ulid`; `dispatches` has `entry_ulid`; `latestMigration` = `0009_projects`.
  - a notebook migrated to 0008 with 3 notes, then to 0009: every note has `series = 'E'`, `project_ulid IS NULL`; FTS still finds them.
  - a **sync-enabled** 0008 notebook (use the helpers the S3 spike used: `enableSync` after migrate) migrates to 0009: `crsql_db_version()` unchanged by the migration (S3-1), all 8 of our triggers present, `trg_refs_fill_target_ulid` is the **guarded** variant (its SQL contains `crsql_internal_sync_bit`).
  `core/test/ref-trigger-series.test.ts`: on a 0009 notebook insert notes `E-1` (ulid B…), `SH-1` (ulid A…, lower) and `SH-12`; insert refs with `ref_value` `"1"`, `"#1"`, `"E-00001"` → `target_ulid` = E-1's; `"SH-12"`, `"sh-0012"` → SH-12's; `"SH12"`, `"S-1"`, `"X-1"` (no such series) → NULL. Run once on an unsynced and once on a sync-enabled notebook.
- [ ] **Step 2: Run, expect FAIL** (`cd core && npx tsx --test test/migration-0009.test.ts test/ref-trigger-series.test.ts`).
- [ ] **Step 3: Implement.**
  `mcp/migrations/0009_projects.sql` (no BEGIN/COMMIT: it runs inside the CRR-alter transaction like 0008):
  ```sql
  -- Collab piece 2 stage B1: projects with their own note series (spec P1).
  -- Runs inside crsql_begin_alter('entries') / crsql_commit_alter when entries is a CRR.
  ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';
  ALTER TABLE entries ADD COLUMN project_ulid TEXT;
  CREATE INDEX IF NOT EXISTS idx_entries_series_id ON entries (series, id);
  CREATE INDEX IF NOT EXISTS idx_entries_project ON entries (project_ulid);

  -- Local, never synced in B1 (team projects arrive in stage C).
  CREATE TABLE IF NOT EXISTS projects (
    ulid        TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE CHECK (code GLOB '[A-Z][A-Z0-9]*' AND length(code) BETWEEN 2 AND 8 AND code <> 'E'),
    mode        TEXT NOT NULL DEFAULT 'solo' CHECK (mode IN ('solo', 'team')),
    team        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects (lower(name));

  ALTER TABLE dispatches ADD COLUMN entry_ulid TEXT;

  DROP TRIGGER IF EXISTS trg_refs_fill_target_ulid;
  CREATE TRIGGER trg_refs_fill_target_ulid
  AFTER INSERT ON refs
  WHEN NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
  BEGIN
    UPDATE refs SET target_ulid = (
      SELECT e.ulid FROM entries e, (
        -- A project code (2-8 of A-Z/0-9, starting with a letter, before the first '-')
        -- is checked FIRST, so a code like E2 in 'E2-5' is not misread as legacy 'E2'.
        SELECT COALESCE(c, CASE
                 WHEN s GLOB '#[0-9]*' OR s GLOB 'E-[0-9]*' OR s GLOB 'E[0-9]*' OR (s <> '' AND s NOT GLOB '*[^0-9]*') THEN 'E'
               END) AS ser,
               CASE
                 WHEN c IS NOT NULL     THEN substr(s, length(c) + 2)
                 WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
                 WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
                 WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
                 ELSE s
               END AS d
          FROM (
            SELECT s, CASE
                     WHEN instr(s, '-') BETWEEN 3 AND 9
                      AND substr(s, 1, instr(s, '-') - 1) GLOB '[A-Z]*'
                      AND substr(s, 1, instr(s, '-') - 1) NOT GLOB '*[^A-Z0-9]*'
                     THEN substr(s, 1, instr(s, '-') - 1)
                   END AS c
              FROM (SELECT upper(trim(NEW.ref_value, ' ' || char(9,10,11,12,13,160))) AS s)
          )
      ) p
      WHERE p.ser IS NOT NULL
        AND p.d <> '' AND p.d NOT GLOB '*[^0-9]*' AND CAST(p.d AS INTEGER) > 0
        AND e.series = p.ser AND e.id = CAST(p.d AS INTEGER)
      ORDER BY e.ulid LIMIT 1
    )
    WHERE entry_ulid = NEW.entry_ulid AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
  END;

  INSERT INTO schema_migrations (version) VALUES ('0009_projects');
  ```
  In `core/src/db.ts`: add `"0009_projects": "entries"` to `CRR_ALTERS`; add an `AFTER_MIGRATION: Record<string, (db: DB) => void>` mirroring `BEFORE_MIGRATION`, called right after each migration is applied, with `"0009_projects": (db) => { if (isSyncEnabled(db)) installGuardedTriggers(db); }` (the migration created the unguarded trigger; a synced notebook needs the guarded one, E-643). In `enable.ts` give `trg_refs_fill_target_ulid` the same body with `WHEN crsql_internal_sync_bit() = 0 AND …` and export the loop that (re)creates `GUARDED_TRIGGERS_SQL` as `installGuardedTriggers(db)` (drop-if-exists then create each; `enableSync` calls it). `hasSeries(db)` = pragma check for `entries.series`, cached per DB like the neighbouring helpers.
- [ ] **Step 4: Run** the new tests (PASS), then core, mcp, root, post-office and courier suites. Goldens: compare with the baseline (Global Constraints).
- [ ] **Step 5: Commit** `feat(core): migration 0009 projects + entries.series/project_ulid; ref trigger reads series`.

---

### Task 2: note references with a series

**Files:**
- Modify: `core/src/ulid.ts` (`parseNoteRef`, `NoteRef`; keep `parseEntryRef`), `core/src/entry-ref.ts` (`formatEntryRef` padding rule), `core/src/entry-write.ts` (`ownerOf` E-only, `ownerOfRef`, `nextEntryNumber(db, series)`), `core/src/ops/get.ts` (`getEntry` E-only, `getEntryByRef`), `core/src/index.ts` (exports), `ui/src/format.ts` (mirror)
- Test: `core/test/note-ref.test.ts`, extend `core/test/entry-ref.test.ts`, `core/test/get-links.test.ts`, `ui/src/format.test.ts`

**Interfaces:**
- Consumes: `hasSeries(db)` (Task 1).
- Produces:
  ```ts
  // core/src/ulid.ts
  export interface NoteRef { series: string; id: number }
  export const SERIES_CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;
  export function parseNoteRef(value: string): NoteRef | null;
  // core/src/entry-ref.ts
  export function formatEntryRef(id: number | null | undefined, series?: string): string; // unchanged signature
  export function formatNoteRef(ref: NoteRef): string;
  // core/src/entry-write.ts
  export function ownerOf(db: DB, id: number): InsertedEntry | null;        // series 'E' only from 0009
  export function ownerOfRef(db: DB, ref: NoteRef): InsertedEntry | null;
  export function nextEntryNumber(db: DB, series?: string): number;         // default 'E'
  // core/src/ops/get.ts
  export function getEntryByRef(db: DB, ref: NoteRef): EntryFull | null;
  ```

- [ ] **Step 1: Failing tests.** `core/test/note-ref.test.ts`:
  ```ts
  const ok: Array<[string, NoteRef]> = [
    ['760', { series: 'E', id: 760 }], ['#760', { series: 'E', id: 760 }], ['E760', { series: 'E', id: 760 }],
    ['E-760', { series: 'E', id: 760 }], ['e-00760', { series: 'E', id: 760 }], [' \tE-7 ', { series: 'E', id: 7 }],
    ['SH-12', { series: 'SH', id: 12 }], ['sh-0012', { series: 'SH', id: 12 }], ['AB12CD34-1', { series: 'AB12CD34', id: 1 }],
    ['E2-5', { series: 'E2', id: 5 }],   // a code starting with E is a code, not legacy E
  ];
  const bad = ['', 'E-', 'SH12', 'S-1', '1SH-2', 'SH-0', 'ABCDEFGHI-1', 'SH-1x', 'SH--1', '0', '-1', 'E-SH-1'];
  ```
  plus round trips `parseNoteRef(formatNoteRef(r))` equals `r`; `parseEntryRef` unchanged for every old input and returns null for `SH-12`. `entry-ref.test.ts`: `formatEntryRef(12, 'SH') === 'SH-12'`, `formatEntryRef(12) === 'E-00012'`. In `get-links.test.ts` (0009 notebook): notes `E-1` and `SH-1` where SH-1 has the LOWER ulid → `ownerOf(db, 1)` and `getEntry(db, 1)` return E-1; `ownerOfRef(db, {series:'SH', id:1})`/`getEntryByRef` return SH-1; on a pre-0009 notebook `ownerOf` behaves as before. `nextEntryNumber`: with `E-5` and `SH-9` present, `nextEntryNumber(db)` = 6 and `nextEntryNumber(db, 'SH')` = 10; after hard-deleting `SH-10` the next `SH` is 11 (counter row `series:SH` in `local_counters`). UI `format.test.ts` mirrors the formatting cases.
  **Parity test** (same file): for every string in `ok` and `bad`, insert a ref with that `ref_value` on a 0009 notebook that has notes `E-760`, `E-7`, `SH-12`, `AB12CD34-1`, `E2-5` and assert the trigger resolved exactly when `parseNoteRef` returns non-null and to the matching note.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  ```ts
  export function parseNoteRef(value: string): NoteRef | null {
    const s = value.replace(TRIM_REF_RE, "").toUpperCase();
    const code = /^([A-Z][A-Z0-9]{1,7})-(\d+)$/.exec(s);   // checked first, like the SQL trigger
    const legacy = code ? null : /^(?:#|E-?)?(\d+)$/.exec(s);
    if (!code && !legacy) return null;
    const series = code ? code[1] : "E";
    const id = Number(code ? code[2] : legacy![1]);
    return Number.isSafeInteger(id) && id > 0 ? { series, id } : null;
  }
  ```
  (`E-SH-1` fails both patterns; `E-5` can't be a code because a code has 2+ characters; `E2-5` is project `E2`, note 5, in TS and SQL alike.) `formatEntryRef(id, series = "E")`: `E` keeps `padStart(5, "0")`, other series print the bare number. `ownerOf`: when `hasSeries(db)`, add `AND series = 'E'`. `ownerOfRef`: same query with `series = ?`; before 0009 only `series === 'E'` resolves. `getEntry`: add `AND series = 'E'` when `hasSeries`; `getEntryByRef` the series form; both reuse `assemble()`. `nextEntryNumber(db, series = "E")`: counter name `entry_number` for `E` (unchanged), `series:<CODE>` otherwise; `MAX(id)` filtered `WHERE series = ?` when `hasSeries`.
- [ ] **Step 4: Run** core, mcp, root, ui suites; goldens vs baseline.
- [ ] **Step 5: Commit** `feat(core): note references carry a series (parseNoteRef, ownerOfRef, getEntryByRef); bare numbers mean E`.

---

### Task 3: projects in core

**Files:**
- Create: `core/src/projects.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/projects.test.ts`

**Interfaces:**
- Consumes: `SERIES_CODE_RE` (Task 2), `newUlid`.
- Produces:
  ```ts
  export interface Project { ulid: string; name: string; code: string; mode: "solo" | "team"; team: string | null; created_at: string }
  export class ProjectClashError extends Error {}      // message says what clashes and both fixes (P10)
  export class ProjectNotFoundError extends Error {}
  export function createProject(db: DB, args: { name: string; code: string; mode?: "solo" }): Project;
  export function renameProject(db: DB, codeOrUlid: string, newName: string): Project;
  export function listProjects(db: DB): Project[];                 // by name
  export function findProject(db: DB, codeOrUlid: string): Project | null;  // code case-insensitive, or exact ulid
  ```
- [ ] **Step 1: Failing tests:** create `supporthub`/`sh` → code stored `SH`, mode `solo`, ulid valid; second create with name `SupportHub` → `ProjectClashError` whose message contains `rename` and `different notebook`; same for code `SH`; codes `E`, `S`, `1AB`, `ABCDEFGHI` rejected with a message naming the rule; `mode: "team"` rejected in B1 ("team projects arrive with stage C"); rename keeps ulid and code, clash-checks the new name; `findProject(db, 'sh')` and by ulid; on a pre-0009 notebook every function throws "needs migration 0009".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (plain SQL against `projects`; `updated_at = datetime('now')` on rename; clash check before insert with `lower(name) = lower(?) OR code = ?` so the message can say which one clashed; the UNIQUE indexes are the backstop).
- [ ] **Step 4: Run** core suite.
- [ ] **Step 5: Commit** `feat(core): projects (create, rename, list, find) with clash messages`.

---

### Task 4: writing a note into a solo project; the courier never sends project notes

**Files:**
- Modify: `core/src/entry-write.ts` (`EntryRowInput.series`, `.project_ulid`; `insertEntryRow`), `core/src/ops/add.ts` (`AddEntryArgs.project`, `addEntry`, `addEntryAsync`, result), `courier/src/engine.ts` (`push` filter)
- Test: `core/test/add-project.test.ts`, `courier/test/project-never-sent.test.ts`

**Interfaces:**
- Consumes: `findProject` (Task 3), `nextEntryNumber(db, series)` (Task 2).
- Produces: `AddEntryArgs.project?: string` (code or ulid); `AddEntryResult` gains `series: string` and `project: { code: string; name: string; mode: string } | null`. Task 5 adds the default from `.collab`; this task uses only the explicit argument.

- [ ] **Step 1: Failing tests.** `add-project.test.ts`: `addEntryAsync(db, { …, project: 'SH' })` on an unsynced notebook → `series 'SH'`, `id 1`, row has `project_ulid`; second note `SH-2`; unknown project → `ProjectNotFoundError` listing known codes. On a **sync-enabled** notebook with `setAllocator` set to an allocator that throws (and counts calls): a project note saves, allocator call count 0; a note with no project still goes through the allocator exactly as today (and still refuses to save when it throws, E-708). `courier/test/project-never-sent.test.ts` (use the courier test helpers that already build a laptop + office): module `portfolio` shared by the office; add one `E` note and one `SH` note, both `module: 'portfolio'`; after a push the office holds the `E` note and has no change whose pk is the `SH` note's ulid (check `po_deliveries`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `addEntryAsync`: resolve `args.project` first; if a project is given, call `addEntry(db, { ...args, series: p.code, project_ulid: p.ulid })` **before** the sync branch (no allocator). In `insertEntryRow` (0006+ branch): when `row.series` is set and not `E`, `id = nextEntryNumber(db, row.series)`, skip the `SyncAllocationRequiredError` check, and add `series`/`project_ulid` to the inserted columns; when `hasSeries` and no series, insert nothing extra (default `E`). In the courier `push` loop, skip any change whose note has `project_ulid IS NOT NULL` (extend the `placeOf` memo to read `module, project_ulid` in one query); apply the same skip in the backfill and moved-note passes below it.
- [ ] **Step 4: Run** core, courier, post-office, mcp suites.
- [ ] **Step 5: Commit** `feat: notes in a solo project are numbered locally (SH-n), never wait for or reach a post office`.

---

### Task 5: the current project (`.collab`), and the `collab project` commands

**Files:**
- Modify: `core/src/db.ts` (`findCollabFile` reads `project = <ulid>`; walk starts at `CLAUDE_PROJECT_DIR` when set, spec J15a), `core/src/projects.ts` (`currentProject`), `core/src/ops/add.ts` (default project), `cli/src/main.ts` (+ a new `cli/src/project.ts`, following `cli/src/notebook.ts`)
- Test: `core/test/current-project.test.ts`, `cli/test/project.test.ts` (follow the existing CLI test layout; if `cli/test` doesn't exist, use the folder the `notebook` command's tests live in)

**Interfaces:**
- Produces:
  ```ts
  export function findCollabFile(startDir: string): { file: string; name: string; project: string | null } | null; // project = ulid or null
  export function currentProject(db: DB, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Project | null;     // throws ProjectNotFoundError naming the .collab file
  ```
  `collab project create <name> --code <CODE>`, `collab project rename <code> <new name>`, `collab project list`, `collab project use <code>` (writes/updates `project = <ulid>  # <CODE> <name>` in the nearest `.collab`, creating `.collab` in the current folder with `notebook = <current notebook name>` when none exists).

- [ ] **Step 1: Failing tests:** `.collab` with `notebook = x` and `project = <ulid>` → `currentProject` returns it; with only `notebook =` → null (today's behaviour); with a ulid not in the notebook → `ProjectNotFoundError` whose message names the file and `collab project list`; `CLAUDE_PROJECT_DIR=<dir with .collab>` while cwd is elsewhere → that `.collab` wins; a `.collab` with only `project =` and no `notebook =` keeps today's error text. `addEntryAsync` with no `project` arg inside a folder whose `.collab` names `SH` → `SH-n`; with `project: 'none'` → an `E` note (explicit escape). CLI: create/list/rename/use round trip in a temp folder; `use` preserves other lines and comments in `.collab`; `create` with a clash prints the P10 message and exits non-zero.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep `resolveDbPath`'s rules and messages; only the start folder changes (`env.CLAUDE_PROJECT_DIR ?? cwd`). `currentProject` re-reads the `.collab` each call (it's small, and the MCP server is long-lived). `project: 'none'` is the only reserved word.
- [ ] **Step 4: Run** core, cli, mcp, root suites.
- [ ] **Step 5: Commit** `feat: the folder's .collab names the current project; collab project create/rename/list/use`.

---

### Task 6: MCP tools take series references, default to the current project, and say where they are

**Files:**
- Modify: `mcp/src/server.ts`, `core/src/ops/search.ts` (`SearchArgs.project_ulid`), the list-recent op, `mcp/test/golden/__snapshots__/*` (regenerate with the repo's golden-update mechanism)
- Test: `mcp/test/project-tools.test.ts`

**Interfaces:**
- Consumes: `parseNoteRef`, `ownerOfRef`, `getEntryByRef` (Task 2); `currentProject` (Task 5).
- Produces: every tool parameter that takes a note number (`collab_get.id`, `collab_update.id`, `collab_update_refs.id`, `collab_module_set_hub.id`, `collab_supersede.ids`/`by`) accepts `number | string` (`z.union([z.number().int().min(1), z.string()])`); numbers mean `E`; a string that `parseNoteRef` rejects returns a tool error naming the accepted forms. `collab_add` gains `project?: string` (code, ulid or `"none"`). `collab_search`, `collab_list_recent` and `collab_module_get` (its recent decisions/gotchas/handoffs lists) gain `scope?: "project" | "all"`: default `"project"` when a current project exists, else today's behaviour (`"all"`).

- [ ] **Step 1: Failing tests:** with `E-1` and `SH-1`: `collab_get({ id: 1 })` → E-1, `collab_get({ id: "SH-1" })` → SH-1, `collab_get({ id: "SH1" })` → error text listing forms; `collab_supersede({ ids: ["SH-1"], by: 1 })` sets `superseded_by_ulid` to E-1's ulid (writers pass the ULID, not only the integer); with a current project `SH`: `collab_search({ query: "" })` returns only SH notes, `scope: "all"` returns both; every printed number uses `formatEntryRef(id, series)`; `collab_add` and `collab_search` answers start with a status line `project: SH supporthub (solo)` or `project: none (E series)` (rule 8).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** One helper in `server.ts`, `resolveRefArg(db, v: number | string): InsertedEntry` (throws the tool error), used by every tool above; `supersede` callers pass ulids. Search/list: `project_ulid` filter `e.project_ulid = ?` added to the WHERE. Entry payloads include `series` and `project_ulid`.
- [ ] **Step 4: Run** mcp + root suites; regenerate goldens; the diff vs baseline may only add `series`/`project_ulid` and the status line in text outputs (list them in the commit message).
- [ ] **Step 5: Commit** `feat(mcp): tools take SH-12 style references, default to the current project, print a status line`.

---

### Task 7: REST routes and the web UI

**Files:**
- Modify: `server/src/tools/collab.ts`, `server/src/tools/*` (the 16 routes in the inventory), `ui/src/api/client.ts`, `ui/src/store/ui.ts`, `ui/src/App.tsx` (`/merge/:ref`), `ui/src/pages/Merge.tsx`, `ui/src/pages/NeedsMerge.tsx`, `ui/src/components/EntryDrawer.tsx`, `ui/src/components/CommandPalette.tsx`, and the pages that print numbers (Knowledge, Dashboard, Modules, Health, DraftCard)
- Test: `test/api.series.test.mts`, `ui/src/components/EntryDrawer.series.test.tsx`, `ui/src/pages/Merge.series.test.tsx`

**Interfaces:**
- Consumes: Task 2 functions.
- Produces: REST `?id=` and body `id`/`ids`/`by` accept `"SH-12"` or numbers (numbers = `E`); 400 with the accepted forms on a bad string. Payloads include `series`. UI opens notes by `{ ulid }` (stage A) or by ref string; the merge route is `/merge/:ref` and `/merge/12` keeps working.

- [ ] **Step 1: Failing tests:** `GET /api/collab/entry?id=SH-1` → SH-1, `?id=1` → E-1, `?id=SH1` → 400; supersede via REST with string refs; UI: a note `{ series: 'SH', id: 12 }` renders `SH-12` in the drawer, palette and Knowledge list; supersede prompt accepts `SH-12`; `/merge/SH-3` and `/merge/3` load the right note.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (one `parseRefParam` helper in the server, mirrored by the UI's `format.ts`).
- [ ] **Step 4: Run** root suite, `cd ui && npx vitest run`, `cd ui && npx tsc -p tsconfig.app.json --noEmit`.
- [ ] **Step 5: Commit** `feat: REST and web UI read and print SH-12 style references`.

---

### Task 8: scripts, dispatches by ULID, doctor

**Files:**
- Modify: `mcp/src/scripts/{log-collab,manual-search,module-card,seed,sweep-deps,parse-codex-output,add-log}.ts`, `core/src/ops/doctor.ts`
- Test: `core/test/doctor-projects.test.ts`, `mcp/test/parse-codex-output.test.ts` (extend the existing one if present)

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `parse-codex-output` writes `dispatches.entry_ulid` alongside `entry_id`; dispatch readers (`GET /api/collab/dispatches`) join by `entry_ulid` when set. Doctor: `data.duplicate_entry_ids` groups by `(series, id)`; new checks `projects.current` (ok/none/✗ with the `.collab` path when it names an unknown project), `projects.orphan_notes` (✗ when `project_ulid` names no project), `projects.series_mismatch` (✗ when a note's series ≠ its project's code).

- [ ] **Step 1: Failing tests:** `E-1` + `SH-1` → no duplicate warning; two `E-1` → warning as today; each new doctor check's ok and failing case; a parsed Codex output with entry `SH-3` writes that note's ulid.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; scripts print with `formatEntryRef(id, series)` and take string refs where they take a number today.
- [ ] **Step 4: Run** core, mcp, root suites; goldens vs baseline (doctor goldens may gain only the 3 new checks: list them in the commit).
- [ ] **Step 5: Commit** `feat: scripts and dispatches follow notes by ULID; doctor checks projects and (series, id) duplicates`.

---

## After the last task (by the controller, not a subagent task)

1. Windows suites via a background subagent (CLAUDE.md), compact summary.
2. **Rule 1 on real data:** copy the real notebook (`internal-tools/collab.db` + `-wal`) to a temp folder, run `migrate` on the copy, and compare before/after for 20 random `E-` notes (`getEntry`), `searchEntries` for 5 queries and `doctor` output: identical apart from `series`/`project_ulid` and the 3 new doctor checks. The real file is never opened for writing.
3. Merge into `collabv1`; the user decides when NAVEEN's main checkout is rebuilt.
