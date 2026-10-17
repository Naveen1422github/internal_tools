# Collab RnR stage S2 (change enforcement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The post office refuses changes the sender's role doesn't allow, the sender's laptop is reverted and keeps what was typed, and the laptop checks the same keys first so a refusal is rarely a surprise.

**Architecture:** A batched classifier in the office maps every incoming cell to one catalog key. It judges each laptop transaction (`site_id` + `db_version`) as a whole. Refused groups are not recorded. The office writes its own value back so the sender reverts, and lists the refusal in the `POST /v1/changes` answer. The courier saves the refused values in a new local table (`refused_changes`, migration 0013) before it moves its sent-bookmark. `POST /v1/allocate` checks `note.create`. In core, `can()` reads `access_cache` and gates every write op, so the CLI, web and MCP all get the role check. The AI layers come in S4.

**Tech Stack:** TypeScript (ESM), better-sqlite3 + cr-sqlite, Node `https`, `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-17-collab-rnr-design.md`. S2 covers R4, R5, R6, R7, and R8 with `actor` (role layer only). The S1 residuals carried here (COLLAB-182/183): the replay barrier, project moves on team notes, and the allocate gate. R9/R10 (AI settings, drafts) are S4. The team admin UI is S3.

## Global Constraints

- New branch `collab-rnr-s2` from `collabv1` (currently `2ee816d`), in a worktree. Never commit to `collabv1`; the user merges.
- Solo projects, `E` notes and legacy shared-module notes are never classified or refused (spec rule 2). A solo save does zero access lookups and makes no network call.
- No `po_*` table and no new local table goes into `SYNCED_TABLES` or `CRR_ALTERS`.
- Budgets (spec rule 6): the office's classifier plus S1's stamping together add < 5 ms per accepted 2000-change batch. Task 1 measures S1's share; the classifier gets the rest. The laptop `can()` check is < 1 ms p99 over 10k calls.
- A refusal is never an HTTP error on `POST /v1/changes`. It answers 200 with `refused: [...]`. Any non-200 makes `push()` retry forever.
- Every refusal names the missing key in S1's wording: `You need "<label>" (<key>) in <CODE> to do this`. A structural refusal (no key) says what to do instead.
- Migration 0013 bumps the schema again. Every laptop (Rinku) must update after the merge.
- Codex and subagents never push. Each task runs only its targeted test files. The full suite runs once in Task 9, in a background subagent.

## Decisions made in this plan (my calls; the user can overrule)

| # | Decision | Default and why |
|---|---|---|
| S2-1 | A note's `project_ulid` changes on an existing note (team→other, team→none, none/E→team) | **Refused, structural:** "A note can't move between projects: copy it instead". No core op moves a note between projects, so only a hand-edited notebook sends this. Accepting it would make the note's later cells stamp NULL and leak to everyone (the S1 carry-over). |
| S2-2 | `project.make_solo` and `project.delete` | **Flip to `active: false`.** Neither op exists in core, CLI or web, so they guard nothing (rule 4). This overrules R7b's "ship active" for these two only. `project.edit` stays active and gates `renameProject`. |
| S2-3 | `module.create` / `module.edit` (office scope) | **Enforced in the classifier** on `modules` rows: insert of a slug the office lacks = `module.create`; any other cell = `module.edit`. Checked with `officeKeys`. |
| S2-4 | Team project with no `access_cache` row on the laptop | **Allowed by `can()`** (cache not fetched yet, or an older office). The office is the backstop (rule 3). |
| S2-5 | Save-time 403 from allocate (`addEntryAsync`) | **Throw the plain refusal; save nothing.** A human (or their AI) is waiting on the answer, and `can()` normally refuses before the call anyway. The courier's 403 path (a stale cache, an offline save) records into `refused_changes`. |
| S2-6 | "Own" note on the laptop | The note's `created_at` cell was written on this laptop (its clock row's site is local). This is a UX guess only; the office's `po_note_owners` decides. |
| S2-7 | Table name | `refused_changes` (R6). The spec's "refused_notes" means the same table. |

## Review Focus

1. **A transaction split across two POSTs.** `pagesOf` keeps only one note's `entries` cells together. A group's `refs`/revisions can land in the next page, so the office would judge half a group. Pages must keep whole `(site_id, db_version)` groups. Test lives in Task 6.
2. **An all-refused batch must still ring the sender.** `server.ts` rings `changes` only when `accepted > 0`. A write-back is an office write, so it must ring the sender, or the laptop stays unreverted until its next pull. Test lives in Task 4.
3. **The refused values survive a crash.** The courier writes `refused_changes` in the same transaction that moves `K.sent`. A crash before that means a resend, and the office answers the same refusal again (it is idempotent). Test lives in Task 6.
4. **No refusal loop.** A note whose creation was refused is never sent or numbered again from that laptop. If a forged laptop sends it anyway, the office drops it silently. Test lives in Task 6.
5. **Supersede/archive side cells.** Ops also write `updated_at`/`status` on the target note in the same transaction. A Contributor-plus-`note.supersede` role must not be refused for `note.edit.any` on them. Classify per (group, note): an action cell carries the rest of that note's cells. Test lives in Task 3.

---

### Task 1: Spike — write-back mechanics, op→cells table, timing baseline

No product code. The output is a findings file. **Gate:** if no mechanism in Step 1 gives a forced version, stop and bring R6 back to the user before Task 4.

**Files:**
- Create: `post-office/test/spike-writeback.test.ts` (kept as a regression test of whichever mechanism wins)
- Create: `docs/superpowers/plans/2026-10-18-collab-rnr-s2-spike.md` (findings)

- [ ] **Step 1: Forced-version write-back.** Use two stores: an office store and a laptop notebook with cr-sqlite. The laptop edits `entries.title` three times offline (col_version 4). The office holds version 1. Find a way for the office to emit its own value at col_version 5 so the laptop reverts on apply. Try, in order:
  (a) a dedicated write-back site id (16 random bytes kept in meta `writeback_site_id`), inserted into the office's `crsql_changes` with the chosen `col_version`, then recorded as an `OFFICE_ORIGIN` delivery explicitly;
  (b) the office's own `crsql_site_id()` via the same insert;
  (c) repeated UPDATEs.
  Record which works and whether `recordOwnChanges` sees it.
- [ ] **Step 2: Row tables.** The laptop adds a `refs` row and an `entry_revisions` row that the office never had. Find the tombstone (`cid = '-1'`, `cl` = laptop's `cl` + 1) the office can emit so the row is deleted on the laptop. Check that another member applying the tombstone is harmless. After the revision is removed, check that `headsOf(revisionsOf(laptop, ulid))` is the office's head.
- [ ] **Step 3: Op→cells table.** For each op, run it on a team note in a test notebook and list the cells it emits (`readOwnChanges` since the db_version before the op): `addEntry`, `updateEntry`, `editEntry`, `updateEntryRefs`, `reassignModule`, `supersede`, `archive`, `deleteEntry`, `resolveNeedsMerge`, `resolveWithText`, `assignPendingNumber`, `applyCopy` (out of a team project), `renameProject`. Columns: op, table, cid, value pattern, same db_version as the main cell? Task 3 is built from this table.
- [ ] **Step 4: Timing baseline.** Using S1's `opts.timing` hook, record the median `stampMs` of a 2000-change team batch over 5 runs on this Windows laptop. The classifier budget = 5 ms − that figure. Write it in the findings.
- [ ] **Step 5: Commit** — `test(post-office): RnR S2 spike — write-back mechanism + op cell map`

---

### Task 2: Replay barrier (S1 residual, first item)

**Files:**
- Modify: `post-office/src/deliveries.ts` (`fetchDeliveries`)
- Test: `post-office/test/replay-barrier.test.ts`

**Interfaces:**
- Produces: `fetchDeliveries` keeps its signature. While the caller has a `po_replays` row for project P, P rows in the page are withheld, and that row's `upto_seq` is raised to the page's last seq (`UPDATE po_replays SET upto_seq = MAX(upto_seq, ?)`), in the same transaction as the bookmark update. The replay then carries them in seq order, after the history. `lastSeq` advances as today, so nothing is lost and other projects never wait.

- [ ] **Step 1: Failing tests**

```ts
test('a P row fetched while a replay of P is owed is withheld and moved into the replay', ...);
  // R gets note.view in P at seq 10 (po_replays upto 10); N edits an old P note (seq 11);
  // fetchDeliveries(R, after 10) -> no seq-11 row; po_replays.upto_seq = 11;
  // fetchReplay(R, P, 0) returns seq <= 11 in order, ending with the edit
test('other projects and NULL rows still flow while P is owed', ...);
test('after the replay is confirmed done, P rows flow through the normal fetch again', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/replay-barrier.test.ts`
- [ ] **Step 3: Implement.** Wrap `fetchDeliveries` in `db.transaction(...).immediate()`. Read the caller's owed projects once per call.
- [ ] **Step 4: Run** `npx tsx --test test/replay-barrier.test.ts test/replay.test.ts test/deliveries-by-project.test.ts test/deliveries.test.ts`. **Expect PASS.**
- [ ] **Step 5: Courier test** in `courier/test/access.test.ts`: `'stream pull while a replay is owed leaves no id-NULL note'`. Grant R membership, N edits an old note, R's `pullNow()` runs before `refreshAccess`, then `syncNow()`. Assert: no `entries` row with `id IS NULL`, and the edit is present. Run `cd courier && npx tsx --test test/access.test.ts`, **expect PASS.**
- [ ] **Step 6: Commit** — `fix(post-office): rows of a project owed a replay go through the replay (RnR S1 residual)`

---

### Task 3: The classifier (R4, R5 grouping, R7 whole-note rule)

A pure judge: it decides, it writes nothing.

**Files:**
- Create: `post-office/src/classify.ts`
- Modify: `post-office/src/store.ts` (`PO_SCHEMA`: `po_refused_notes (ulid TEXT PRIMARY KEY, device_id TEXT NOT NULL, key TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`)
- Test: `post-office/test/classify.test.ts`

**Interfaces:**
- Consumes: `projectKeys`, `officeKeys` (`access.ts`); `firstTextCell`, the batched entry lookup idea from `resolve()` (`deliveries.ts`); `labelOf` (core catalog); the Task 1 op→cells table.
- Produces:
  - `interface Refusal { site_id: string /* hex */; db_version: number; ulid: string | null; key: string | null; reason: string }`
  - `interface Verdict { groups: Map<string /* groupKey */, Refusal | null>; groupOf: string[] /* per raw */ ; creations: Map<string /* ulid */, string /* groupKey */> }`
  - `function groupKey(r: RawChange): string` = `hex(site_id) + ':' + db_version`
  - `function classify(db: Store, origin: string, raws: RawChange[]): Verdict`. Two to four `IN (...)` queries per call, never one per change.

Rules (spec R4, with the Task 1 table deciding the side cells):
- A cell's note: `entries` → pk; `refs`/`entry_modules` → pk's entry ulid; `entry_revisions` → the batch hint or the store (as `resolve()` does). Its project: the office's `entries.project_ulid` for an existing note; the batch's `project_ulid` cell for a new one.
- No project, E series, or a solo project the office doesn't know → not judged (rule 2).
- A note the office doesn't hold, with an `entries` insert in this batch → `note.create` for every cell of that note in the group.
- An existing note, per (group, note): `superseded_by` set → `note.supersede`; `deleted_at` or `deprecated` changed → `note.archive`; `needs_merge` 1→0 → `merge.resolve`. Each of these carries the note's other cells in that group (Review Focus 5). Otherwise → `note.edit.own` if `po_note_owners` says `origin` created it, else `note.edit.any`.
- `project_ulid` differs from the office's value on an existing note → structural refusal (S2-1), `key: null`.
- A ulid in `po_refused_notes` → refused, `key: null`, reason "this note was refused when it was created".
- `refs`/`entry_modules`/`entry_revisions` of a note the office doesn't hold and that isn't in the batch → not judged here (S1 holds it as `'?'`; Task 4 purges it if the creation is refused later).
- `modules` rows → S2-3, `officeKeys`.
- One refused cell refuses its whole group. The reason comes from the first refused cell.

- [ ] **Step 1: Failing tests** (one per key, plus the edges). Use `post-office/test/office.ts` helpers; roles via `setProjectMember`.

```ts
test('Contributor: create, edit own -> allowed; edit any, supersede, archive, resolve -> refused naming the key', ...);
test('forged author: author cell = N on R\'s edit to N\'s note is still edit.any', ...);
test('supersede side cells ride on note.supersede (role = Reader + note.supersede)', ...);   // Review Focus 5
test('one refused cell refuses its whole group; another group in the batch is allowed', ...);
test('project_ulid change on an existing team note -> structural refusal, key null', ...);
test('E note and legacy shared-module note cells are never judged', ...);
test('modules insert needs module.create, update needs module.edit (office keys)', ...);
test('a ulid in po_refused_notes is refused whatever the role', ...);
test('classify 2000 cells within the Task 1 budget', ...);
  // median of 5 runs; assert classifyMs < (5 - stampBaselineMs from the spike)
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/classify.test.ts`
- [ ] **Step 3: Implement `classify.ts`** with a header comment quoting R4 and R5.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): RnR change classifier, judged per laptop transaction (R4/R5)`

---

### Task 4: Enforce in acceptChanges, write back, gate allocate (R5, R6, R7)

**Files:**
- Modify: `post-office/src/deliveries.ts` (`acceptChanges`), `post-office/src/server.ts` (`POST /v1/changes`, `POST /v1/allocate`), `post-office/src/store.ts` (`allocate` gets the caller and checks)
- Create: `post-office/src/writeback.ts`
- Test: `post-office/test/enforce.test.ts`

**Interfaces:**
- Consumes: `classify` (Task 3); the mechanism from Task 1.
- Produces:
  - `function writeBack(db: Store, refused: RawChange[]): DeliveryRow[]` in `writeback.ts`. For each refused `(table, pk, cid)` on a row the office holds: the office's current value at col_version = (highest refused version for that cell) + 1. For a row the office lacks: a tombstone (Task 1 Step 2). Recorded as `OFFICE_ORIGIN` deliveries and stamped like any office write.
  - `AcceptResult` gains `refused: Refusal[]`. Only allowed groups are recorded and applied. Refused groups produce write-backs. Every refused creation goes into `po_refused_notes (ulid, origin, key)`, and held `'?'` rows of that ulid are deleted.
  - `POST /v1/changes` answer: `{ accepted, duplicates, last_seq, refused }`. It rings `changes` to everyone, the sender included, whenever the office wrote a write-back or merge (Review Focus 2).
  - `allocate(db, ulid, deviceId, series)`: for a team series, `requireProjectKey(db, deviceId, <project ulid of series>, "note.create")` before numbering. When it refuses, it records `po_refused_notes`. An already-allocated ulid still returns its number (idempotent, E-713).
  - Idempotent: resending a refused group returns the same `refused` entry, and the write-back is not duplicated (de-duplicated by `(table, pk, cid, col_version)`).

- [ ] **Step 1: Failing tests**

```ts
test('refused edit: nothing recorded for the group, sender reverts after pulling the write-back', ...);
  // laptop R (Contributor) edits N's note 3 times offline; push; pull; R's title == office title
test('refused edit wins over a run of offline edits (version = max + 1)', ...);
test('refused new ref / revision row is tombstoned on the sender; other members unaffected', ...);
test('mixed batch: allowed group delivered to N, refused group answered in refused[]', ...);
test('all-refused batch still rings the sender', ...);   // Review Focus 2
test('resend of a refused group: same refusal, no second write-back', ...);
test('allocate without note.create -> 403 naming note.create; po_refused_notes has the ulid', ...);
test('held "?" rows of a refused creation are purged, never released', ...);
test('accept + classify + stamp + write-back for 2000 changes < 5 ms extra', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/enforce.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/enforce.test.ts test/classify.test.ts test/deliveries.test.ts test/deliveries-by-project.test.ts test/merge.test.ts test/merge-resolve.test.ts test/server.test.ts test/projects.test.ts test/spike-writeback.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): refuse what the role doesn't allow, write the office value back, gate allocate (R5-R7)`

---

### Task 5: Local `refused_changes` (migration 0013) and its core API

**Files:**
- Create: `mcp/migrations/0013_refused_changes.sql`, `core/src/access/refused.ts`
- Modify: `core/src/db.ts` (known migrations), `core/src/ops/doctor.ts` (expect the table), the `latestMigration === '0012_access_cache'` assertions (find them with `grep -rn 0012_access_cache */test`), and the COLLAB-124 golden table count (+1); `core/src/index.ts` (re-export)
- Test: `core/test/refused.test.ts`

**Interfaces:**
- Produces:
  - Table (local, plain `BEGIN/COMMIT` like 0012): `refused_changes (ulid TEXT PRIMARY KEY, note_ulid TEXT, project_ulid TEXT, kind TEXT NOT NULL CHECK(kind IN ('new','edit')), key TEXT, reason TEXT NOT NULL, cells TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))` plus `CREATE UNIQUE INDEX refused_new_once ON refused_changes(note_ulid) WHERE kind = 'new'`.
  - `function recordRefusal(db: DB, r: { noteUlid: string | null; projectUlid: string | null; kind: "new" | "edit"; key: string | null; reason: string; cells: WireChange[] }): string`: for `kind: 'new'`, a second record of the same note updates the reason; it never duplicates.
  - `function listRefused(db: DB): RefusedRow[]`, `function isRefusedNote(db: DB, ulid: string): boolean`
  - `async function copyRefused(db: DB, id: string, toCode: string): Promise<{ id: number; series: string }>`: rebuilds the note's fields (the local note, overlaid with the refused `entries` cells) and saves a new note in the solo project `toCode` via `addEntryAsync`. A team target is refused ("copy into a solo project"). Then it drops the refusal, and for `kind: 'new'` also the local note.
  - `function discardRefused(db: DB, id: string): void`: drops the refusal, and for `kind: 'new'` also the local note (its rows in `entries`, `refs`, `entry_modules`, `entry_revisions`, in one transaction).

- [ ] **Step 1: Failing tests:** 0013 is local and latest; `recordRefusal` dedupes `new`; `copyRefused` of an `edit` builds the note from the refused title/description into the solo project; `copyRefused` to a team project is refused; `discardRefused` of a `new` removes the local note.
- [ ] **Step 2: Run, expect FAIL** — `cd core && npx tsx --test test/refused.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/refused.test.ts test/access-cache.test.ts test/bind.test.ts test/project-left.test.ts test/known-migrations.test.ts test/setup-doctor.test.ts`, **expect PASS.**
- [ ] **Step 5: Commit** — `feat(core): 0013 local refused_changes + recover/discard (RnR R6, schema bump)`

---

### Task 6: Courier — whole-transaction pages, recording refusals, allocate 403

**Files:**
- Modify: `courier/src/engine.ts` (`pagesOf`, `push`, `numberPending`, `notice`), `core/src/sync/send-filter.ts` (a note with `isRefusedNote` → `skip`), `core/src/sync/http-allocator.ts` (a 403 carries `{ refused: true, key }` on the error)
- Test: `courier/test/refusals.test.ts` (uses `courier/test/world.ts`)

**Interfaces:**
- Consumes: Task 4's `refused[]` answer and allocate 403; Task 5's `recordRefusal` and `isRefusedNote`.
- Produces:
  - `pagesOf(batch, noteOf, size)`: also never splits one `(site_id, db_version)` group. A group bigger than `size` goes alone on its own page (Review Focus 1).
  - `push()`: collects `refused` from every page answer. In the SAME transaction that moves `K.sent`, it records each refusal (`cells` = that group's changes from the batch; `kind: 'new'` when `key === 'note.create'`, else `'edit'`) (Review Focus 3).
  - `numberPending()`: skips `isRefusedNote` rows. An allocate 403 records `kind: 'new'` with the note's current cells and is not shown as a numbering problem again.
  - `notice()`: when `refused_changes` has rows, adds `N change(s) refused by the post office: collab refused list`.

- [ ] **Step 1: Failing tests**

```ts
test('a group bigger than one page is never split; groups stay whole across pages', ...);   // Review Focus 1
test('refused edit: values saved in refused_changes, laptop reverted after the next pull', ...);
test('crash between the POST answer and K.sent: resend gives the same refusal, recorded once', ...);   // Review Focus 3
test('offline note in a project where note.create was taken away: refused on numbering, never retried, never sent', ...);   // Review Focus 4
test('courier status shows the refused count', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd courier && npx tsx --test test/refusals.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/refusals.test.ts test/engine.test.ts test/access.test.ts test/team-projects.test.ts test/project-never-sent.test.ts`, and `cd core && npx tsx --test test/send-filter.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(courier): keep transactions whole, record refusals before acknowledging, stop retrying refused notes (R5-R7)`

---

### Task 7: Laptop check `can()` in core ops (R8, role layer)

**Files:**
- Create: `core/src/access/can.ts`
- Modify: the ops from the Task 1 table: `ops/add.ts` (`addEntry`, `addEntryAsync`), `ops/update.ts`, `ops/edit.ts`, `ops/supersede.ts`, `ops/rollup.ts` (`archive`), `ops/delete.ts`, `ops/merge.ts` (`resolveWithText`), `ops/update.ts` (`resolveNeedsMerge`), `ops/copy.ts` (`applyCopy`, source = team), `projects.ts` (`renameProject`); `access/catalog.ts` (S2-2: `project.make_solo`, `project.delete` → `active: false`); `mcp/src/server.ts` (`setDefaultActor("ai")` at start)
- Test: `core/test/can.test.ts`

**Interfaces:**
- Produces:
  - `type Actor = "human" | "ai"`; `function setDefaultActor(a: Actor): void` (process-wide, same pattern as `setAllocator`)
  - `function can(db: DB, projectUlid: string | null, key: string, actor?: Actor): { ok: true } | { ok: false; reason: string }`. Solo, no project or E → `ok` with no query. A team project: a prepared point read of `access_cache` by `scope_key`. No in-memory cache, because the courier writes the table from another process. No row → `ok` (S2-4). An inactive key → refused. `actor` is accepted and ignored until S4 (role layer only).
  - `function assertCan(db: DB, projectUlid: string | null, key: string): void`: throws `AccessDeniedError` (new, `name = "AccessDeniedError"`) with the S1 wording.
  - `function isOwnNote(db: DB, ulid: string): boolean` (S2-6)
  - Each op calls `assertCan` next to its existing `assertNoteWritable`, with the key from the Task 1 table. `addEntryAsync` turns an allocate 403 into `AccessDeniedError` (S2-5).

- [ ] **Step 1: Failing tests**

```ts
test('solo and E: allowed with zero access_cache reads', ...);   // count via a db.prepare spy
test('Reader: create/edit/supersede/archive/resolve/copy-out/rename each throw naming the key', ...);
test('Contributor edits own note -> ok; another device\'s note -> note.edit.any refusal', ...);
test('no cache row for a team project -> allowed', ...);
test('addEntryAsync: allocate 403 -> AccessDeniedError, nothing saved', ...);
test('MCP actor is "ai" and still gets the role check', ...);
test('can() p99 < 1 ms over 10k calls', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd core && npx tsx --test test/can.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/can.test.ts test/access-catalog.test.ts test/add.test.ts test/update.test.ts test/supersede.test.ts test/copy.test.ts test/project-left.test.ts` (use the matching file names under `core/test`) and `cd mcp && npx tsx --test` for its tool tests. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(core): can() role check on every write op; make_solo/delete inactive (R8, rule 4)`

---

### Task 8: CLI and plain-words refusals

**Files:**
- Create: `cli/src/refused.ts`
- Modify: `cli/src/main.ts` (route `refused`), the CLI/web/MCP error mapping, so that `AccessDeniedError` prints only its message (exit 1, web 403, MCP tool error text)
- Test: `cli/test/refused.test.ts`, extend the server tool tests

**Interfaces:**
- Consumes: Task 5 API, Task 7 errors.
- Produces:
  - `collab refused list`: one line per row: when, project code, `new`/`edit`, the note (ref or title), the reason.
  - `collab refused copy <id> --to <SOLO CODE>` → prints the new note's ref. `collab refused delete <id>` → `deleted`.
  - Web: `AccessDeniedError` → 403 `{ error: <message> }`. MCP: the tool answer is the message.

- [ ] **Step 1: Failing tests:** list output, copy to solo, copy to team refused, delete, an `AccessDeniedError` from `collab add` printed as one plain line with exit code 1.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run** `cd cli && npx tsx --test test/refused.test.ts` and the server tool tests touched. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(cli): collab refused list|copy|delete; refusals in plain words everywhere`

---

### Task 9: Acceptance, regression and full suite

**Files:**
- Create: `courier/test/rnr-s2-acceptance.test.ts`
- Test only. If a failure demands product code, fix it in the owning task's files with its own commit.

- [ ] **Step 1: Acceptance**, two laptops plus an office:
  1. N (Owner) makes R a Contributor of SH.
  2. R creates a note → accepted, N receives it.
  3. R edits N's note offline 3 times, reconnects → refused naming `note.edit.any`. R is reverted. `collab refused list` shows it. `copy --to` R's solo project gives a new note with R's text.
  4. R edits its own note → accepted.
  5. N removes R's `note.create` while R is offline. R writes a note offline, reconnects → refused at numbering, never retried, listed.
  6. R tries `supersede` through the MCP path → refused by `can()` before any network call.
  7. An E note and a legacy shared-module note from R still reach N unchecked.
  8. Grant-then-edit race (Task 2): no id-NULL note on R.
- [ ] **Step 2: Regression on copies of the real data,** as in S1 Task 9 Step 2. Copy `mcp/collab.db` and the office store into a temp dir and open them with the new build. Every `entries` row is unchanged. With everyone Owner (R11), a replay of the last 2000 real deliveries through `classify` refuses nothing. `collab doctor` shows no new errors. **Never open the real files for writing.**
- [ ] **Step 3: Full workspace suite once,** in a background subagent: `npm run test:all`. Expected: all pass except the 4 known root golden failures (COLLAB-124, now counting 21 tables) and the ERR_OSSL_ASN1 cert flake. Report counts per package.
- [ ] **Step 4: Commit** — `test: RnR S2 acceptance + real-notebook regression`

---

## After S2 (not part of this plan)

- Merge runbook (as for S1): back up both DBs, merge `--no-ff`, rebuild every package in the same step, migrate the notebook to 0013 (core `migrate()`; the courier doesn't migrate), restart the post office, courier and MCP, push. Rinku updates after.
- S3 team admin UI (with S1 carry-overs: the target's current role check, protected starter names) and the refused list in the UI. S4 AI (R9, R10).
