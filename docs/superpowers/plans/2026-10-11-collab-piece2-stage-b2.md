# Collab piece 2, stage B2: copy (P8), the "left team" read-only mark (P11), MCP project tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes move between worlds only by copying, on purpose. `collab copy --from <module|project> --to <project> [--author me] [--since <date>]` lists what it will copy, asks, then creates new notes in the target project (new ULIDs, target series, numbered by the target's rule). Links inside the copied set point at the copies; each original gets one `copied_to` link to its copy and is otherwise untouched. A team project you left keeps its notes on the laptop, read-only and marked "left team"; copying them into a solo project makes them yours to edit. An AI agent can do everything the CLI can (user decision 2026-10-11): `collab_copy`, `collab_project_create` and `collab_project_list` behave exactly like their CLI commands and report exactly what they changed.

**Architecture:** All logic lives in core. `planCopy(db, args)` reads only (no write, no network) and returns the notes to copy, the ones skipped and why, and the target. `applyCopy(db, plan)` writes it and returns exactly what changed: each `old → new` reference, the links re-pointed, the `copied_to` links added. A solo target is one transaction and never calls the allocator; a team target asks the office once per note (the save rule of stage C) and saves pending otherwise. The CLI and the MCP tool only call these two functions and print the SAME text from the SAME core formatters (`copyPlanLines`, `copyResultLines`), which is what makes "behaves exactly like the CLI" true by construction. The same holds for project create/list (`projectCreatedLines`, `projectListLines`). The left mark is an explicit column: migration `0010_project_left` adds `projects.left_at`. One core guard (`assertNoteWritable`) is called by every note write path.

**Tech Stack:** TypeScript 5.3 ESM, better-sqlite3 + cr-sqlite, node:test + tsx, MCP SDK + zod.

**Spec:** `docs/superpowers/specs/2026-10-05-collab-projects-design.md` (rule 7, rule 8; P8, P11; build order B2; Testing lines "Copy" and "Leak tests"). Amended by the user decision of 2026-10-11: an AI agent must be able to do anything the CLI can (adds `collab_copy`, `collab_project_create`, `collab_project_list`).

## Decisions taken in this plan (record each as a collab decision)

| # | Decision | Why |
|---|---|---|
| B2-1 | The left mark is a column, `projects.left_at TEXT` (NULL = not left), from migration `0010_project_left`. `projects` is local (not a CRR), so it is a plain `ALTER TABLE`, not in `CRR_ALTERS`. | Rule 8 "nothing is guessed": deriving "left" from the fingerprint would collide with stage C's `projects.team_office` error; `mode` has a CHECK (solo/team); `sync_state` is wiped by `disableSync`, which leave will call. |
| B2-2 | `copied_to` is stored as `ref_type='entry'`, `ref_value='copied_to:<COPY_ULID>'`, `target_ulid=<COPY_ULID>` on the original. | `refs.ref_type` has `CHECK IN ('file','task','entry','url')` and refs is a CRR: a new type needs a CRR rebuild and old peers would reject it. An explicit `target_ulid` means the fill trigger never runs. |
| B2-3 | `copied_to` links are never sent: `sendVerdictOf` skips a refs change whose `ref_value` starts with `copied_to:` (rule 0b). The whole-note resend goes through the same verdict, so it skips them too. | The copy is in a solo project (rule 5): teammates would get a dangling pointer to a note they can never see, and their copy of the original would change. |
| B2-4 | A copy keeps the original's `author` and `created_at` (and `status`, `deprecated`, `category`, `agent`, `module`, `task_id`, `rollup_of_task`), but starts a fresh revision history and `needs_merge = 0`. | The words are still the original author's; `--since` and "recent" lists stay truthful. A copy of 40 old notes must not flood "recent" as if written today. |
| B2-5 | A module source means **E notes only** (no project), found through `entry_modules` (any of the note's modules), live notes only. A project source means that project's live notes. A value matching both a project code and a module slug is refused; `project:SH` / `module:sh` remove the doubt. | Spec: "old E- notes of a module into a new project". Never guess between two meanings. |
| B2-6 | Copy order: by series, then number; pending notes last, by ulid. So target numbers follow the original order. | Readable numbering. |
| B2-7 | Running the same copy again skips every original that already has a live copy in the target (found by its `copied_to` link) and says so. | No silent duplicates. |
| B2-8 | Links inside the copied set: a copy's `entry` ref whose target is in the set points at the target's copy (`target_ulid` = copy ulid, `ref_value` = the copy's number, e.g. `NV-3`, or its ulid while pending). `superseded_by_ulid` inside the set is re-pointed the same way, and the bare `superseded_by` is set to NULL (a bare number means E, and copies are never E). Links to notes outside the set are copied unchanged. The original's own `copied_to` links are not copied. Body text is never rewritten. | Spec P8. |
| B2-9 | Read-only covers edit, update, update refs, merge resolve, supersede (both the old and the new note), task-done cascade, and adding a note into a left project. **Delete stays allowed** (a tombstone of a left note is never sent: B2-10). The copy op is the only writer allowed to touch a left note, and only to add `copied_to`. | Spec summary: "the original is untouched and can be deleted afterwards". |
| B2-10 | A left project is not a team project for sending or numbering: `sendContext` and the courier's `numberPending` require `left_at IS NULL`. `pendingCounts` leaves left projects out (they will never be numbered); doctor names them instead. `upsertTeamProjectFromOffice` never clears `left_at` (rejoining is stage D's decision). | A left project must never send or ask for numbers. |
| B2-11 | The CLI confirms with an optional `Io.ask(question): Promise<boolean>` (the real `bin.ts` gives one when stdin is a TTY), or `--yes`. Without either, it prints the list and copies nothing (exit 0). The MCP tool's `dry_run` defaults to true and returns the same list; `dry_run: false` performs it. | Rule 7: copies are never silent. `Io` had only `out`/`err`. |
| B2-12 | Target rules: the target must be a project (copies are never E); not the source project; not a left project. A team target is allowed (that is how `portfolio` becomes a team project later, "Settled items"). | Spec P8 + settled items. |

## Global Constraints

- **Solo saves never make a network call.** A copy into a solo project never calls `resolveAllocator`/`allocate`, sharing on or off (test: sharing on, an allocator that throws). `collab_copy` with `dry_run` touches neither the database nor the network.
- **Rule 7:** nothing is copied without the list being shown first; the original is never changed apart from its one `copied_to` link.
- **Rule 5:** neither a copy in a solo project nor a `copied_to` link ever reaches the office. `courier/test/project-never-sent.test.ts` stays green unchanged.
- **New migration:** `mcp/migrations/0010_project_left.sql`, added to `KNOWN_MIGRATIONS` in `core/src/db.ts` (`core/test/known-migrations.test.ts` enforces it). Code must still run on a 0009 file (`hasProjectLeft(db)` gates every read of `left_at`).
- **Deploy note (schema guard, spec V7):** the office refuses a laptop whose newest migration differs from its own. After this stage, the office and every laptop must be updated together (as for any migration). Say so in the merge handoff.
- Existing tests that assert `latestMigration === '0009_projects'` after `migrate()` (`core/test/migration-0009.test.ts`) are updated knowingly: they become `migrateTo(…, '0009')` where they test 0009 itself.
- Goldens: a notebook with no projects prints exactly what it printed before (rule 1). The MCP `tools/list` grows by three tools; any snapshot of it is refreshed in the same commit.
- Every cr-sqlite connection in tests runs `SELECT crsql_finalize()` before close (E-764). Temp folders only.
- MCP tests spawn `mcp/dist/server.js`: rebuild core and mcp with `tsc` before running them (`dist/` is gitignored, never committed).
- Branch `collab-piece2-stage-b2` off `collabv1` (`e4b8734`). One commit per task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not merge into `collabv1`; do not touch `main`.
- Baseline before Task 1 (Linux): core 362/0, courier 53/0, post-office 50/0, cli 11/0, mcp 16/0 (all files: `npx tsx --test 'test/**/*.test.ts'`; on Linux `npm test` in mcp only runs the golden file, because sh does not expand `**`).

## Review Focus

1. **Links inside the set:** E-1 links E-2 and E-9 (E-9 not copied). After copying E-1, E-2 into NV: NV-1 links NV-2 (by ulid and number) and still links E-9; E-1 links E-2 and E-9 exactly as before plus one `copied_to` to NV-1. (Task 2 test.)
2. **Team → solo with `--author me` on a shared notebook:** with the office down and the allocator throwing, the copy never calls it; the copies are numbered `P1-n` locally; the team originals gain `copied_to` only; a push sends nothing about the copies and no `copied_to` ref. (Tasks 2 and 6 tests.)
3. **Left team:** every write path refuses a left note with the same sentence naming the fix (`collab copy --from SH --to <solo code>`); delete works; the copy into a solo project is editable; a left project is never sent and never numbered. (Tasks 1 and 3 tests.)
4. **MCP = CLI:** for the same notebook, `collab copy … ` (no confirm) and `collab_copy {dry_run: true}` print the same lines; `--yes` and `dry_run: false` print the same result lines (only the copies' ULIDs differ). Same for project create and list. (Task 5 test.)
5. **Run twice:** the second copy skips everything already copied and says "already copied to NV-1". (Task 2 test.)

---

### Task 1: migration 0010 and the left mark

**Files:**
- Create: `mcp/migrations/0010_project_left.sql`
- Modify: `core/src/db.ts` (`KNOWN_MIGRATIONS`), `core/src/schema.ts` (`hasProjectLeft`), `core/src/projects.ts` (`Project.left_at`, `markProjectLeft`, `isLeftProject`, `leftProjectText`), `core/src/sync/send-filter.ts` (`left_at IS NULL`), `core/src/sync/overview.ts` (`pendingCounts` skips left projects), `courier/src/engine.ts` (`numberPending` skips left projects)
- Test: `core/test/project-left.test.ts` (new), `core/test/migration-0009.test.ts` (latest = 0010 where it migrates fully)

**Interfaces:**
- Produces:
  - `hasProjectLeft(db): boolean` (column exists)
  - `Project.left_at: string | null`
  - `markProjectLeft(db, codeOrUlid): Project` (team projects only; idempotent; stage D's leave calls it)
  - `isLeftProject(p: Project | null): boolean`

- [ ] **Step 1: Failing tests** `core/test/project-left.test.ts`:
  - fresh notebook: `latestMigration = '0010_project_left'`, `projects` has `left_at`, NULL by default.
  - a 0009 notebook with projects migrates: every `left_at` NULL, no tracked change on a shared notebook (`dbVersion` unchanged).
  - `markProjectLeft` on a solo project → error ("only a team project can be left"); on a team project → `left_at` set; twice → same row.
  - send rule: a left team project's numbered note → `skip`, its pending note → `skip` (not `hold`); `unsentSharedCount` does not count them.
  - `pendingCounts` leaves a left project's pending note out.
- [ ] **Step 2: Run, expect FAIL**: `cd core && npx tsx --test test/project-left.test.ts`.
- [ ] **Step 3: Implement.**
  ```sql
  -- 0010_project_left: a team project this laptop left (spec P11). projects is local (not a CRR).
  BEGIN;
  ALTER TABLE projects ADD COLUMN left_at TEXT;
  INSERT INTO schema_migrations (version) VALUES ('0010_project_left');
  COMMIT;
  ```
  `projects.ts`: `COLS` reads `left_at` when `hasProjectLeft(db)`, else `NULL AS left_at`. `sendContext`: `… WHERE mode = 'team' AND team = ? AND left_at IS NULL` (when the column exists). Courier `numberPending`: `AND p.left_at IS NULL` in the team branch (when the column exists).
- [ ] **Step 4: Run, expect PASS**, plus the core and courier suites.
- [ ] **Step 5: Commit** `feat(core): migration 0010, the "left team" mark on a project (stage B2, P11)`.

---

### Task 2: copy in core (`planCopy`, `applyCopy`)

**Files:**
- Create: `core/src/ops/copy.ts`
- Modify: `core/src/index.ts` (export), `core/src/entry-write.ts` (`COPIED_TO_PREFIX`, `isCopiedToValue`), `core/src/sync/send-filter.ts` (rule 0b, B2-3)
- Test: `core/test/copy.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface CopyArgs { from: string; to: string; author?: string; since?: string }
  export interface CopyItem { ulid: string; ref: string; title: string; author: string | null; created_at: string }
  export interface CopySkip { ulid: string; ref: string; title: string; reason: string } // e.g. "already copied to NV-1"
  export interface CopyPlan {
    source: { kind: "module" | "project"; name: string; label: string };
    target: { ulid: string; code: string; name: string; mode: "solo" | "team" };
    filters: { author: string | null; since: string | null };
    items: CopyItem[]; skipped: CopySkip[];
  }
  export interface CopyDone { from: string; from_ulid: string; to: string; to_ulid: string; pending: boolean }
  export interface CopyResult {
    plan: CopyPlan; copied: CopyDone[];
    links_repointed: number;        // refs + superseded_by re-pointed inside the set
    copied_to_added: number;        // one per original
    pending_reason?: string;        // team target, office not reached
  }
  export function planCopy(db: DB, args: CopyArgs): CopyPlan;                 // reads only
  export async function applyCopy(db: DB, plan: CopyPlan): Promise<CopyResult>;
  export function copyPlanLines(plan: CopyPlan): string[];
  export function copyResultLines(r: CopyResult): string[];
  export const COPIED_TO_PREFIX = "copied_to:";
  ```
  `applyCopy` re-plans inside its transaction and refuses when the notes changed since the plan (a note gone, or a new one matching): "the notes changed since the list was shown; nothing was copied, run it again".

- [ ] **Step 1: Failing tests** `core/test/copy.test.ts` (temp notebook):
  - **Module → solo (spec "Copy" 1):** E-1 (`m`), E-2 (`m`,`x`), E-3 (`x` only), E-4 (`m`, tombstoned), SH-1 (`m`, solo SH). `planCopy({from:'m', to:'NV'})` lists E-1, E-2 only. `applyCopy` → NV-1, NV-2 with the same title/summary/body/type/status/modules/author/created_at, new ulids, `series='NV'`, `project_ulid` = NV.
  - **Links (Review Focus 1):** E-1 refs E-2 and E-9 and a file ref; E-2 is superseded by E-1. After the copy: NV-1 refs `NV-2` (target = NV-2's ulid), `E-9` unchanged, the file ref; NV-2 `superseded_by_ulid` = NV-1's ulid and `superseded_by` NULL; `links_repointed = 2`.
  - **Originals unchanged apart from `copied_to`:** a snapshot of every column of E-1/E-2 and of their refs/modules before and after; the only difference is one new ref `copied_to:<copy ulid>` each, with `target_ulid` set. Body mentions (`see E-2`) are not rewritten in the copy.
  - **Team → solo with author filter (spec "Copy" 2, Review Focus 2):** shared notebook (`enableSync`, office fingerprint), team SH with notes by `naveen` and `rinku` (author set via `COLLAB_AUTHOR`), `setAllocator` to a fake that throws and counts calls. `planCopy({from:'SH', to:'P1', author:'me'})` with `COLLAB_AUTHOR=naveen` lists naveen's notes only; `applyCopy` → `P1-1..`, the allocator was called 0 times.
  - **`--since`:** only notes with `created_at >= since`; a bad date → error naming the accepted form (YYYY-MM-DD).
  - **Run twice (Review Focus 5):** second plan has 0 items and skips each with "already copied to NV-n"; a copy whose copy was deleted is listed again.
  - **Refusals:** target = source; target is a left project; target unknown (lists known codes); `--to none`/an E target; `--from` matching both a project code and a module slug (message names `project:` / `module:`); nothing matched → empty plan, `applyCopy` refuses "nothing to copy".
  - **Team target:** fake allocator answers 5, 6 → `SH-5`, `SH-6`; a throwing allocator → pending copies with `pending_reason`, the allocator called once (then the rest go pending without asking).
  - **Send rule 0b:** on a shared notebook, a `copied_to` refs change of a team note → `skip`; a normal ref of that note → `send`.
  - **Formatters:** `copyPlanLines` starts `Copy 2 notes from module m (E notes) into NV (Navi, solo):`, one line per note `  E-00001  decision  title  (author, date)`, then the skip lines, then `Nothing copied yet.`; `copyResultLines` lists `E-00001 -> NV-1` lines and a final count line.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (one transaction for the write; the allocator, team targets only, is asked BEFORE the transaction, one try per note with `SAVE_ATTEMPT`, stopping after the first failure). Insert each copy with `insertEntryRow` (target series, `assigned`/`pending`), then `UPDATE` author/created_at/deprecated on the copy, copy `entry_modules`, then refs (re-pointed or unchanged, never `copied_to:`), then supersede links, then the originals' `copied_to` refs (`INSERT OR IGNORE`).
- [ ] **Step 4: Run, expect PASS**, plus the core suite.
- [ ] **Step 5: Commit** `feat(core): copy notes into a project, links re-pointed, copied_to on the original (stage B2, P8)`.

---

### Task 3: read-only notes of a left team, and the marks (P11, rule 8)

**Files:**
- Modify: `core/src/projects.ts` (`ReadOnlyNoteError`, `assertNoteWritable`), `core/src/ops/edit.ts`, `core/src/ops/update.ts` (update, refs, resolveNeedsMerge), `core/src/ops/merge.ts` (`resolveWithText`), `core/src/ops/supersede.ts`, `core/src/ops/task.ts` (done cascade skips left notes), `core/src/ops/add.ts` (no note into a left project), `core/src/ops/get.ts` (`EntryFull.left_team`, `EntryRef.copied_to`), `core/src/ops/doctor.ts` (`projects.left`; `projects.team_office` ignores left projects), `core/src/ops/hub.ts` (copied_to is not an out-link)
- Test: `core/test/project-left.test.ts` (extend), `core/test/doctor-projects.test.ts` (extend)

**Interfaces:**
- Produces:
  - `class ReadOnlyNoteError extends Error`
  - `assertNoteWritable(db, ulid): void`: throws `ReadOnlyNoteError("[collab] SH-3 is a note of SH (Support), a team you left: it is read-only. To edit it, copy it into a solo project: collab copy --from SH --to <solo code>")`
  - `EntryFull.left_team?: true` (only when true, so goldens don't change), `EntryRef.copied_to?: true`

- [ ] **Step 1: Failing tests:** a team SH note, then `markProjectLeft(db,'SH')`:
  - `updateEntry`, `updateEntryRefs`, `editEntry`, `supersede` (SH note as old, and as `by`), `resolveWithText`, `addEntry({project:'SH'})` → `ReadOnlyNoteError` with the fix; the row is unchanged.
  - a task done cascade leaves the left handoff `active`.
  - `deleteEntry` works (tombstone).
  - after `applyCopy` into solo P1, `updateEntry` on the P1 copy works.
  - `getEntryByRef(SH-1).left_team === true`; the `copied_to` ref has `copied_to: true` and a target.
  - doctor: `projects.left` warn "SH (Support): you left this team; its 3 notes are read-only (1 never got a number). To edit them, copy them into a solo project: collab copy --from SH --to <solo code>"; no `projects.team_office` error for it; no left project → ok line.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** One check (`assertNoteWritable`) at the top of each writer, after the note is resolved and before any write. `hasProjectLeft(db)` false → no-op.
- [ ] **Step 4: Run, expect PASS**, plus the core suite (goldens unchanged).
- [ ] **Step 5: Commit** `feat(core): notes of a team you left are read-only and say so (stage B2, P11)`.

---

### Task 4: `collab copy` and shared project texts in the CLI

**Files:**
- Create: `cli/src/copy.ts`; `core/src/project-text.ts` (`projectCreatedLines`, `projectListLines`, `teamProjectCreatedLines`)
- Modify: `cli/src/io.ts` (`ask?`), `cli/src/bin.ts` (TTY `ask`), `cli/src/main.ts` (route + usage), `cli/src/project.ts` (use the shared texts; list marks `left team, read-only`)
- Test: `cli/test/copy.test.ts` (new), `cli/test/project.test.ts` (unchanged output for solo/team; one new left case)

- [ ] **Step 1: Failing tests:**
  - `collab copy --from m --to NV` with no `ask` → prints `copyPlanLines`, then `Nothing copied: run again with --yes, or answer y when asked.`; exit 0; nothing written.
  - with `ask` answering no → "Nothing copied."; yes → `copyResultLines`; `--yes` → same without asking.
  - `--author me`, `--since 2026-01-01` pass through; a bad flag/missing `--to` → usage, exit 2; a refusal → `collab: …`, exit 1.
  - `project list` shows `team (left team, read-only)` for a left project.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus the cli suite.
- [ ] **Step 5: Commit** `feat(cli): collab copy lists, asks, then copies (stage B2, P8)`.

---

### Task 5: MCP tools `collab_copy`, `collab_project_create`, `collab_project_list` (user decision 2026-10-11)

**Files:**
- Modify: `mcp/src/server.ts` (three tools; `formatEntry` shows `left team, read-only` and `copied to NV-1`; search heads mark left notes; `statusFor` says `left team: read-only`)
- Test: `mcp/test/project-tools.test.ts` (extend)

**Interfaces:**
- `collab_copy {from, to, author?, since?, dry_run = true}` → text = status line of the target + `copyPlanLines` (dry run) or `copyResultLines`; `structuredContent` = the plan or the result.
- `collab_project_create {name, code, team?: boolean}` → `projectCreatedLines` / `teamProjectCreatedLines`; structured = the project.
- `collab_project_list {}` → `projectListLines`; structured = `{ projects: [...] }`.

- [ ] **Step 1: Failing tests** (spawned server, as the existing file):
  - `collab_copy {from:'demo', to:'NV'}` (dry run default) lists, writes nothing (count rows before/after); the text equals the CLI's lines for the same notebook (Review Focus 4).
  - `collab_copy {…, dry_run:false}` → result lines; the copies exist; the originals carry `copied_to`.
  - refusals are tool errors with the same sentence as the CLI.
  - `collab_project_create {name:'Navi', code:'NV'}` → the CLI's sentence; then `collab_project_list` lists it with the CLI's line format; a clash → tool error with the P10 message.
  - `collab_get` of a left note shows `left team, read-only`; `collab_update` of it → tool error with the fix.
- [ ] **Step 2: Run, expect FAIL** (after `tsc` in core and mcp).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus every mcp test file.
- [ ] **Step 5: Commit** `feat(mcp): collab_copy, collab_project_create, collab_project_list behave like the CLI (stage B2)`.

---

### Task 6: leak tests (spec Testing "Leak tests") and copy through a real office

**Files:**
- Test: `courier/test/copy-leak.test.ts` (new; `startOffice` / `joinedDb` / `openWriter` from `world.ts`)

- [ ] **Step 1: Tests:**
  - **Solo note tagged with a team project's module:** team SH note in module `support` and solo P1 note in `support` → after `syncNow()` the office has the SH note and nothing keyed by the P1 note.
  - **E note in a module of the same name as a team module:** E note in `support` (not a shared module) → never at the office, while SH notes in `support` are.
  - **Team → solo copy, then push (Review Focus 2):** A's SH notes, copied into P1 with `--author me`; `syncNow()` → the office has no change keyed by any P1 copy and no `copied_to:` ref; B pulls and B's SH notes have no `copied_to` ref.
  - **Left team:** after `markProjectLeft`, A deletes a left note → the tombstone is not sent; a left pending note is never numbered (`numberPendingNow` leaves it).
- [ ] **Step 2: Run** (these test existing + Task 1-2 behaviour; any failure is a bug in those tasks).
- [ ] **Step 3: Commit** `test(courier): leak tests for copies, copied_to and left projects (stage B2)`.

---

### Task 7: verification (no code)

- [ ] **Step 1:** Full suites: core, courier, post-office, cli, mcp (all files). Expected: baseline plus the new tests, 0 failing.
- [ ] **Step 2 (Windows, the user):** rule-1 check on a COPY of the real `collab.db` (0009 → 0010: every `E` note, module, search and doctor result identical; `left_at` NULL everywhere); then update the office and both laptops together (schema guard) and try `collab copy --from portfolio --to <solo>` with the list and the question.
- [ ] **Step 3:** Collab handoff `▶ NEXT: stage B2 on branch collab-piece2-stage-b2, not merged; next = D (join/leave calls markProjectLeft)`.
