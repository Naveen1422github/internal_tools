# Collab local-first: E becomes a team project, module sharing retires

Status: DRAFT for owner review · 2026-10-25 · rulings COLLAB-201, COLLAB-204 · code map: subagent report 2026-10-25 (summarised in §8)

## 1. Goal

**One rule decides where a note goes: its project's mode.**
- A solo project never touches the post office.
- A team project is numbered by the office and reaches **only its members**.
- Nothing else can send a note anywhere: no module setting, and no "no project" fallback.

**Why now:**
- Module sharing is office-wide. One test member (Abhishek, in `TT` only) received all 579 emp1st/SupportHub notes (COLLAB-207).
- Solo work waited on a down office (COLLAB-201).
- A second team can't share the office safely until this lands.

## 2. Rulings this implements

| # | Ruling | Source |
|---|---|---|
| R1 | Project mode alone decides whether the office is involved | COLLAB-201 |
| R2 | E = a **team** project for emp1st work; every E number is kept, and the office's E counter continues | COLLAB-204 |
| R3 | Sharing a solo project keeps its numbers (promote, P9, already built). A joiner's own notes move in with new team numbers, as an explicit action, never a silent merge (P10) | COLLAB-201 |
| R4 | Module sharing is retired; modules follow their project | COLLAB-201 |
| R5 | Build with the staff-engineer mindset (backward compatible, logged, tested on the real multi-laptop path), but don't gate the release on it | COLLAB-206 |

## 3. Design

### 3.1 E is a team project, but stays "NULL" on the wire

- E notes keep `project_ulid = NULL` and `series = 'E'` in every notebook. **We don't rewrite them.**
  - Older notes have no clock cells for `project_ulid`, so an UPDATE would create one change per note.
  - The office refuses those changes as "moved between projects" (classify.ts:365).
- Instead, **E is a project with a fixed, well-known ULID** (`E_PROJECT_ULID`, a constant in core). Every place that asks "which project is this note in?" maps `NULL` to that ULID:
  - the laptop's send rule
  - the office's delivery stamping (`resolve()`, deliveries.ts:154-161)
  - RnR classification (classify.ts:203-226)
  - `memberProjects`
- **Office:**
  - `po_projects` gets an E row: code `E`, name "emp1st". `registerProject`'s refusal of `E` (store.ts:301) is lifted for this one fixed ULID only.
  - The counter stays in `po_meta.counter`. `allocate(..., "E")` gains the same membership + `note.create` check the team branch has.
  - Every existing `po_deliveries` row stamped NULL that is an `entries`/`refs`/`entry_modules`/`entry_revisions` row of an E note is **re-stamped** with `E_PROJECT_ULID`. That's a one-time office data step (§5), not a schema migration. After it, delivery, replay to late joiners, and losing access all work exactly as for any team project.
- **Laptop:**
  - `projects` gets **no** E row: its `CHECK (code <> 'E')` would need a table rebuild.
  - E is presented as a virtual team project in `project list`, the web Projects page and `collab_add`'s `project` param (`"E"` accepted).
  - Its mode is **team** once the notebook is joined to an office that knows the E project, and **solo** otherwise. A notebook that never joined numbers E locally, with no pending state (E-834 item 2).

### 3.2 Notes that must stay private: the never-send set

> **Trap found in the code map (most important point of this spec):** once E is a team project, the courier's project backfill (engine.ts:544, 574) would send **every** E note in the notebook. That includes the ~84 notes in never-shared modules (tooling/collab history, qa-system, `supportHub`) and the 19 with no module.

1. **Before the switch, move them out (owner default (a)).**
   - Copy them into solo projects, with old numbers redirecting:
     - tooling/collab modules → `COLLAB`
     - `qa-system` → a new solo `QA`
     - `supportHub` → retagged `supporthub`, stays E (it's SupportHub work)
     - the 19 no-module notes → listed for the owner to sort: E, PS or COLLAB
   - The copy tool already does this (`collab copy --from <module> --to <CODE>`, plus `copied_to` refs).
2. **Belt and braces:** a local **never-send set**.
   - `sync_state` key `never_send` holds the ULIDs that existed at switch time and had never reached the office (§5 computes it).
   - `send-filter` skips them first, before any other rule.
   - It needs no migration, it's per laptop, and it's visible in `collab sync status` ("N private E notes kept on this laptop").
   - So even if a copy step is missed, nothing that was private leaves.

### 3.3 Where a new note goes (default project)

Order (add.ts:151-176):
1. explicit `project`
2. the module's bound project (`project_modules`)
3. the folder's `.collab`
4. **the notebook's default solo project** (new; replaces "none → E")

- E is chosen only explicitly or through a binding: `collab project bind custom-reports E`, and the same for each emp1st module and `supporthub`. Every module that was shared is bound to E by the switch step (§5), so work notes keep flowing to the team with no change in habit.
- An unknown or new module lands in the default solo project. **New modules can never leak.** That replaces today's "new modules aren't shared" trap with a safe default.
- **Default solo project:** owner picks per notebook (`collab project default <CODE>`). Notebooks created by `collab notebook new` get one called `ME`.

### 3.4 Module sharing retires

Removed or made inert:
- the `po_shared_modules` reads in send/receive
- `collab sync modules|share|unshare` (they now print "modules follow their project: `collab project bind <module> <CODE>`")
- `POST /v1/modules`
- ui ShareToggle / Modules page share column
- server `/api/sync/share`
- the `shared` set in send-filter

Details:
- The `office.module.share` role key is dropped from the catalog. Stored roles naming it degrade quietly (`sanitizeKeys` drops unknown keys, access.ts:13-19).
- `modules` rows (CRR) are sent **only when a sent note references the module**. Module names like `jarvis` never leave on their own.
- The table stays for one release (old laptops read it) and goes in a later cleanup.

### 3.5 No schema migration in this release; 0014 dropped

- The multi-column CHECK problem is already neutralised by the `applyChanges` retry plus `quick_check` (1f25452).
- Dropping the CHECK would need a **rebuild of a cr-sqlite table**. That's never been done here and isn't documented by cr-sqlite (code map D). It's real risk for no remaining benefit.
- So 0014 is **out of scope**. If ever needed, it gets a spike first.
- **Consequence:** this release bumps **no** schema version, so nobody is locked out (the 409 guard compares exact versions, server.ts:196).

### 3.6 Schema guard: N/N-1 tolerance (prep, small)

- Replace the exact equality at server.ts:196 with an explicit compatibility list in core: each migration names the earlier ones it can talk to.
- Unused this release, but the next migration can ship without "everyone update today" (staff-engineer point 2).

## 4. Compatibility with laptops not yet updated

| Peer | Behaviour |
|---|---|
| Old laptop + new office | Its E notes in formerly shared modules still send (the office keeps answering `/v1/modules` with the old list, frozen, read-only, for one release). New-module E notes stay local until it updates. Nothing is lost, and nobody gets a 409. |
| New laptop + old office | It refuses to switch. The switch step checks the office supports the E project (capability flag in `/v1/access`) and prints "update the post office first". |
| A member not added to E | Stops receiving E notes after the restamp. **Keeps** the copies already received. Unsharing never recalls. |

Rollout order: office first → owner's laptop → teammates whenever. No same-day requirement.

## 5. The switch (one-time, owner-run, reversible until step 4)

1. `collab backup now`: notebook + office snapshot (the backup job already does this).
2. Move private E notes out (§3.2): `collab copy` per group. The owner reviews the 19 no-module notes first.
3. Office: `collab office adopt-e --name emp1st`. It registers the E project, re-stamps E deliveries, makes the owner the E Owner, and prints the members to add.
4. Laptop: `collab project adopt-e`. It computes the never-send set, binds every formerly shared module to E, and turns off module sharing locally.
5. Add members to E: `collab team set "<member>" E Editor`.
6. Verify (acceptance §6), then announce: "update collab when you can".

## 6. Acceptance: the release gate (multi-laptop, scripted)

A courier test with one office and 3 laptops (owner, emp1st member, outsider in another project only):
1. An owner E note in a bound module reaches the member, **not** the outsider.
2. An owner note in an unbound new module stays local (and isn't pending).
3. A private E note (in never-send) never reaches the office, even after a module rebind.
4. The outsider, added to E later, gets the full E history by replay.
5. A member removed from E stops receiving and keeps what they had.
6. A solo-project note saves with a number while the office is **down**.
7. An old-code laptop keeps syncing formerly shared modules without a 409.
8. A rollup note (E-261 shape) crosses both ways.
9. A share/bind change reaches connected laptops without a restart (doorbell `projects`).

Plus the existing suites. Gate: all green before merge.

## 7. Out of scope (logged, later)

- 0014 / CHECK drop (§3.5)
- Stage D join-with-code UI
- Making a note leave E for a solo project (use copy)
- Several offices per notebook
- Litestream continuous backup
- `modules` table removal (after one release)

## 8. Code map summary (2026-10-25)

| Area | Where |
|---|---|
| Numbering | entry-write.ts:92-126; add.ts:315-337; courier numberPending engine.ts:467-511; office allocate store.ts:239-288, counter po_meta (E) vs po_series_counters (teams); promote projects.ts:228-241 + classify.ts:321-341 |
| Send / receive | send-filter.ts:48-140; courier push engine.ts:536-601, pull :691-731; office fetchDeliveries deliveries.ts:454-485 (NULL-project rows go to everyone, no module filter on the office) |
| RnR | classify.ts:203-226 (E notes unjudged today), :365 (no moving between projects); owners po_note_owners; replay access.ts:246-253, deliveries.ts:467-519 (NULL rows never replayed, hence the restamp) |
| Schema | the only multi-column CHECK is entries 0006:94; no CRR rebuild precedent; guard is exact equality server.ts:196 |
| Default project | add.ts:151-176; mcp server.ts:453 |

## 9. Owner rulings on the open questions (2026-10-25)

1. **The 19 no-module E notes:**
   - Delete the junk: E-13, E-14, and the six "Testing FTS" notes E-178/179/191/192/193/209.
   - Delete the old changelog E-824.
   - E-26 → E, tag `custom-reports`.
   - E-532 → E, tag `timesheet`.
   - The ECS/EC2 notes E-377..380, 407..409, 508 → E, new module `infra` (shared).
2. **"Solo" isn't a word the user sees.** Any project not shared is private. The project comes from: explicit project, then module binding, then folder. When none of these applies, the note goes to the owner's private catch-all project and the AI says where it went (Claude's default: never refuse a save, never land in a shared project by accident).
3. **E membership = owner only at the switch.**
   - Abhishek is a member only of the two projects the owner gave him (TT Editor, TESTNP Contributor), never of E. He received E notes only through office-wide module sharing (the bug this spec removes), so he simply isn't added.
   - Gaurav is added when he joins.
   - The switch step must **read memberships from the office**, never ask.
4. **0014 dropped** (§3.5).

Estimate: 10–14 h build + 2 h switch. Plan written after approval; built in a worktree or cloud, merged only on a green gate.
