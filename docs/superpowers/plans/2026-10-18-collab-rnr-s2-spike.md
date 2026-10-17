# Collab RnR S2: spike findings (Task 1)

Date 2026-10-18 · branch `collab-rnr-s2` · cr-sqlite in `vendor/crsqlite` · Windows laptop.
Regression test: `post-office/test/spike-writeback.test.ts` (4 tests, all pass).

**Gate: PASSED.** Every mechanism tried gives a forced col_version. Use **(b)**.

---

## 1. Forced-version write-back (R6)

Setup: the office holds `entries.title` at col_version 1. The laptop edits it three times offline, so it is at col_version 4, and that batch is refused. The office has to emit its own value at col_version 5.

| | Mechanism | Forces cv 5? | Laptop reverts? | `recordOwnChanges` sees it? |
|---|---|---|---|---|
| **(a)** | Dedicated 16-byte site id, `INSERT INTO crsql_changes` | yes | yes | **no**. The cell is stored under the foreign site, so it must be recorded in `po_deliveries` by hand and stamped by hand (R3) |
| **(b)** | The office's own `crsql_site_id()`, same insert | yes | yes | **yes**. It is an own change at a new office db_version, so `acceptChanges` records it as `OFFICE_ORIGIN` and R3 stamps it with the other `own` rows |
| **(c)** | Repeated `UPDATE`s (`A→tmp→A→tmp→A`) | yes (1 + number of UPDATEs) | yes | yes, but it also emits an `updated_at` cell from `trg_entries_updated_at`, fires FTS triggers, and needs N UPDATEs where N depends on the sender's version |

**Recommendation: (b).** It needs no new meta, no hand-recording, and no hand-stamping. It also cannot be dropped as a duplicate (see below). (a) has one advantage: a laptop could tell a write-back apart by its site id. That isn't needed, because the courier learns about refusals from the `refused` list in the POST answer (R5). (c) is noisy and cannot hit an exact version cheaply.

Exact SQL for (b), run inside one office transaction, one row per refused cell:

```sql
-- per refused cell (table, pk, cid); V = (highest col_version in the refused group) + 1
INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq)
VALUES (:table, :pk, :cid,
        (SELECT val FROM crsql_changes WHERE "table" = :table AND pk = :pk AND cid = :cid),  -- the office's current value
        :V,
        crsql_db_version(),   -- see "db_version" below
        crsql_site_id(),
        (SELECT cl FROM crsql_changes WHERE "table" = :table AND pk = :pk AND cid = :cid),   -- the office's current cl
        :i);                  -- 0,1,2... within the write-back
```

After the inserts, the normal `recordOwnChanges` → `stampProjects` path in `acceptChanges` delivers them. The test calls `acceptChanges(store, 'd-x', [])` to run that path.

Facts the test pins:
- **db_version.** cr-sqlite stores `max(passed, office next db_version)`. Passing 1 gives the next version (2). Passing 999 gives 999, and the office's clock jumps to 999 (its next write is 1000). So pass `crsql_db_version()` or smaller, never a guess from the sender.
- **The stored cell** has `site_id = crsql_site_id()`, `col_version = V`, `val` = the office value. The sync bit is 1, so `trg_entries_updated_at` does not fire and no side cell is emitted.
- **Second write-back of the same cell.** The laptop edits again to cv 6, and the office writes back at 7. That write-back is recorded and delivered, not dropped by `INSERT OR IGNORE`: the office clock gives it a fresh db_version, so the `po_deliveries` UNIQUE key differs. This holds for (a) too.
- **The office's next normal write** gets `db_version = top + 1`. No collision, and the `self_db_version` watermark keeps working.
- **`seq` is kept as passed.** Give each write-back cell its own seq.

**Sender.** It applies the write-back like any delivery. Its value goes back to the office's, its clock goes to cv V, and `readOwnChanges` after the apply is empty, so the revert is never re-sent. The courier must save the refused values before applying (R6, `refused_changes`), because after the apply they are gone.

**Other members.** A member holding the office value at cv 1 receives the write-back. The value is unchanged, the clock goes to cv 5, and nothing echoes (`readOwnChanges` is empty). It is harmless, but it costs one delivery per cell per member of the project.

## 2. Row tombstones: refs / entry_revisions rows the office never had

The laptop's refused group contains a new `entry_revisions` row (`cl = 1`) and a new `refs` row (`cl = 1`). The office never had either row. The tombstone is the sentinel cell, and the office can insert it for a pk it has no row for:

```sql
INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq)
VALUES (:table, :pk_from_refused_cell, '-1', NULL, :cl_plus_1, crsql_db_version(), crsql_site_id(), :cl_plus_1, :i);
-- :cl_plus_1 = the sender's cl + 1 (= 2 for a new row): col_version = cl, even = deleted
```

This matches what a real laptop `DELETE` emits: `cid '-1'`, `val NULL`, `col_version 2`, `cl 2`. On the office the tombstone is stored under its own site, so `recordOwnChanges` carries it.

Results (test 3):
- **Sender.** The ref and the revision are deleted, and the title write-back in the same transaction reverts the text. `headsOf(revisionsOf(laptop, ulid))` equals the office's single head again (`[r1]`).
- **Another member** (never had the rows). It has no row before and none after, and no echo. A late resend of the original `cl = 1` insert does not revive the row, because cl 1 loses to the cl 2 tombstone. A member that has the tombstone and later adds the same ref gets `cl = 3`, which beats the tombstone, so a later legitimate add still works.

Three things Task 4 must handle:
1. **R3 holds the revision tombstone forever.** `resolve()` finds an `entry_revisions` row's note by reading `entry_ulid` from the office's `entry_revisions` table. The office never had the row, so the tombstone is stamped `'?'` (held). It then goes to nobody, and every later batch re-resolves it, which is a permanent cost on the stamping budget. The `refs` tombstone is fine, because the first cell of its pk is `entry_ulid`. **Fix in Task 4:** record write-back rows with the note's stamp explicitly. The office knows the ulid from the refused group. The test does this with `UPDATE po_deliveries SET project_ulid = …`.
2. **Never tombstone a pk the office could legitimately receive later.** The root revision id is deterministic (`${ulid}.0`, `rootRevId`). If the refused edit is the sender's first edit, its root row is "new to the office". Tombstoning it means another member's legitimate first edit (root at `cl = 1`, made before it received the tombstone) loses at the office, and the root never arrives (test 4). Rule for Task 4: skip `rootRevId(ulid)`. It is harmless to leave: it holds the text before the first edit, the same text the office has, and it is a parent, never a head. The same hazard applies to `refs`, whose pk `(entry_ulid, ref_type, ref_value)` is deterministic. An unsynced member that adds the same ref with `cl = 1` before receiving the tombstone loses it. That is accepted as rare: the member re-adds it. Record this as a known limit.
3. Only tombstone rows whose clock the office does not have (`SELECT 1 FROM crsql_changes WHERE "table"=? AND pk=?` is empty). A row the office has gets ordinary cell write-backs instead.

## 3. Op → cells

How the table was made: each op ran on a laptop notebook (newest migration plus `enableSync`), on notes in team project `TM` unless marked. The cells are `readOwnChanges(db, dbv_before)`, and each cell is labelled with its owning note via `entryUlidOf`. Before every op, `updated_at` was backdated so that the trigger side cell always shows. In real use **`updated_at` may or may not appear**: it is a one-second-resolution trigger, and cr-sqlite emits nothing when the value does not change. In the table, "new row" means every non-pk column at `cv 1, cl 1`. cr-sqlite emits no cells for pk columns.

**Every op emits all its cells in ONE db_version** (one laptop transaction), including side cells on other notes. R5's refusal unit (`site_id + db_version`) therefore always contains the whole op.

| Op | Table | Note | cid | Value pattern | cl | Same db_version |
|---|---|---|---|---|---|---|
| `addEntry` | entries | new | all 23 non-pk cols (`id, type, kind, title, summary, description, status, agent, module, task_id, tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category, superseded_by, author, superseded_by_ulid, deleted_at, needs_merge, series, project_ulid`) | values, cv 1 | 1 | yes |
| | entry_modules | new | `is_primary`, `entry_id` per module row | 1/0, id; cv 1 | 1 | yes |
| | refs | new | `entry_id`, `target_ulid` per ref | id, NULL/ulid; cv 1 | 1 | yes |
| `updateEntry` (first edit) | entries | same | `title`/`summary`/`description` (as changed), `updated_at`* | new text, cv n+1 | 1 | yes |
| | entry_revisions | same | root `${ulid}.0`: 8 cols (`entry_ulid, parent_rev_id=NULL, title, summary, description, created_at, merged_from=NULL, author`) | old text, cv 1 | 1 | yes |
| | entry_revisions | same | new rev: same 8 cols, `parent_rev_id` = root | new text, cv 1 | 1 | yes |
| `updateEntry` (later edit) | entries + entry_revisions | same | as above, without the root | | 1 | yes |
| `editEntry` | entries | same | each changed field (`type, title, summary, description, module, tokens_estimate`), `updated_at`* | cv n+1 | 1 | yes |
| | refs | same | old rows `-1` (tombstone); new rows `entry_id`, `target_ulid` | NULL, cv = cl even / cv 1 | 2 / 1 | yes |
| | entry_modules | same | old rows `-1`; changed or re-inserted rows `-1` then `is_primary`, `entry_id` | cl even / cl odd (re-insert = cl 3) | 2,3 | yes |
| | entry_revisions | same | new rev (8 cols) when the text changed | | 1 | yes |
| `updateEntryRefs` | refs | same | removed: `-1`; added: `entry_id`, `target_ulid` | | 2 / 1 | yes |
| `reassignModule` | entries | same | `module`, `updated_at`* | slug | 1 | yes |
| | entry_modules | same | old primary `-1`; new primary re-inserted: `-1` (cl odd), `is_primary`, `entry_id` | | 3,4 | yes |
| `supersede` (target T, by B) | entries | **T** | `superseded_by` (int label), `superseded_by_ulid` (B's ulid), **`deprecated` = 1**, `updated_at`* | cv n+1 | 1 | yes |
| | — | B | **nothing**. The replacement is not touched | | | |
| `archive` (target T, creates rollup R) | entries | **T** | **`deprecated` = 1**, `updated_at`* (**E notes only**, see concern below) | cv n+1 | 1 | yes |
| | entries | R (new, series `E`, `project_ulid` NULL, `id` NULL) | all 23 cols, `type='rollup'`, `rollup_of_task='module:<slug>'` | cv 1 | 1 | yes |
| | refs | R | `entry_id` NULL, `target_ulid` = T's ulid (ref R→T) | cv 1 | 1 | yes |
| `deleteEntry` | entries | same | `deleted_at` (datetime), `updated_at`* | cv n+1 | 1 | yes |
| `resolveNeedsMerge` | entry_revisions | same | new rev, 8 cols, `merged_from` = the other head(s) | cv 1 | 1 | yes |
| | entries | same | `needs_merge` = 0 (no `updated_at`: not in the trigger list) | cv n+1 | 1 | yes |
| `resolveWithText` | entries | same | `title`/`summary`/`description` (as changed), `updated_at`*, `needs_merge` = 0 | | 1 | yes |
| | entry_revisions | same | new rev, 8 cols, `merged_from` set | cv 1 | 1 | yes |
| `assignPendingNumber` | entries | same | **`id` only** (NULL → int; no `updated_at`) | cv 2 | 1 | yes |
| `applyCopy` (team TM → solo SO) | entries + entry_modules (+ refs) | each copy (new) | all cols, `series` = target code, `project_ulid` = target; a copied supersede gets `superseded_by_ulid` remapped (cv 2) and `deprecated` copied; `created_at` copied | cv 1 (2 for remapped) | 1 | yes |
| | refs | **each SOURCE team note** | new row `('entry', 'copied-to:<copy ulid>')`: `entry_id`, `target_ulid` = copy | cv 1 | 1 | yes |
| `renameProject` | — | — | **0 cells**. `projects` is not in `SYNCED_TABLES` | | | |

\* `updated_at` may appear (trigger, one-second resolution).

What this means for Task 3 (R4 classifier):
- **The `deprecated` cell is ambiguous.** `supersede` sets `deprecated = 1` together with `superseded_by`/`_ulid`. A group carrying `superseded_by*` on a note is `note.supersede`; `deprecated` in that same group must not also count as `note.archive`. A `deprecated = 1` without `superseded_by*` is `note.archive`. Archive's rollup R is a `note.create` (an E note with no project) plus a ref on R.
- **`applyCopy` out of a team project edits the source team notes** with a `copied-to` ref row. Under R4 that is `note.edit.own/any` on every copied team note. A Reader who copies a team project to their solo project would have the breadcrumbs refused. Task 3 must either accept that or special-case refs with `ref_value LIKE 'copied-to:%'`. **That is a user decision.**
- **`assignPendingNumber`** is a lone `entries.id` NULL→int cell, written by the courier after `/v1/allocate`. The classifier must not treat it as `note.edit`, because R7 already judged the note at allocate time.
- **The revision root** arrives inside the first edit's group. Its `cl = 1` row is an insert into `entry_revisions`, not a new note.
- New row vs existing row: a group is a new note only when the office has no clock for that `entries` pk. Every new-row cell has `cv 1, cl 1`. A re-insert after a tombstone has an odd `cl > 1`.
- `updated_at` carries no meaning. Classify it with whatever else is in the group (an `updated_at`-only group = `note.edit.*`).

## 4. Timing baseline (R3 stamping, `opts.timing.stampMs`)

Harness: the S1 test's harness (`deliveries-by-project.test.ts` "stamping 2000 changes adds < 5 ms"), changed so that **every** note is in one registered team project (a team batch). 3 warm-up batches are followed by **5 measured batches of 2000 changes** each, and the median is taken. It was run 8 times on this Windows laptop:

| Invocation | Median (ms) | Runs (ms) |
|---|---|---|
| 1 | 5.84 | 5.90, 5.84, 6.11, 3.77, 4.33 |
| 2 | 3.55 | 3.95, 2.97, 4.11, 3.55, 3.47 |
| 3 | 3.92 | 5.74, 3.32, 41.27, 3.62, 3.92 |
| 4 | 5.14 | 9.21, 4.83, 6.91, 5.14, 3.88 |
| 5 | 5.07 | 7.89, 3.35, 5.75, 5.07, 4.33 |
| 6 | 4.49 | 7.82, 5.58, 4.49, 3.63, 3.06 |
| 7 | 5.03 | 8.69, 5.03, 7.98, 3.72, 3.92 |
| 8 | 4.57 | 8.19, 4.57, 6.09, 4.49, 3.65 |

**Baseline stampMs ≈ 4.8 ms** (median of the 8 medians; range 3.55–5.84). For reference, the S1 mixed batch (half team, half no-project; 9 runs) gave a median of 4.96 ms in the same session.

**Classifier budget = 5 ms − 4.8 ms ≈ 0.2 ms per 2000-change batch.** That is effectively none: on a noisy run, stamping alone already exceeds 5 ms. The 5 ms target cannot absorb R4 as it stands. Before Task 3, the user should choose one:
- give R4 its own budget, for example ≤ 2 ms per 2000 changes, measured separately;
- raise the combined budget;
- or make the classifier share `resolve()`'s two queries, since it needs the same entry/owner lookups, so its marginal cost is small.

## Pre-existing bugs found (out of scope, for the parking lot)
- **`archive` does not handle series on team notes.** `deprecateOriginals` resolves numbers with the E-only `ownerOf`, so a team note (for example TM-4) is **not deprecated**. `linksTo` resolves `WHERE id = ?` with no series, so the breadcrumb can point at a different note that has the same number.
- **`archive` can leak team-note text (R3).** The rollup R is always an E note with **no project**. Its `description` lists every archived note's title and summary (`formatRollupBody`), so archiving a team project's module copies team text into a note that goes to every member.
- `resolveNeedsMerge(db, id)` resolves E ids only (`ownerOf`), and `resolveWithText` passes no series to `flaggedUlid` (default "E"). So neither can settle a team note's merge by its series number. The table above measured both on E notes.

---

## How to re-run
- Regression test: `cd post-office && npx tsx --test test/spike-writeback.test.ts`
- The op→cells dump and the timing script were throwaway scripts and are not committed. To re-create them: run each op on `laptop()` from `post-office/test/helpers.ts`, then print `readOwnChanges(db, before)` labelled with `entryUlidOf`. For timing, copy the S1 timing test with `projectUlid = A` for every note, `RUNS = 5`.
