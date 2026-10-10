# Collab piece 2, stage C: team projects (one office), pending notes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In one notebook you can work in a solo project (`P1-1`, numbered on the laptop, never sent, never touches an office) and in a team project (`SH-1`, numbered by the office, sent only to that office) at the same time. A down office never stops a save: team notes and `E` notes are saved at once as **pending** and get their numbers when the office is reachable again. Two laptops (NAVEEN + Rinku) see the same team project and the same `SH-n` numbers.

**Architecture:** The office gains a team-project list (`po_projects`) and one counter per series (`po_series_counters`, `po_series_allocations`). `POST /v1/allocate` takes a `series` and echoes it back, so a laptop can never take an `E` number from an old office by mistake. On the laptop, a team or shared-`E` note that can't get its number in one quick try is written with `id = NULL` (pending). The courier numbers pending notes, then pushes. Once a note is numbered, the courier sends the whole note, so the office never gets a hollow one. Which notes get sent is decided in ONE core function (`sendTargetOf`), used by both the courier and the status count. No notebook migration: `projects.mode/team` (0009) and nullable `entries.id` (0006) already exist.

**Tech Stack:** TypeScript 5.3 ESM, better-sqlite3 + cr-sqlite, Node https/SSE, node:test + tsx, React + vitest (format mirror only).

**Spec:** `docs/superpowers/specs/2026-10-05-collab-projects-design.md` (rules 4-6, 8; P5 team half, P6, P7, P9, P10; build order C). Decisions that amend it: collab **E-819** (finish development before sharing; Rinku = test laptop) and **E-820** (one office per notebook; the office keeps the project list; any member creates or promotes; `E` notes go pending too, which replaces E-708's refusal; Make-solo is a D button). Read the spec and both entries.

## Global Constraints

- **Solo is untouched:** a solo-project note never makes a network call and is never sent, sharing on or off, office up or down. `courier/test/project-never-sent.test.ts` must stay green unchanged.
- **Rule 4:** a team-project note is never numbered on a laptop. Its number comes from the office (`/v1/allocate` with its series), or it stays pending (`id IS NULL`).
- **Rule 5 / P7:** a note is sent only if (a) its project is a team project of this notebook's office, or (b) it has no project and its primary module is shared (today's path). A team note is never sent while it is pending.
- **E-820 #4:** saving is never refused because of the office. `PostOfficeUnreachableError` and `SyncAllocationRequiredError` stop being thrown by any save path. The tests asserting them (`core/test/sync-prep.test.ts:145,152` and the refuse-to-save cases there) are rewritten to assert pending instead. This is an intended behaviour change, so name it in the commit message.
- **One office per notebook:** the existing single set of `SYNC_KEYS` / `COURIER_KEYS`. `projects.team` for a team project = that office's `po_fingerprint` (stable across address changes, E-767).
- **Old/new mix:** a new laptop and an old office must never mislabel a number. The allocator rejects any answer whose `series` is not the one it asked for (non-retriable). A new office answering an old laptop (no `series` in the request) behaves exactly as today (`E`).
- Display: `formatEntryRef(null, "SH")` = `SH-pending` (core `core/src/entry-ref.ts` and mirror `ui/src/format.ts`). `E-?` becomes `E-pending`. Update the two existing tests that assert `E-?`.
- No notebook migration in this stage (`KNOWN_MIGRATIONS` stays at 0009). The office's new tables are `CREATE TABLE IF NOT EXISTS` in `PO_SCHEMA`.
- No build commands (`npm run build`). `tsc --noEmit` and test runs are fine. Per CLAUDE.md, test runs go to a background subagent that returns pass/fail counts plus failures.
- Tests use temp folders only; every cr-sqlite connection runs `SELECT crsql_finalize()` before close (E-764).
- Work in a new worktree `../wt-collab-stage-c` on branch `collab-piece2-stage-c` off `collabv1` (`d2af25c`). One commit per task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge into the main checkout without the E-793 sequence (backup, stop all collab processes, merge, rebuild, restart).
- Not needed with one office: per-connection bookmarks (spike verdict item 1) and group-safe paging (E-772). Numbering changes one cell, and the whole-note resend reads every cell.
- Baseline before Task 1 (record it): core 334/0, courier 43/0, post-office 42/0, mcp 14/14.

## Review Focus

1. **Pending note numbered after an earlier push skipped it:** the note was created pending (push at db_version 10 skipped it and moved the bookmark), then numbered at db_version 12. The office must receive the WHOLE note (title, summary, body, refs, modules, revisions), not just the `id` cell. Without this, Rinku gets a hollow `SH-3` with an empty title (S2-5b). (Task 4 test.)
2. **Old office, new laptop:** the office ignores `series` and returns an `E` number. The laptop must not store `SH-<E number>`. The note stays pending, and status says "update the post office". (Task 2 test.)
3. **Answer lost after the office allocated:** saved pending with ulid U, then the courier asks again with the same U and gets the SAME number. Never two numbers for one note, never one number for two notes (E-713). (Tasks 1 + 4 tests.)
4. **Rinku edits a team note before her courier learned the project exists:** the edit must still be sent. Pull refreshes the project list when a pulled note names an unknown project. Once the project is known, it is not yet in `backfilled_projects`, so the courier sends every own change of its notes, including that early edit. The sent-bookmark is never pinned: a pinned bookmark grows a resend backlog forever when a note can never be numbered. (Tasks 3 + 4 tests.)
5. **Code clash on the receiving laptop:** Rinku already has a solo `SH` when NAVEEN creates team `SH`. Her solo project is never touched, the team project is not created, the clash is recorded, and doctor shows ✗ with the fix ("copy your solo SH notes into another code; B2"). Her solo `SH-1` keeps resolving to her own note. (Tasks 4 + 6 tests.)

---

### Task 1: office: per-series numbering and the team-project list

**Files:**
- Modify: `post-office/src/store.ts` (PO_SCHEMA + new functions), `post-office/src/server.ts` (routes + `projects` ring)
- Test: `post-office/test/projects.test.ts` (new), `post-office/test/server.test.ts` (allocate echo)

**Interfaces:**
- Produces (store):
  - `allocate(db, ulid, deviceId, series = "E"): number`. `E` uses today's `po_allocations` and counter unchanged; any other series uses `po_series_allocations` + `po_series_counters` and must be a registered project code, else `StoreError(…, 404)`.
  - `registerProject(db, p: { ulid: string; name: string; code: string; seed: number }): OfficeProject`. Idempotent for the same ulid+code; refuses another ulid with the same code or name (case-insensitive) with `StoreError(…, 409)`. `seed` (integer ≥ 0) = the highest number already used in that series (promote, P9); new projects send 0.
  - `listOfficeProjects(db): OfficeProject[]`, where `OfficeProject = { ulid; name; code; created_at }`.
- Produces (HTTP):
  - `POST /v1/allocate {ulid, series?}` → `200 {id, series}`
  - `GET /v1/projects` → `200 {projects: OfficeProject[]}`
  - `POST /v1/projects {ulid, name, code, seed}` → `200 {project}` | `409 {error}`, then ring `projects`.

- [ ] **Step 1: Failing tests** `post-office/test/projects.test.ts` (use `tempStore()` from `helpers.ts`):
  - `registerProject` then `allocate(db, U1, 'd', 'SH')` = 1, `allocate(…U2…'SH')` = 2, and `allocate(…U3…)` (E) continues today's counter (the seed passed to `tempStore`). Series counters are independent.
  - Idempotency: `allocate(db, U1, 'd', 'SH')` twice returns the same number, and the counter moves once.
  - The same ulid asked for in a different series → `StoreError` 409 ("this note was already numbered SH-1").
  - Unknown series `XX` → `StoreError` 404.
  - Seed: `registerProject({…code:'NV', seed: 7})` → first `NV` number is 8.
  - Clash: same code with a different ulid → 409; same name in other case → 409; the exact same ulid/code/name again → returns the existing row (idempotent).
  - `listOfficeProjects` returns them ordered by code.
  - `server.test.ts`: `POST /v1/allocate {ulid}` answers `{id, series:'E'}`; `GET /v1/projects` lists; `POST /v1/projects` rings `projects` to other listeners (use the existing SSE helper in that file).
- [ ] **Step 2: Run, expect FAIL**: `cd post-office && npx tsx --test test/projects.test.ts test/server.test.ts`.
- [ ] **Step 3: Implement.** Append to `PO_SCHEMA`:
  ```sql
  -- Stage C: team projects of this office (spec P1/P9) and their own numbering.
  CREATE TABLE IF NOT EXISTS po_projects (
    ulid       TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    code       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_po_projects_name ON po_projects (lower(name));
  CREATE TABLE IF NOT EXISTS po_series_counters (
    series TEXT    NOT NULL PRIMARY KEY,
    value  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS po_series_allocations (
    ulid       TEXT    NOT NULL PRIMARY KEY,
    series     TEXT    NOT NULL,
    id         INTEGER NOT NULL,
    device_id  TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (series, id)
  );
  ```
  In `store.ts`:
  ```ts
  const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;
  export interface OfficeProject { ulid: string; name: string; code: string; created_at: string }

  export function allocate(db: Store, ulid: unknown, deviceId: string | null, series = "E"): number {
    if (typeof ulid !== "string" || !ULID_RE.test(ulid)) throw new StoreError(`not a ULID: ${String(ulid).slice(0, 40)}`);
    if (series === "E") {
      return db.transaction(() => {
        const other = db.prepare(`SELECT series, id FROM po_series_allocations WHERE ulid = ?`).get(ulid) as { series: string; id: number } | undefined;
        if (other) throw new StoreError(`this note was already numbered ${other.series}-${other.id}`, 409);
        const hit = db.prepare(`SELECT id FROM po_allocations WHERE ulid = ?`).get(ulid) as { id: number } | undefined;
        if (hit) return hit.id;
        const id = nextNumber(db);
        setMeta(db, "counter", String(id));
        db.prepare(`INSERT INTO po_allocations (ulid, id, device_id) VALUES (?, ?, ?)`).run(ulid, id, deviceId);
        return id;
      }).immediate();
    }
    return db.transaction(() => {
      if (!db.prepare(`SELECT 1 FROM po_projects WHERE code = ?`).get(series)) {
        throw new StoreError(`no team project with code ${series} on this post office`, 404);
      }
      const hit = db.prepare(`SELECT series, id FROM po_series_allocations WHERE ulid = ?`).get(ulid) as { series: string; id: number } | undefined;
      if (hit) {
        if (hit.series !== series) throw new StoreError(`this note was already numbered ${hit.series}-${hit.id}`, 409);
        return hit.id;
      }
      if (db.prepare(`SELECT 1 FROM po_allocations WHERE ulid = ?`).get(ulid)) {
        throw new StoreError("this note was already given an E number", 409);
      }
      const row = db.prepare(`UPDATE po_series_counters SET value = value + 1 WHERE series = ? RETURNING value`).get(series) as { value: number };
      db.prepare(`INSERT INTO po_series_allocations (ulid, series, id, device_id) VALUES (?, ?, ?, ?)`).run(ulid, series, row.value, deviceId);
      return row.value;
    }).immediate();
  }

  export function registerProject(db: Store, p: { ulid: unknown; name: unknown; code: unknown; seed?: unknown }): OfficeProject {
    const ulid = String(p.ulid ?? ""), name = String(p.name ?? "").trim(), code = String(p.code ?? "").trim().toUpperCase();
    const seed = p.seed === undefined ? 0 : Number(p.seed);
    if (!ULID_RE.test(ulid)) throw new StoreError("a project needs a ULID");
    if (!name) throw new StoreError("a project needs a name");
    if (code === "E" || code === "NONE" || !CODE_RE.test(code)) throw new StoreError(`project code "${code}" is not valid`);
    if (!Number.isInteger(seed) || seed < 0) throw new StoreError("seed must be a whole number >= 0");
    return db.transaction(() => {
      const same = db.prepare(`SELECT ulid, name, code, created_at FROM po_projects WHERE ulid = ?`).get(ulid) as OfficeProject | undefined;
      if (same) {
        if (same.code !== code) throw new StoreError(`project ${ulid} is already registered with code ${same.code}`, 409);
        return same;
      }
      const byCode = db.prepare(`SELECT name FROM po_projects WHERE code = ?`).get(code) as { name: string } | undefined;
      if (byCode) throw new StoreError(`this team already has a project with code ${code} ("${byCode.name}")`, 409);
      const byName = db.prepare(`SELECT code FROM po_projects WHERE lower(name) = lower(?)`).get(name) as { code: string } | undefined;
      if (byName) throw new StoreError(`this team already has a project named "${name}" (${byName.code})`, 409);
      db.prepare(`INSERT INTO po_projects (ulid, name, code) VALUES (?, ?, ?)`).run(ulid, name, code);
      db.prepare(`INSERT INTO po_series_counters (series, value) VALUES (?, ?)`).run(code, seed);
      return db.prepare(`SELECT ulid, name, code, created_at FROM po_projects WHERE ulid = ?`).get(ulid) as OfficeProject;
    }).immediate();
  }

  export function listOfficeProjects(db: Store): OfficeProject[] {
    return db.prepare(`SELECT ulid, name, code, created_at FROM po_projects ORDER BY code`).all() as OfficeProject[];
  }
  ```
  In `server.ts`: `/v1/allocate` reads `const series = b?.series === undefined ? "E" : String(b.series)`, calls `allocate(o.store, b?.ulid, me.device_id, series)` and answers `{ id, series }`. Add:
  ```ts
  case "GET /v1/projects":
    return send(res, 200, { projects: listOfficeProjects(o.store) });
  case "POST /v1/projects": {
    const b = await readJson(req, maxBody);
    const project = registerProject(o.store, b ?? {});
    ring("projects", { code: project.code });
    log(`${me.name}: team project ${project.code} (${project.name}) registered`);
    return send(res, 200, { project });
  }
  ```
- [ ] **Step 4: Run, expect PASS**, plus the whole post-office suite (42 + new, 0 failing).
- [ ] **Step 5: Commit** `feat(post-office): team projects list and per-series numbering (stage C)`.

---

### Task 2: laptop: pending saves (team and E), series-aware allocator

**Files:**
- Modify: `core/src/entry-write.ts` (`EntryRowInput.pending`, the series branch, the E-with-sync branch), `core/src/ops/add.ts` (`AddEntryResult`, `addEntryAsync`), `core/src/sync/allocator.ts` (`Allocator.allocate(ulid, series)`, one-try policy), `core/src/sync/http-allocator.ts` (send + verify series), `core/src/entry-ref.ts` + `ui/src/format.ts` (`-pending`), `mcp/src/server.ts` (add text), `server/src/tools/collab.ts` (REST add answer)
- Test: `core/test/pending-save.test.ts` (new), `core/test/sync-prep.test.ts` (rewrite refusal cases), `core/test/sync-http-allocator.test.ts` (series echo), `core/test/entry-ref.test.ts`, `ui/src/format.test.ts`

**Interfaces:**
- Consumes: Task 1 HTTP `/v1/allocate {ulid, series} → {id, series}`.
- Produces:
  - `Allocator.allocate(ulid: string, series: string): Promise<number>`
  - `AddEntryResult.id: number | null` and `AddEntryResult.pending: boolean` (true ⇔ `id === null`), plus `AddEntryResult.ulid: string` and `AddEntryResult.pendingReason?: string`
  - `EntryRowInput.pending?: boolean`, `EntryRowInput.pendingUlid?: string` (and `AddEntryArgs.pendingUlid`, passed through by `addEntry`)
  - `export const SAVE_ATTEMPT: RetryPolicy = { attempts: 1, timeoutMs: 1500, delaysMs: [] }`
  - `export function isTeamProject(p: Project | null): boolean` in `core/src/projects.ts`

- [ ] **Step 1: Failing tests** `core/test/pending-save.test.ts` (temp notebook, `enableSync`, `setAllocator(fake)`; `setAllocator(null)` in `finally`):
  - **Office down, E note:** fake allocator throws → `addEntryAsync` resolves `{ id: null, pending: true, series: 'E' }`. The row exists with `id IS NULL`, FTS finds it, and `pendingReason` mentions the error.
  - **Office down, team note:** a project row inserted directly with `mode='team', team='fp'` (Task 5 adds the API) → resolves `{ id: null, pending: true, series: 'SH' }`. `local_counters` has no `series:SH` row (rule 4: no local number).
  - **Office up, team note:** fake returns 5 for `('U', 'SH')` → `{ id: 5, pending: false }`, and the fake saw `series === 'SH'`.
  - **Solo note, sharing on, office down:** fake is never called; numbered `P1-1` (regression of B1).
  - **One try only:** a fake that fails once then succeeds is called exactly once, and the note is pending (the courier retries later).
  - **Synchronous `addEntry` on a shared notebook** (rollup/archive path) saves an `E` note pending instead of throwing.
  - `sync-http-allocator.test.ts`: a fake office answering `{id: 3}` with no `series`, or `{id:3, series:'E'}` to an `SH` request, makes `HttpAllocator.allocate` throw with `retriable: false` and a message containing "update the post office". `{id:3, series:'SH'}` → 3.
  - `entry-ref.test.ts` / `ui/src/format.test.ts`: `formatEntryRef(null)` = `E-pending`, `formatEntryRef(null, 'SH')` = `SH-pending`.
  - `sync-prep.test.ts`: the cases asserting `SyncAllocationRequiredError` / refuse-to-save now assert a pending row and no throw.
- [ ] **Step 2: Run, expect FAIL**: `cd core && npx tsx --test test/pending-save.test.ts test/sync-prep.test.ts test/sync-http-allocator.test.ts test/entry-ref.test.ts`.
- [ ] **Step 3: Implement.**
  `core/src/projects.ts`:
  ```ts
  export function isTeamProject(p: Project | null): boolean { return !!p && p.mode === "team"; }
  ```
  `core/src/entry-write.ts`, replacing the series branch and the `isSyncEnabled` throw in `insertEntryRow`:
  ```ts
  if (row.series !== undefined && row.series !== "E") {
    if (!hasSeries(db)) throw new Error("[collab] writing into a project needs migration 0009");
    // Team project: the number comes from the post office (assigned) or later
    // from the courier (pending, id NULL). Never a local number (rule 4).
    // Solo project: numbered here, never sent (B1).
    const ulid = row.assigned?.ulid ?? row.pendingUlid ?? newUlid();
    const id = row.assigned ? row.assigned.id : row.pending ? null : nextEntryNumber(db, row.series);
    cols.push("ulid", "author", "id", "series", "project_ulid");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id, series: row.series, project_ulid: row.project_ulid ?? null });
    return { id, ulid };
  }
  if (hasUlidPrimaryKey(db)) {
    if (row.assigned) { /* unchanged */ }
    const ulid = row.pendingUlid ?? newUlid();
    // Shared notebook: E numbers come only from the post office. Without one
    // in hand the note is saved pending and the courier numbers it (E-820).
    const id = isSyncEnabled(db) ? null : nextEntryNumber(db);
    cols.push("ulid", "author", "id");
    run(db, cols, { ...values, ulid, author: resolveAuthor(), id });
    return { id, ulid };
  }
  ```
  `InsertedEntry.id` becomes `number | null`. Fix the callers `tsc --noEmit` flags: `insertRefs`/`insertEntryModules` bind `owner.id`, and `entry_id` is a write-only label at 0006+, so `null` is fine there.
  `addEntry` (sync) derives `pending` itself: `pending: isTeamProject(project) && !a.assigned`. The result carries `id: owner.id`, `ulid: owner.ulid`, `pending: owner.id === null`.
  `addEntryAsync`, after resolving the project:
  ```ts
  const project = resolveProjectArg(db, args); // existing helper in add.ts; check it returns the Project (or null)
  if (project && !isTeamProject(project)) return addEntry(db, args);   // solo: never the office
  if (!project && !isSyncEnabled(db)) return addEntry(db, args);       // unshared notebook: as today
  const series = project ? project.code : "E";
  const allocator = resolveAllocator(db);
  const ulid = newUlid();
  if (!allocator) return withReason(addEntry(db, { ...args, pendingUlid: ulid }), "no post office connection is configured on this machine");
  try {
    const id = await allocateWithRetry(allocator, ulid, series, SAVE_ATTEMPT);
    return addEntry(db, { ...args, assigned: { ulid, id } });
  } catch (e) {
    // Saving never waits on the office (rule 6, E-820): keep the SAME ulid so
    // the courier's retry gets the number the office may already have given (E-713).
    return withReason(addEntry(db, { ...args, pendingUlid: ulid }), (e as Error).message);
  }
  ```
  Add `pendingUlid?: string` to `AddEntryArgs` (internal): `insertEntryRow` uses it as the ulid when `id` is null. **This matters:** a lost answer must be retried with the same ulid. `withReason(r, why)` returns `{ ...r, pendingReason: why }`.
  `allocator.ts`: `Allocator.allocate(ulid, series)`, and `allocateWithRetry(a, ulid, series = "E", p: RetryPolicy = policy)`.
  `http-allocator.ts`:
  ```ts
  async allocate(ulid: string, series: string): Promise<number> {
    const r = await requestJson(this.target, "POST", "/v1/allocate", { ulid, series }, { timeoutMs: this.timeoutMs });
    if (r.status === 200 && Number.isInteger(r.body?.id)) {
      if (r.body?.series !== series) {
        throw Object.assign(new Error(`the post office did not number this note in series ${series} (it answered ${r.body?.series ?? "without a series"}): update the post office`), { retriable: false });
      }
      return r.body.id as number;
    }
    // unchanged error mapping
  }
  ```
  `formatEntryRef`: `if (id === null || id === undefined) return \`${series}-pending\`;` (core and the ui mirror).
  `mcp/src/server.ts` add text: when `result.pending`, print `Saved ${added} (${args.type}), waiting for its number: ${result.pendingReason ?? "the courier will number it"}. Link to it by ulid ${result.ulid} until then.` REST (`server/src/tools/collab.ts:243`): `send(200, { ok: true, id: newId, series, pending: newId === null, ulid })`.
- [ ] **Step 4: Run, expect PASS**, plus the core suite (only the rewritten sync-prep cases change), `cd mcp && npm test`, `cd ui && npx vitest run src/format.test.ts`.
- [ ] **Step 5: Commit** `feat(core): saves never wait on the post office: team and E notes go pending (stage C, E-820)`. The body must name the removed refusals (E-708).

---

### Task 2b: pending notes are reachable by ULID (spec P6 "linkable by ULID")

Pending is now the normal state of a new note whenever the office is down. Handoff chains ("Supersedes E-NNN") must still work right after saving. Today the REST server accepts a ULID; the MCP tools do not, and the ref trigger only parses number forms.

**Files:**
- Modify: `core/src/ops/get.ts` (`resolveNoteKey(db, input): InsertedEntry | null`, accepting a ULID or any number form), `core/src/entry-write.ts` (`insertRefs`: a `ref_type='entry'` ref whose `ref_value` is a ULID gets `target_ulid = ref_value` when that note exists), `mcp/src/server.ts` (`collab_get`, `collab_update`, `collab_update_refs`, `collab_supersede`, edit/delete tools: the `id` param also takes a ULID; descriptions say so)
- Test: `core/test/ulid-ref.test.ts` (new), `mcp/test` (one tool test per changed tool, or extend the existing tool tests)

**Interfaces:**
- Produces: `resolveNoteKey(db: DB, input: string | number): InsertedEntry | null`. A 26-char ULID → the live note with that ulid (pending or not); otherwise `parseNoteRef` → `ownerOfRef`.

- [ ] **Step 1: Failing tests:**
  - A pending E note P (ulid U): `resolveNoteKey(db, U)` → P.
  - `addEntry(… refs: [{ref_type:'entry', ref_value: U}])` → `target_ulid = U`.
  - Superseding P by ULID works, and once P is numbered, `getEntry` shows the link by its number.
  - MCP `collab_get` with `id: U` returns P with `E-pending`.
  - A ULID that doesn't exist → the tools' existing not-found error.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Use `isUlid` from `core/src/ulid.ts`, as REST does. In `insertRefs`, set `target_ulid` from a ULID `ref_value` before the insert. The trigger only fires on `target_ulid IS NULL`, so no trigger change and no migration.
- [ ] **Step 4: Run, expect PASS**, plus core and `cd mcp && npm test`.
- [ ] **Step 5: Commit** `feat: reach and link a note by its ULID (pending notes, stage C)`.

---

### Task 3: one send rule for courier and status (`sendTargetOf`)

**Files:**
- Create: `core/src/sync/send-filter.ts`
- Modify: `core/src/sync/overview.ts` (`unsentSharedCount` uses it), `core/src/index.ts` (export), `courier/src/engine.ts` (`placeOf` replaced)
- Test: `core/test/send-filter.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type SendVerdict = "send" | "skip" | "hold";
  export interface SendContext { shared: Set<string>; teamProjects: Set<string>; fingerprint: string | null }
  export function sendContext(db: DB): SendContext;   // reads shared_modules from sync_state + team projects whose team = po_fingerprint
  export function sendVerdictOf(db: DB, w: WireChange, ctx: SendContext, memo: Map<string, NotePlace>): { ulid: string | null; verdict: SendVerdict; place: NotePlace };
  export interface NotePlace { module: string | null; project: string | null; pending: boolean; knownProject: boolean }
  ```
  Rules, in order:
  1. `modules` row → `send` iff the slug is shared.
  2. Change of no note → `skip`.
  3. The note has a project: it's in `teamProjects` → `pending ? "hold" : "send"`; the project is not in the local `projects` table → `hold` (Review Focus 4); otherwise (solo, or a team of another office) → `skip`.
  4. No project: `pending` → `hold`; primary module shared → `send`; else `skip`.
  0. (checked first) A pending note that is tombstoned (`deleted_at` set) → `skip`: it never left this laptop, so it isn't waiting for anything.
- Contract: `hold` means "not sent now, but still waiting". It counts as unsent in the status, and the bookmark passes it like `skip`. Nothing is lost: a pending note is resent whole once numbered (`numberedNow`, Task 4), and a project learned late is backfilled whole (`backfilled_projects`, Task 4).

- [ ] **Step 1: Failing tests** `core/test/send-filter.test.ts`: on a sync-enabled temp notebook with `shared_modules = ["portfolio"]`, `po_fingerprint = 'fp'`, solo `P1`, team `SH` (team='fp'), team `ZZ` (team='other'), a note with a `project_ulid` that is missing from `projects`, and E notes in `portfolio` / `private`, assert the verdict of every own change from `readOwnChanges(db, 0)`:
  - solo P1 note tagged `portfolio` → skip
  - SH numbered → send; SH pending → hold
  - ZZ → skip
  - unknown project → hold
  - E pending in portfolio → hold; E numbered in portfolio → send; E in private → skip
  - `modules` row of portfolio → send
  - `unsentSharedCount` equals the number of `send` + `hold` verdicts. Holds count as unsent: they are waiting.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `send-filter.ts`. Move the body of the courier's `placeOf` here, adding `id IS NULL AS pending`, `project_ulid`, and `EXISTS (SELECT 1 FROM projects WHERE ulid = e.project_ulid) AS known`. `sendContext` reads `shared_modules` (the key name lives in `overview.ts` today as `SHARED_KEY`; move both key constants into `send-filter.ts` and import them in `overview.ts`) and `SELECT ulid FROM projects WHERE mode='team' AND team = ?` with `getSyncValue(db, SYNC_KEYS.fingerprint)`. Before 0009 (`!hasSeries(db)`), every note has `project = null, known = true`.
  `overview.ts` `unsentSharedCount`: drop its own copy; count `verdict !== "skip"`. Keep the early return when sync is off. Remove the `shared.size === 0` early return: team notes count without any shared module.
  Courier `engine.ts`: delete `placeOf` and the `Place` type, and use `sendVerdictOf` (push logic itself changes in Task 4).
- [ ] **Step 4: Run, expect PASS**, plus the core suite, plus `courier/test/project-never-sent.test.ts` and `courier/test/engine.test.ts`.
- [ ] **Step 5: Commit** `refactor(core): one send rule for the courier and the unsent count (stage C)`.

---

### Task 4: courier: number pending notes, learn team projects, send team notes whole

**Files:**
- Modify: `courier/src/engine.ts`, `courier/src/keys.ts`, `core/src/projects.ts` (`upsertTeamProjectFromOffice`)
- Test: `courier/test/team-projects.test.ts` (new; two laptops through `startOffice` / `joinedDb` / `openWriter` from `world.ts`)

**Interfaces:**
- Consumes: Task 1 HTTP routes; Task 2 `Allocator`/`HttpAllocator.allocate(ulid, series)`; Task 3 `sendContext`, `sendVerdictOf`.
- Produces:
  - `COURIER_KEYS.backfilledProjects = "backfilled_projects"` (JSON list of team project ulids whose older notes were sent)
  - `COURIER_KEYS.projectClash = "project_clash"` (JSON `[{code, office_ulid, local_ulid}]`, read by Task 6)
  - `upsertTeamProjectFromOffice(db, p: { ulid; name; code }, fingerprint): "created" | "updated" | "clash"` in core
  - `Courier.numberPendingNow(): Promise<void>`

- [ ] **Step 1: Failing tests** `courier/test/team-projects.test.ts`. Setup: office; laptops A and B joined; register team `SH` on the office with `registerProject(office.store, …)` (Task 5 adds the laptop command). One `Courier` per laptop with `watch: false`; drive it with `syncNow()`.
  - **Learns the project:** B `syncNow()` → B's `projects` has `SH` with `mode='team'`, `team = office.fingerprint`, same ulid.
  - **Round trip:** A writes an SH note (office up) → `SH-1`; A push, B pull → B has `SH-1` with full title/summary/body/refs.
  - **Pending then whole (Review Focus 1):**
    1. `office.down()`; A writes SH note `T` → pending.
    2. `office.up()`; A `pushNow()` before numbering (call the private push through `pushNow` with numbering stubbed by setting the allocator to a failing fake via `setAllocator`).
    3. The office has NO row for T's ulid.
    4. `setAllocator(null)`; A `syncNow()` → T numbered `SH-2` locally.
    5. The office has T with the non-empty title and its refs/modules rows.
    6. B pull → B's `SH-2` title equals A's.
  - **Same number on retry (Review Focus 3):** `office.store` already allocated ulid U as `SH-3` (call `allocate` directly), and A has a pending note with ulid U (insert through `addEntry` with `pendingUlid: U` while the allocator fails) → after `numberPendingNow()` A's note is `SH-3`, and the office counter is unchanged.
  - **E pending:** shared module `portfolio`; office down; A writes an E note in `portfolio` → pending, NOT sent; office up + `syncNow()` → numbered from the E counter and B receives it.
  - **Solo still never sent:** A solo `P1` note → never in `po_deliveries` (as `project-never-sent`).
  - **Promote backfill:** A has solo `NV` with `NV-1`, `NV-2`; mark it team (`UPDATE projects SET mode='team', team=fp` + `registerProject(…seed 2)`); A `syncNow()` → office has both notes; B receives `NV-1`, `NV-2`; A's next NV note is `NV-3` from the office.
  - **Unknown project on pull (Review Focus 4):** B's courier is stopped while A registers `ZZ` and writes `ZZ-1`; B pulls (changes event only, no projects refresh) → B has the `ZZ` project row afterwards. B edits `ZZ-1` → sent.
  - **Never numbered, bookmark still moves:** a fake allocator answers every SH request non-retriably (series mismatch); A writes an SH note and an E note in `portfolio` → after `syncNow()` the E note is at the office, the SH note is pending, `sent_db_version` = the top, and a second `pushNow()` sends 0 changes.
  - **Deleted while pending:** office down; A writes SH note, tombstones it; office up + `syncNow()` → never numbered, never sent, and the sent-bookmark reaches the top (not pinned).
  - **Clash (Review Focus 5):** B has solo `SH` with `SH-1` before syncing. A's team note `SH-1` gets the LOWER ulid: build it with `addEntry(… assigned: { ulid: '00000000000000000000000001', id: 1 })` after registering, so a tie-break by ulid would pick A's note. After B's `syncNow()`: B's solo SH unchanged, no team SH row, `project_clash` lists SH, courier state `needs-action`, and **no team change was applied** (B has no row with A's ulid). B's `ownerOfRef({series:'SH', id:1})` is B's own note. B's E notes in `portfolio` are still pushed. After B's solo SH is removed (test: delete the project row and its notes) and `syncNow()` → clash cleared, state `connected`, team notes arrive.
- [ ] **Step 2: Run, expect FAIL**: `cd courier && npx tsx --test test/team-projects.test.ts`.
- [ ] **Step 3: Implement.**
  `core/src/projects.ts`:
  ```ts
  /** A team project as the office lists it (P1). Never overwrites a local project with the same code (P10). */
  export function upsertTeamProjectFromOffice(db: DB, p: { ulid: string; name: string; code: string }, fingerprint: string): "created" | "updated" | "clash" {
    needs0009(db);
    const mine = db.prepare(`SELECT ulid, mode, team, name FROM projects WHERE ulid = ?`).get(p.ulid) as { ulid: string; mode: string; team: string | null; name: string } | undefined;
    if (mine) {
      if (mine.mode !== "team" || mine.team !== fingerprint || mine.name !== p.name) {
        db.prepare(`UPDATE projects SET mode = 'team', team = ?, name = ?, updated_at = datetime('now') WHERE ulid = ?`).run(fingerprint, p.name, p.ulid);
        return "updated";
      }
      return "updated";
    }
    const clash = db.prepare(`SELECT 1 FROM projects WHERE code = ? OR lower(name) = lower(?)`).get(p.code, p.name);
    if (clash) return "clash";
    db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, ?, ?, 'team', ?)`).run(p.ulid, p.name, p.code, fingerprint);
    return "created";
  }
  ```
  `courier/src/engine.ts`:
  - `refreshProjects()`: `GET /v1/projects`; in one transaction, `upsertTeamProjectFromOffice` for each; write `K.projectClash` (JSON of the clashes, `[]` when none) only when it changed. A 404 from an old office → treat as no projects (log once).
  - `numberPending()`: for own notes `SELECT e.ulid, e.series FROM entries e LEFT JOIN projects p ON p.ulid = e.project_ulid WHERE e.id IS NULL AND e.deleted_at IS NULL AND (e.project_ulid IS NULL OR (p.mode = 'team' AND p.team = @fp))`, ordered by ulid: `allocateWithRetry(resolveAllocator(this.db), ulid, series)`, then `UPDATE entries SET id = ? WHERE ulid = ? AND id IS NULL`. A failure on one note stops the loop and throws (the normal 30 s retry). A non-retriable failure (series mismatch, 404 unknown series) → log, set `lastError`, skip that note, continue.
    No "own notes only" filter is needed: a pending row only ever exists on the laptop that wrote it, because a pending note is never sent (Task 3 `hold`). Say so in a comment. Use `resolveAllocator(this.db)` (it already falls back to the HTTPS allocator).
  - `syncNow()` becomes `refreshModules → refreshProjects → pull → numberPending → push`. `pushNow()` becomes `numberPending → push` in one enqueued job. `numberPending` never throws: it catches, records `lastError` (and sets `offline` when the office is unreachable, so the normal 30 s retry is scheduled), and the job always goes on to `push`. One unnumberable note must not stop other notes being sent. SSE `projects` event → `refreshProjects` then `push`.
  - `push()` with the Task 3 verdicts:
    ```ts
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, verdict, place } = sendVerdictOf(this.db, w, ctx, memo);
      if (verdict !== "send") continue; // hold = waiting (status only); the bookmark still passes it
      out.set(changeKey(w), w);
      if (w.table === "entries" && ulid) {
        if (w.cid === "created_at") createdNow.add(ulid);
        if (w.cid === "module") moved.add(ulid);
        if (w.cid === "id") numberedNow.add(ulid); // a pending note just got its number: send it whole
      }
    }
    for (const u of createdNow) { moved.delete(u); numberedNow.delete(u); }
    ```
    Whole-note resend: the existing `backfill || moved` second pass also takes `numberedNow` ulids and the notes of team projects not yet in `K.backfilledProjects` (verdict `send` only). New bookmark: `top`, as today. Persist `K.backfilledProjects` with `K.sent` in the same transaction.
  - Clash stops the pull: the office sends every delivery to every member, so not creating the project row alone would still mix two `SH-1`s into B's notebook. While `K.projectClash` is non-empty, `syncNow()`/`pullNow()` skip `pull()` and set a new `CourierState` `"needs-action"` (`lastError` = the clash text from Task 6). `push()` continues. `refreshProjects` clears the clash when the local project is gone, and the next `syncNow()` resumes pulling from the same `recv_seq`. Add `"needs-action"` to `CourierState`, and map it to `SyncHealth` `"needs-update"` in `overview.ts` (both mean "a person must act").
  - `pull()`: after applying a batch, `SELECT DISTINCT project_ulid FROM entries WHERE ulid IN (applied) AND project_ulid IS NOT NULL AND project_ulid NOT IN (SELECT ulid FROM projects)`. If any, `await this.refreshProjects()` after the transaction.
- [ ] **Step 4: Run, expect PASS**, plus the whole courier suite (43 + new).
- [ ] **Step 5: Commit** `feat(courier): number pending notes, learn team projects, send team notes whole (stage C)`.

---

### Task 5: create a team project, promote solo → team (P9)

**Files:**
- Modify: `core/src/projects.ts` (`createTeamProject`, `promoteProject`; `createProject` keeps refusing `team` with a pointer to them), `cli/src/project.ts` (`create --team`, `promote <code>`), `cli/src/main.ts` (usage)
- Test: `core/test/team-project-create.test.ts` (new, a real office from `post-office/test/office.ts`, or a fake `requestJson` target), `cli/test/project.test.ts` (extend the existing CLI tests; find them with `grep -rl "project create" cli/test`)

**Interfaces:**
- Consumes: Task 1 `POST /v1/projects`; core `postOfficeTargetFromDb`, `requestJson`.
- Produces:
  - `createTeamProject(db, { name, code }): Promise<Project>`
  - `promoteProject(db, code): Promise<Project>`
  - Both throw `ProjectClashError` on a 409 (message from the office) and a plain `Error` naming the office address when it can't be reached ("creating a team project needs the post office; nothing was created").

- [ ] **Step 1: Failing tests:**
  - create: local row `mode='team'`, `team = po_fingerprint`; the office lists it.
  - create with a code the office already has → `ProjectClashError`, no local row.
  - create with a code a LOCAL solo project has → `ProjectClashError` before any network call.
  - create on an unshared notebook → error "share this notebook first (`collab sync setup <join code>`)".
  - office down → error, no local row.
  - promote solo `NV` with `NV-1..NV-4` (one hard-deleted at 4, so `local_counters` says 4 but max(id) says 3) → office seed = **4** (the counter, so a deleted number is never reused: B1 Review Focus 5); local row becomes team.
  - promote twice → idempotent.
  - promote while office down → error, still solo.
  - CLI: `collab project create Support --code SH --team` prints `Created team project SH (Support): numbers come from the post office at <url>; with the office down, notes are saved and wait for their number.`; `collab project promote NV` prints the seed and the next number.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Order matters: register at the office FIRST, then write locally. If the local write fails after a successful register, a retry is idempotent on the office (same ulid). Seed for promote = `MAX(local_counters.value WHERE name = 'series:'||code, MAX(id) of that series)`. Local update: `UPDATE projects SET mode='team', team=? WHERE ulid=?`. Do not touch notes; the courier's project backfill (Task 4) sends them.
- [ ] **Step 4: Run, expect PASS**, plus the core and cli suites.
- [ ] **Step 5: Commit** `feat(core,cli): create team projects and promote solo projects (stage C, P9)`.

---

### Task 6: say what's happening: status lines, sync overview, doctor (rule 8)

**Files:**
- Modify: `core/src/sync/overview.ts` (`pending` counts), `mcp/src/server.ts` (`statusLine()`), `core/src/ops/doctor.ts` (project checks), `cli/src/project.ts` (`list` shows mode + pending)
- Test: `core/test/sync-overview.test.ts`, `core/test/doctor-projects.test.ts`, `mcp/test` golden refresh only if the status line text changes for a notebook with no projects (it must not: rule 1)

**Interfaces:**
- Produces:
  - `pendingCounts(db): Array<{ series: string; project: string | null; n: number }>` in `core/src/sync/overview.ts`
  - `SyncOverview.pending: number` (total)
  - Doctor checks `projects.pending`, `projects.team_office`, `projects.clash`

- [ ] **Step 1: Failing tests:**
  - overview on a notebook with 2 SH pending + 1 E pending → `pending = 3`, `pendingCounts` = `[{series:'E', n:1}, {series:'SH', n:2}]`.
  - doctor: pending notes → `projects.pending` warn: "3 notes wait for their number (SH 2, E 1); they are numbered when the courier reaches the post office".
  - Team project whose `team` ≠ this notebook's `po_fingerprint` → `projects.team_office` error ("SH belongs to another post office; one office per notebook (E-820)").
  - `project_clash` non-empty → `projects.clash` error with the fix: "the team's SH clashes with your own SH. Copy your notes into another code (`collab copy`, stage B2) and delete your SH, then sync again."
  - None of these → ok lines.
  - MCP status line when the current project is team: `project: SH Support (team, office connected, 2 pending)`; solo: unchanged from B1; no project and sharing on with E pending: `project: none (E series, 1 pending)`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `pendingCounts`: `SELECT series, project_ulid AS project, COUNT(*) n FROM entries WHERE id IS NULL AND deleted_at IS NULL GROUP BY series, project_ulid ORDER BY series`. Office state for the status line comes from the existing courier status in `readSyncOverview`.
- [ ] **Step 4: Run, expect PASS**, plus the core suite and `cd mcp && npm test` (goldens unchanged for a notebook with no projects).
- [ ] **Step 5: Commit** `feat: status lines and doctor explain team projects and pending notes (stage C, rule 8)`.

---

### Task 7: Windows verification and the two-laptop run (no code)

- [ ] **Step 1:** Full suites in the worktree via a background subagent: core, courier, post-office, mcp, cli, ui `format.test.ts`. Expected: baseline plus the new tests, 0 failing.
- [ ] **Step 2: Rule-1 check on a COPY of the real `collab.db`** (never the real file): open with the new build in a temp folder; every `E` note, module, search and `doctor` result is identical to before (as B1's check), and pending = 0.
- [ ] **Step 3: Two-laptop acceptance (NAVEEN + Rinku, LAN office)**, after the E-793 merge sequence. **Update BOTH laptops and the office before creating the first team project.** There is no migration in C, so the schema guard can't stop a B1-build laptop. It would accept team notes it can't place, and its courier would never number its own pending E notes.
  1. NAVEEN: `collab project create "Support hub" --code SH --team`
  2. Rinku sees SH within one sync
  3. both write; numbers never collide
  4. stop the office; both write; notes show `SH-pending`
  5. start the office; within 30 s both are numbered and both laptops have every note whole
  6. NAVEEN works in a solo project at the same time and nothing from it reaches the office (`po_deliveries`)
  Record the result in collab as a handoff.
- [ ] **Step 4:** Collab handoff `▶ NEXT: stage C merged…; next = D (join/leave/web welcome incl. Make-solo button)`.
