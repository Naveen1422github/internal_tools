# Collab Local-First (E as a team project) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A note's project alone decides where it goes. E becomes the emp1st team project (members only), private E notes never leave, office-wide module sharing retires. No schema migration.

**Architecture:**
- E stays `project_ulid NULL, series 'E'` in every database. A fixed `E_PROJECT_ULID` stands for it.
- **Office:** "adopting E" adds an E row to `po_projects` and re-stamps E deliveries. From then on, delivery, replay and RnR treat NULL-project notes as the E project.
- **Laptop:** opting in records the adoption, a never-send set, and E bindings in `sync_state`/`project_modules`. The send rule then treats NULL-project notes as E.
- **Before adoption** on either side, behaviour is exactly today's.

**Tech Stack:** TypeScript 5.3, Node ≥20.9, better-sqlite3 + cr-sqlite 0.16.3, `node:test` via tsx. Workspaces: core, post-office, courier, cli, server, mcp, ui.

**Spec:** `docs/superpowers/specs/2026-10-25-collab-local-first-design.md`

## Global Constraints
- **No new migration.** Schema stays `0013`; `KNOWN_MIGRATIONS` is unchanged.
- **Fixed E ulid:** `E_PROJECT_ULID = "0000000000000000000000000E"` (26 chars, Crockford-valid).
- **E rows keep `project_ulid` NULL on disk and on the wire.** Never UPDATE an existing note's `project_ulid`.
- **`sync_state` keys:**
  - `e_project` = `"1"` once this laptop adopted E
  - `never_send` = JSON array of ulids
  - `default_project` = a project code
- **Office:** `po_meta` key `e_adopted` = `"1"`. The E counter stays `po_meta.counter`.
- **Capability flag** in the `/v1/access` response: `eProject: { adopted: boolean, member: boolean }`.
- **User-facing wording:** never say "solo". Say "private (not shared)" / "shared with its members".
- **Old peers keep working:** no 409 for code-only differences. `GET /v1/modules` keeps answering (frozen list) after adoption.
- **Tests:** run per workspace (`npm -w @collab-mcp/<ws> test`). Never `npm ci` in the main checkout. Work in a worktree.
- **Commits end with:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus
1. **A private E note** (module never shared, or no module) must not leave after adoption, even if a later edit retags it into a bound module. The never-send set wins over every other rule. Test in Task 2.
2. **A laptop that adopted E against an office that hasn't** must refuse to adopt, not half-switch. Test in Task 7.
3. **A non-E member** (Abhishek: TT + TESTNP only) must receive no E deliveries after the office adopts, including ones written before adoption, and must keep receiving TT. Test in Task 4.
4. **A note saved with no project, no binding and no folder** on an adopted laptop lands in the default private project with a number, while the office is down. It is never pending and never E. Test in Task 3.
5. **Copy out of E** (`collab copy --from note:E-26 --to COLLAB`) still marks the original `copied_to` and never sends the copy. Test in Task 2.

---

### Task 1: E project identity in core

**Files:**
- Create: `core/src/e-project.ts`
- Modify:
  - `core/src/projects.ts`: `findProject` (~:353) and `listProjects` (~:347)
  - `core/src/ops/bind.ts`: `boundProjectFor` (~:74), binding to `E`
- Test: `core/test/e-project.test.ts`

**Interfaces:**
- **Produces** (from `core/src/e-project.ts`):
  - `E_PROJECT_ULID: string`
  - `E_ADOPTED_KEY = "e_project"`
  - `NEVER_SEND_KEY = "never_send"`
  - `DEFAULT_PROJECT_KEY = "default_project"`
  - `isEAdopted(db: DB): boolean`
  - `eProject(db: DB): Project`, a virtual Project: `{ ulid: E_PROJECT_ULID, code: "E", name: "emp1st", mode: isEAdopted(db) ? "team" : "solo", team: fingerprint|null, left_at: null }`
  - `isEProject(p: Project | null): boolean`
  - `writeProjectUlid(p: Project | null): string | null`. Returns null for E or null, else `p.ulid`.
  - `neverSend(db: DB): Set<string>`
- **Behaviour changes:**
  - `findProject(db, "E" | E_PROJECT_ULID)` returns `eProject(db)`.
  - `listProjects` appends it.
  - `collab project bind <m> E` stores `E_PROJECT_ULID`.
  - `boundProjectFor` maps that ulid back to `eProject(db)`.

- [ ] **Step 1: Write failing tests** in `core/test/e-project.test.ts`:
  - `findProject(db,"E")` and `findProject(db,E_PROJECT_ULID)` both return `.code === "E"`.
  - Mode is `"solo"` before `setSyncValue(db,"e_project","1")` and `"team"` after.
  - `listProjects(db).some(p=>p.code==="E")`.
  - After `bindModule(db,"infra","E")`, `boundProjectFor(db,"infra")?.code === "E"`.
  - `writeProjectUlid(eProject(db)) === null`.
- [ ] **Step 2: Run, expect FAIL.** `npm -w @collab-mcp/core test -- --test-name-pattern "e-project"`
- [ ] **Step 3: Implement** `core/src/e-project.ts` and the three call-site changes. Every writer that takes `project?.ulid` (`addEntry` → `insertEntryRow`, `copy`) must go through `writeProjectUlid`.
- [ ] **Step 4: Run the core suite.** Expect PASS, and the existing project tests still green (E must not break `createProject`'s `code <> 'E'` refusal).
- [ ] **Step 5: Commit** `feat(core): E as a virtual project with a fixed ulid`

### Task 2: The send rule (never-send first, E as a team project)

**Files:**
- Modify: `core/src/sync/send-filter.ts`. Edit `SendContext`/`sendContext` (:22-61) and `verdictOf` (:129-140).
- Modify: `core/src/sync/overview.ts`. The status payload gains `privateKept: number`.
- Test: `core/test/send-filter-e.test.ts`

**Interfaces:**
- **Consumes:** Task 1 (`isEAdopted`, `neverSend`).
- **Produces:**
  - `SendContext` gains `eAdopted: boolean` and `neverSend: Set<string>`.
  - The verdict order:
    0. `neverSend.has(ulid)` → `skip`. This comes before every rule, for entries/refs/entry_modules/entry_revisions rows of that note.
    1. Existing rules 0/0b/2/2b, unchanged.
    2. No project and `eAdopted` → pending ? `hold` : `send`.
    3. No project and not adopted → today's module rule (`shared`).
    4. `modules` rows when `eAdopted` → `send` iff some non-never-send note sent in this push references the slug. Otherwise `skip`.

- [ ] **Step 1: Write failing tests.** Seed a notebook with the sync enabled:
  - `e_project` set
  - E note A in module `custom-reports`
  - E note B in module `qa-system`, with B's ulid in `never_send`
  - E note C with no module, in `never_send`
  - a copy of A into solo `COLLAB`

  Assert:
  - A → `send`; B and C → `skip`.
  - B after `UPDATE entries SET module='custom-reports'` → still `skip` (Review Focus 1).
  - The COLLAB copy and its `copied_to` ref → `skip` (Review Focus 5).
  - A `modules` row for `qa-system` → `skip`; one for `custom-reports` → `send` when A is in the batch.
  - The same notebook without `e_project` and with `shared_modules=["custom-reports"]` gives the exact pre-change verdicts.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `unsentSharedCount` must use the same verdicts (it already calls `sendVerdictOf`). `privateKept = neverSend.size` counts only live notes.
- [ ] **Step 4: Run core + courier tests**, expect PASS.
- [ ] **Step 5: Commit** `feat(core/sync): never-send set and E as a team project in the send rule`

### Task 3: Where a new note goes (default private project)

**Files:**
- Modify: `core/src/ops/add.ts`. Edit `defaultProject` (:166-176), `noteDestination` (:191-201), `addEntryAsync` (:315-337).
- Create: `core/src/ops/default-project.ts`
- Modify: `cli/src/` project command (add `default`), and the mcp tool list (`mcp/src/server.ts`: add `collab_project_default`, and update the `collab_add` project-param description at :453)
- Test: `core/test/default-project.test.ts`

**Interfaces:**
- **Consumes:** Task 1.
- **Produces:**
  - `getDefaultProject(db: DB): Project | null`
  - `setDefaultProject(db: DB, codeOrUlid: string): Project`. Refuses E and team projects with "the default must be a project that isn't shared".
  - `ensureDefaultProject(db: DB): Project`. Returns the set one, else uses `PS` if it exists, else creates private project code `PS`, name "Personal", stores it, and returns it.
  - The resolution order becomes: explicit → binding → folder → (sync enabled ? `ensureDefaultProject` : none→E).
  - `NoteDestination.why` gains `"default"`, with line `It goes into PS (Personal): no project was named for it, and PS is private.`

- [ ] **Step 1: Write failing tests:**
  - Sync enabled + `e_project`, no binding/folder, office allocator throwing (down): `addEntryAsync` returns `{ series:"PS", pending:false }` with a number (Review Focus 4).
  - `setDefaultProject(db,"E")` throws.
  - With no sync: a no-project note is still `E` with a local number (E-834 item 2).
  - `noteDestination` returns `why:"default"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Also:
  - `collab project default [<CODE>]` prints or sets the default.
  - MCP `collab_project_default { project?: string }` does the same.
- [ ] **Step 4: Run the core, cli and mcp tests**, expect PASS.
- [ ] **Step 5: Commit** `feat(core): notes with no project go to a private default project, never E by accident`

### Task 4: Office adopts E (register, restamp, deliver to members only)

**Files:**
- Create: `post-office/src/e-adopt.ts`
- Modify:
  - `post-office/src/deliveries.ts`: `resolve()` stamp at :161, plus `fetchDeliveries`/`fetchReplay` unchanged in logic
  - `post-office/src/server.ts`: `/v1/access` payload gains `eProject`
  - `post-office/src/cli.ts`: new `adopt-e`
- Test: `post-office/test/e-adopt.test.ts`

**Interfaces:**
- **Consumes:** core `E_PROJECT_ULID`.
- **Produces:**
  - `adoptE(store: Store, o: { name: string; ownerDevice: string }): { restamped: number }`. One transaction:
    - insert `po_projects(ulid=E_PROJECT_ULID, code='E', name)`, bypassing `registerProject`'s E refusal
    - `seedNewProject` roles; owner = `ownerDevice` as Owner
    - `UPDATE po_deliveries SET project_ulid=E_PROJECT_ULID` for rows of tables entries/refs/entry_modules/entry_revisions whose note has no project (stamp NULL, not '?')
    - `po_meta e_adopted=1`
    - Throws if already adopted.
  - `isEAdoptedOffice(store): boolean`
  - `resolve()`: a NULL stamp for those 4 tables becomes `E_PROJECT_ULID` when adopted. `modules` rows stay NULL.
  - CLI `adopt-e --owner <member> [--name emp1st]` prints the restamp count and the line "add members: collab team set <member> E <role>".

- [ ] **Step 1: Write failing tests.** Office with members owner/abhishek/gaurav, projects TT (abhishek Editor), shared E deliveries from owner. After `adoptE`:
  - `fetchDeliveries(abhishek)` returns no E rows (old or new) but still TT rows (Review Focus 3).
  - Owner gets new E rows.
  - Gaurav, after `setProjectMember(E, gaurav, Editor)`, gets the full E history via `fetchReplay`.
  - A second `adoptE` throws.
  - `/v1/access` reports `eProject.adopted=true`, with `member` per device.
- [ ] **Step 2: Run, expect FAIL.** `npm -w @collab-mcp/post-office test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** (all 182 existing + new).
- [ ] **Step 5: Commit** `feat(post-office): adopt E as a team project; E deliveries go to its members only`

### Task 5: Office judges and numbers E like a team project; module sharing closes

**Files:**
- Modify:
  - `post-office/src/classify.ts`: :203-226, a NULL project → `E_PROJECT_ULID` when adopted
  - `post-office/src/store.ts`: `allocate` E branch :239-250, membership + `note.create` check when adopted, refusal recorded like the team branch
  - `post-office/src/server.ts`: `POST /v1/modules` → 410 `{error:"modules follow their project now: collab project bind <module> <CODE>"}` when adopted; `GET` unchanged
  - `core/src/access/catalog.ts:81` and `ui/src/team/catalog.ts:81`: drop `office.module.share`
- Test: `post-office/test/e-rnr.test.ts`

**Interfaces:**
- **Consumes:** Task 4 `isEAdoptedOffice`.
- **Produces:** E edits by a member are judged by E roles. A non-member's E creation is refused "You need Create notes (note.create) in E". A pre-adoption owner of an E note keeps edit rights through `po_note_owners`.

- [ ] **Step 1: Write failing tests:**
  - After adoption, a non-member's `allocate(..,"E")` → 403 and a refusal row.
  - A Contributor editing someone else's E note → refused (`note.edit.any`).
  - The owner editing E-261-shaped rollup → accepted.
  - `POST /v1/modules` → 410.
  - Before adoption, all four behave as today.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the post-office and core tests**, expect PASS. Fix tests that seeded `office.module.share`.
- [ ] **Step 5: Commit** `feat(post-office): E judged and numbered by its members' roles; module sharing closed`

### Task 6: Schema guard tolerates listed peers

**Files:**
- Create: `core/src/sync/compat.ts`
- Modify: `post-office/src/server.ts:196`
- Test: `core/test/compat.test.ts`, plus one case in `post-office/test/server.test.ts`

**Interfaces:**
- **Produces:**
  - `WIRE_COMPAT: Record<string, readonly string[]>`. Today `{}`: no extra peers.
  - `schemaCompatible(office: string, device: string): boolean` → `office === device || WIRE_COMPAT[office]?.includes(device) === true`.

- [ ] **Step 1: Write failing tests:**
  - Equal → true.
  - Unlisted → false.
  - With a test-only override `{"0014_x":["0013_access_cache"]}`, the pair is true and the reverse is false.
  - The server returns 409 only when `!schemaCompatible`.
- [ ] **Step 2–4:** Implement, then run core + post-office tests, expect PASS.
- [ ] **Step 5: Commit** `feat(sync): schema guard takes an explicit compatibility list`

### Task 7: Laptop adopts E (`collab project adopt-e`) and the courier follows

**Files:**
- Create: `core/src/ops/adopt-e.ts`
- Modify:
  - `courier/src/engine.ts`:
    - `refreshModules` :523, which becomes a no-op when adopted
    - project backfill :544/:574: `E_PROJECT_ULID` selects `project_ulid IS NULL AND series='E'` minus never-send
    - `refreshAccess` stores `eProject` from `/v1/access`
    - doorbell `projects`/`access` → `syncNow`
  - `cli/src/` project commands: `adopt-e`
  - `courier/src/cli.ts:272-283`: `sync share|unshare` print the moved message (exit 2)
- Test: `core/test/adopt-e.test.ts`, `courier/test/e-backfill.test.ts`

**Interfaces:**
- **Consumes:** Tasks 1–5, and the `eProject` capability from `/v1/access` (cached via `access_cache`).
- **Produces:** `adoptELocal(db: DB, o: { defaultProject?: string; extraModules?: string[] }): AdoptReport`, where `AdoptReport = { neverSend: number; bound: string[]; default: string }`. Behaviour:
  - Refuses unless sync is enabled, the cached access says `eProject.adopted && eProject.member`, and it isn't already adopted. Message: "the post office hasn't adopted E yet: run collab office adopt-e there first" (Review Focus 2).
  - `never_send` = live E notes with `project_ulid IS NULL` whose primary module ∉ (`backfilled_modules` ∪ `shared_modules`), or whose module is NULL.
  - Binds every module in `shared_modules` ∪ `extraModules` to E.
  - Sets the default project (`ensureDefaultProject` if none is given).
  - Sets `e_project=1`.
  - The whole thing is one transaction.

- [ ] **Step 1: Write failing tests:**
  - `adoptELocal` without office adoption → throws that message, with nothing written.
  - With adoption:
    - never-send = exactly the B/C-type notes
    - bound = the shared modules + `infra`
    - a re-run throws "already adopted"
  - Courier test (world.ts): after adoption, one backfill sends E notes not in never-send and not yet at the office, and none twice.
  - `sync share x` exits 2 with the moved message.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** CLI `collab project adopt-e [--default <CODE>] [--also <module>...]` prints the AdoptReport in plain words.
- [ ] **Step 4: Run the core, courier and cli tests**, expect PASS.
- [ ] **Step 5: Commit** `feat: laptop adopts E; courier backfills E to its members, module sharing off`

### Task 8: Web and status surfaces

**Files:**
- Modify:
  - `ui/src/sync/ShareToggle.tsx` and `ui/src/pages/Modules.tsx:62-98`: hide the share column when adopted; show a "Project" column with the binding
  - `ui/src/pages/Projects*`: E listed as "emp1st (E) · shared with its members"
  - `ui/src/components/SyncBar.tsx:30`
  - `server/src/tools/team.ts:144-152`: `/api/sync/share` → 410 when adopted
  - `server/src/tools/collab.ts:416`
  - `courier/src/cli.ts` status line "N private E notes kept on this laptop"
- Test: `ui/src/pages/Modules.share.test.tsx` (update), `test/api.team.test.mts:304` (update)

**Interfaces:**
- **Consumes:** the status payload `privateKept` (Task 2) and `isEAdopted` (Task 1).

- [ ] **Step 1: Update tests to the new expectations:**
  - Adopted: no share toggle; the module row shows its project code.
  - `/api/sync/share` → 410.
  - Not adopted: the old toggle still renders.
- [ ] **Step 2: Run, expect FAIL.** `npm -w ui test`, root `npm test`
- [ ] **Step 3: Implement.** Never use the word "solo" in UI copy.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(ui): modules show their project; module sharing hidden after E adoption`

### Task 9: Release gate, the 3-laptop acceptance test

**Files:**
- Create: `courier/test/local-first-acceptance.test.ts` (use `courier/test/world.ts`, as `rnr-s2-acceptance.test.ts` does)

**Interfaces:**
- **Consumes:** everything above.

- [ ] **Step 1: Write the 9 spec §6 scenarios as separate `test(...)` cases.** Setup: one office; laptops `owner`, `member` (E Editor), `outsider` (TT Editor only); the office and owner adopt E. Scenario names, verbatim:
  1. `E note in a bound module reaches the member, not the outsider`
  2. `note in an unbound new module stays local and is not pending`
  3. `never-send E note never reaches the office, even after a rebind`
  4. `outsider added to E later gets the full E history by replay`
  5. `member removed from E stops receiving and keeps what it had`
  6. `private-project note is numbered while the office is down`
  7. `old-code laptop keeps syncing formerly shared modules without a 409`. Simulate with a laptop that hasn't run `adoptELocal`.
  8. `rollup note crosses both ways`
  9. `a binding or membership change reaches connected laptops without a restart`
- [ ] **Step 2: Run, expect PASS** (Tasks 1–8 are done). Any failure is a bug in the owning task: fix it there, never weaken the test.
- [ ] **Step 3: Run every workspace suite.** All green, except the known flakes listed in the guide (ERR_OSSL_ASN1 cert flake, the 4 golden snapshots).
- [ ] **Step 4: Commit** `test: local-first release gate (3 laptops, 9 scenarios)`

### Task 10: Docs and the switch runbook

**Files:**
- Modify: `docs/guide/07-running-it.md` (sections 3 and 4: sharing = projects only; new section "The E switch"), `docs/guide/04-team-sync.md`, `INSTALL.md` ("Joining a team" commands; work notes go to the team project you were given), `post-office/src/cli.ts` (`init` next-steps text: `collab office ...`, COLLAB-202)
- **No tests.** Doc-only, except the `init` text test, if one asserts it.

- [ ] **Step 1: Write the switch section.** These steps run **after merge, with the owner**:
  1. Run the backup job.
  2. Delete the junk: E-13, E-14, E-178, E-179, E-191, E-192, E-193, E-209, E-824 (`collab_archive`/tombstone).
  3. Retag:
     - E-26 → `custom-reports`
     - E-532 → `timesheet`
     - E-377, 378, 379, 380, 407, 408, 409, 508 → new module `infra`
     - the `supportHub` note → `supporthub`
  4. `collab copy` the never-shared tooling/collab modules → COLLAB and `qa-system` → new private `QA`.
  5. On the VM: `collab office adopt-e --owner personal-laptop --name emp1st`.
  6. On the laptop: `collab project adopt-e --default PS --also infra`.
  7. `collab team list E`. **Read** the members; don't ask. Add Gaurav when he joins.
  8. Verify with `collab sync status`: connected, "N private E notes kept".
- [ ] **Step 2: Commit** `docs: sharing is by project; the E switch runbook`

---

## Self-review notes
- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §3.1 | Tasks 1, 4, 5 |
  | §3.2 | Tasks 2, 7, 10 |
  | §3.3 | Task 3 |
  | §3.4 | Tasks 5, 7, 8 |
  | §3.5 | no task (0014 dropped) |
  | §3.6 | Task 6 |
  | §4 | Tasks 5 (GET kept), 7 (refuses before the office), 9 (scenario 7) |
  | §5 | Task 10 |
  | §6 | Task 9 |
  | §9 rulings | Task 10 switch steps |

- **Default project:** `PS` (owner 2026-10-25). No new project is invented for it.
