# Collab easy setup, piece 2: spike verdicts (S2, S3, note-number inventory)

Plan: `docs/superpowers/plans/2026-10-05-collab-join-spikes.md`. Spec: `docs/superpowers/specs/2026-10-05-collab-join-and-teams-design.md`.
Branch `collab-join-spikes` (from e3603ff). No product code changed. Evidence is the spike tests below. All of them are green: tests named "(observed)" assert what actually happens, not what the design hoped for.

| Spike | Verdict |
|---|---|
| S2: one notebook, two post offices, per-module filtering | **TRUE**, with a qualification. No row belonging to another team's note or module reaches an office. Rows that belong to a team-A note can still carry identifiers of team-B and private notes (S2-4). Moving a note between teams is not handled (S2-5a/5b), and hard deletes never travel (S2-6b). |
| S3: migration 0009 `entries.series` via the CRR-alter path | **TRUE**. Tests 1-4 pass. If machines run different migrations, the change fails with a bare `SQL logic error` (S3-5). |
| J17 "links resolve by ULID, never by number" | **Holds for storage, not for readers.** `target_ulid` replicates as a value. Most readers and one writer still go by number. |

Test counts with the spikes: core **269/269** (baseline 265 + 4), post-office **54/54** (baseline 42 + 12).

---

## S2: one notebook, two post offices

File: `post-office/test/spike-two-offices.test.ts`.

Setup: office A shares `alpha`, office B shares `beta`. L1 has one notebook with `alpha`, `beta` and `private`, and pushes to both offices. L2 is a member of A only, L3 of B only. The push filter copies the courier's `push()`/`placeOf()`: L1's own changes after this office's bookmark whose note's **current** primary module is in the office's set, plus the whole note after a `module` change. Bookmarks are kept per office.

| Test | Asserted (by query) | Result |
|---|---|---|
| S2-1 isolation | A holds only `a1`. Its `entries.module`, `entry_modules.module` and `modules.slug` are all `alpha`. There are 0 orphan `refs`/`entry_modules`/`entry_revisions` rows, and the revisions of `a1` are present. B is the same for `beta`. `p1` (private) is in neither office. L2 pulls only `a1` and L3 only `b1`. | pass |
| S2-2 edits both ways | L2's edit to the alpha note reaches A, then L1. L1's edit to the beta note reaches B, then L3. Everyone converges and nothing crosses. After L1 pulls L2's change, L1 pushes **0** changes to A and **0** to B: received changes are not L1's own (site_id), so they are never re-sent. | pass |
| S2-3 bookmarks | Writes interleave x1, y1, x2, y2. L1 pushes to A, then writes y3 and x3 and pushes to A again. B, on its own bookmark, receives y1, y2 and y3, and a re-push sends 0. **Observed:** had B used A's bookmark (one shared bookmark per notebook), B would have received only y3. | pass |
| S2-4 shared side tables | No beta or private note, revision, module row or orphan reaches A. **Observed:** the alpha note's `refs` rows reach A with `ref_value = E-<n>` **and** `target_ulid` of the private note and of the beta note. The secondary tag row `entry_modules(a4, 'beta', is_primary 0)` reaches A, so the slug `beta` crosses (A gets no `modules` row for it). B gets none of a4's rows. On L2 both link targets are named but absent. | pass (observed) |
| S2-5a move of L1's own note, alpha to beta | L1 sends **0** changes to A, so A and L2 keep a **stale** copy (`module = alpha`, the old `entry_modules` row). B gets the whole note (title, summary, body, module `beta`, id). Later edits go to B only, and A's copy freezes. | pass (observed) |
| S2-5b move of a note **written by L2**, alpha to beta | B gets a **hollow** note: `title = ''`, `summary = ''`, `description = NULL`, `id = NULL`, `module = beta`. The move resends only L1's own cells (`readOwnChanges` filters on `site_id`), and those exclude the cells L2 wrote. L3 sees an empty-titled note. | pass (observed) |
| S2-6 delete (tombstone) | L3 tombstones a beta note and pushes to B. L1 pulls and gets `deleted_at` set. The change on L1 carries L3's `site_id`, so L1 pushes 0 to A, and A never holds the note. | pass |
| S2-6b hard delete (causal length) | cr-sqlite records L3's `DELETE` (`cid = '-1'`, even `cl`). **Observed:** `placeOf` can't find the module of a row that no longer exists, so the delete is **never sent** and L1 keeps the note. | pass (observed) |

**Verdict: TRUE.** Tests 1-3 and 6 pass. For test 4 I read the plan's "cross-team row" as a row belonging to another team's note or module, and none reaches the wrong office. Under a stricter reading the tag row in S2-4 and its refs are crossings, and the verdict would be FALSE for exactly these rows of the team-A note a4:
- `refs(a4, entry, E-<private>)` carrying `target_ulid` = the private note's ULID
- `refs(a4, entry, E-<beta>)` carrying `target_ulid` = the beta note's ULID
- `entry_modules(a4, beta, 0)`

These rows reveal that the other notes exist, their numbers and ULIDs, and B's module slug. They reveal no content.

## S3: migration 0009 alter on `entries`

Files: `core/test/spike-0009-series.test.ts` and `post-office/test/spike-0009-replicate.test.ts`. Candidate SQL: `ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';`. It runs through a copy of the `CRR_ALTERS` block (one transaction, `crsql_begin_alter('entries')`, the SQL, `crsql_commit_alter`). No file was added under `mcp/migrations`.

| Test | Asserted | Result |
|---|---|---|
| S3-1 | On a shared 0008 notebook with 3 notes the alter succeeds and every row has `series = 'E'`. **The alter writes no changes:** `crsql_db_version()` is unchanged and there are 0 `crsql_changes` after it, so the default is filled locally on each machine. A later `UPDATE series = 'ACME'` is a tracked change. | pass |
| S3-1b | The same path on an unshared notebook (no cr-sqlite) adds the column. | pass |
| S3-2 | Every `entries` trigger survives: our 8 (`trg_entries_fts_ai/ad/au`, `_updated_at`, `_ulid_immutable`, `_fill_superseded_ulid`, `trg_refs_cascade_delete`, `trg_entry_modules_cascade_delete`) are byte-identical before and after, and cr-sqlite's 3 `entries__crsql_*` are recreated. `searchEntries` finds a new note and an edited old note's new text, and no longer finds the old text. The edit writes a revision. | pass |
| S3-3 | Atomicity: ALTER followed by `SELECT no_such_function()` throws. No `series` column appears, every trigger (ours and cr-sqlite's) is identical, and the clock row count is unchanged. Writes still sync and are searchable, and the real alter succeeds afterwards. | pass |
| S3-4 | The office, L1 and L2 are all altered. `series = 'ACME'` written on L1 reaches the office and L2. An untouched note arrives with `'E'`. A note from before the alter has `'E'` everywhere, and a series change made on L2 reaches L1. | pass |
| S3-5a (observed) | The office and L1 are altered, L2 is not. L2's pull throws **`SQL logic error`** (the column isn't named) and the whole batch rolls back: L2 gets 0 entries, not even the note's other columns. The connection stays stuck on that batch. | observed |
| S3-5b (observed) | L1 is altered, the office is not. `acceptChanges` throws `StoreError: SQL logic error`. Nothing is applied and nothing is recorded in `po_deliveries` (one transaction). | observed |

**Verdict: TRUE.** The 0008 path works unchanged for `entries`, including FTS and every trigger.

## Inventory: every place that takes a note number

Method: grep of `parseEntryRef`, `ownerOf(`, `getEntry(`, `WHERE id =`, `E-${`, `padStart(5`, `/merge/`, `entry/`, tool `id:` params, `server/src/tools`, `ui/src`, `cli/src`, `courier/src`, `post-office/src` and scripts, with key sites checked by hand. "Needs series" means the site must take or carry `(series, id)`, or switch to the ULID.

**Headline: 93 sites need `(series, id)`:** core 30, MCP tools 14, REST routes 16, UI 20, post office 6, scripts 7. CLI and courier have **0** (the courier keys on the ULID). There is **no shared formatter**: 6 local helpers (`toEntryId` in doctor, export and supersede; `eid` in preflight-0006; `pad` in post-office cli; `E` in mcp server) and about 40 inline `E-${…}`, 4 of which don't pad (merge.ts:65, update.ts:109, log-collab.ts:28, sweep-deps.ts:377).

### Core (core/src)
- **Parse and resolve:**
  - `parseEntryRef` (ulid.ts:80) returns a number.
  - `ownerOf` (entry-write.ts:139) resolves `WHERE id = ? … ORDER BY ulid LIMIT 1` and is the main resolver.
  - `getEntry` (ops/get.ts:33) does `WHERE id = ?`.
- **Take a number, then `ownerOf`:**
  - `deleteEntry`
  - `editEntry`
  - `reassignModule(ids[])`
  - `updateEntry`
  - `resolveNeedsMerge`
  - `updateEntryRefs`
  - `getMergeView`, `resolveWithText`, `flaggedUlid` (ops/merge.ts)
  - `supersede`, which also **writes the integer `superseded_by`**
  - `setModuleHub`
- **Allocation:**
  - `nextEntryNumber` (entry-write.ts:51) is MAX(id)+1 over all rows and must become `WHERE series='E'`.
  - `insertEntryRow`
  - `addEntryAsync`, `Allocator.allocate`, `allocateWithRetry`, `http-allocator` all return `{id}`.
- **Payloads and printing:**
  - `searchEntries`/`listRecent`
  - `getModule`: its `onCard` Set at module.ts:169 is keyed by bare `id`, so two series would clash.
  - `getTask.recent_entries`
  - `getHubStatus` payload
  - `doctor` items (C24)
  - `export` (prints the integer `superseded_by`)
  - errors in merge.ts:41,49 (with the `/merge/${id}` link)
  - `formatRollupBody` writes `[E-00nnn]` into stored text
- **Links by number:**
  - rollup.ts:275,412 inserts `ref_value: String(id)` with no `target_ulid`.
  - Trigger `trg_refs_fill_target_ulid` (enable.ts:37; 0005, 0006): its SQL parser knows only `#`, `E-` and `E`, so **`ACME-12` would stay unresolved**, and it has no liveness filter.
  - Trigger `trg_entries_fill_superseded_ulid` (`e.id = NEW.superseded_by`).
  - doctor `orphan_refs` (`parseEntryRef(ref_value)` against ids, doctor.ts:264), `dangling_superseded` (doctor.ts:334) and `duplicate_entry_ids` (`GROUP BY id`, :422).
- **Not affected:** backfill.ts and preflight-0006.ts. They only repair data from before 0006.

### MCP tools (mcp/src/server.ts): 14
- **Take a number as input (5):** `collab_get` (id), `collab_update` (id), `collab_update_refs` (id; its docs say ref_value is "target entry id as a string"), `collab_module_set_hub` (id), `collab_supersede` (ids, by).
- **Print numbers (9):** `collab_search`, `collab_list_recent`, `collab_add` (and its hub hint), `collab_task_get`, `collab_module_get`, `collab_rollup`, `collab_archive`, `collab_export`, `collab_doctor`.

### REST routes (server/src/tools): 16
- **Take a number as input (8):**
  - GET `/api/collab/entry?id=`
  - POST `/api/collab/entry/upsert`, `/entry/delete`, `/entry/supersede`, `/entry/reassign-module`
  - GET `/api/sync/versions?id=`
  - POST `/api/sync/resolve`, `/api/sync/explain`
- **Return numbers (8):**
  - GET `/api/collab/search`, `/stats`, `/dispatches` (`dispatches.entry_id` is an integer link by number written by parse-codex-output.ts:302), `/module-card`, `/export`
  - POST `/api/collab/doctor`
  - GET `/api/sync/needs-merge`
  - POST `/api/ai/chat` (passes ids to the model)

### UI (ui/src): 20 sites
- **The route `/merge/:id`:** App.tsx:21; Merge.tsx reads `Number(useParams().id)`, and NeedsMerge.tsx links to it.
- **EntryDrawer:**
  - get, upsert, delete and supersede by number (supersede through `prompt` + `parseInt`)
  - opens the integer `superseded_by`
  - **resolves entry links by `parseInt(ref_value)`**, so a stored `E-214` is NaN and not clickable (EntryDrawer.tsx:191-202)
- **Number-typed state and API:** `store/ui.ts` `drawerEntryId: number`; `api/client.ts` makes all calls by number.
- **Pages and components that open or print numbers:** CommandPalette, DraftCard, Knowledge, Dashboard, Modules, Health.

### Post office (post-office/src): 6
- `po_allocations(id INTEGER UNIQUE)`: one counter for the whole office.
- `createStore(seedMaxId)`.
- `nextNumber` and `allocate`.
- `POST /v1/allocate` returns `{id}`.
- `seedFromNotesDb` / `--seed-max-id`, which need `series='E'`.
- The `pad` formatter and its prints in cli.ts.

### Scripts (mcp/src/scripts): 7
- `log-collab`
- `manual-search`
- `module-card`
- `seed`
- `sweep-deps`
- `parse-codex-output`, which also writes `dispatches.entry_id`
- `add-log`

### Links and J17
- **Storage holds.** Test `post-office/test/spike-refs.test.ts`:
  - On L1 the trigger fills `target_ulid`, and it is an own, tracked cell.
  - L2 already holds a *different* note numbered 5 with a lower ULID, so re-resolving by number would pick that note.
  - After the pull, L2 and the office hold exactly L1's `target_ulid` (the target, not the clashing note), and the unresolved `E-99999` stays `NULL`. The receiver doesn't re-resolve (the sync-bit guard, E-643). **pass**
- **Readers do not hold.**
  - Only `hub.ts` (`resolveLive`, `getHubStatus`) and doctor's `unresolved_entry_refs` follow `target_ulid` / `superseded_by_ulid`.
  - These resolve **by number**:
    - `getEntry` returns refs without `target_ulid`.
    - The UI EntryDrawer uses `parseInt(ref_value)` and the integer `superseded_by`.
    - doctor `orphan_refs` and `dangling_superseded`.
    - Display of the integer `superseded_by` in mcp server.ts:1293, export.ts:110 and the REST export.
    - `deleteRef` matches exact `ref_value` text.
    - rollup writes links by number and relies on the trigger.
- **J17 does not hold yet.**

### Golden tests
- **11 of the 14 golden snapshot files** will change if the payload gains a `series` field or formatted refs. They are `mcp/test/golden/__snapshots__/*` and `test/golden/__snapshots__/*`.
- **None contains a literal E-number.** `id`/`entry_id` are normalised to `"<id>"`.
  - 9 files have `"<id>"`: mcp_get_entry, mcp_list_recent, mcp_search_all, mcp_search_category_reference, mcp_search_module_demo, rest_search_all, rest_search_category_reference, rest_search_module_demo, rest_stats.
  - The other 2, mcp_doctor and rest_doctor, carry raw ids in `items`.
- **15 test files** assert the E-number format in other tests: 7 use a literal E-number and 8 build one.

---

## What this means for the piece 2 plan

Only facts the spikes established. Items marked **(change)** are ones the design doesn't cover today.

1. **Per-connection bookmarks are required, not optional.** One `crsql_db_version()` sequence with a single "sent up to" mark skips the other team's changes (S2-3). J10/J11 already say this, and the spike confirms it.
2. **Received changes are never relayed between teams.** `readOwnChanges` filters on `site_id`, so a notebook that belongs to two teams doesn't forward team A's changes to B (S2-2, S2-6). Keep that filter as the guarantee.
3. **(change) Moving a note between two teams is unsafe as built.**
   - The old team keeps a frozen, stale copy (S2-5a).
   - If the note has cells written by someone else, the new team receives a hollow note with an empty title and `id = NULL` (S2-5b).
   - The design must either refuse a primary-module change that crosses a team boundary, or define it: send the whole current row (not only own changes) to the new team, and tombstone or retire it toward the old team. With J8 the note also needs a new team number.
4. **(change) Rows of a team note carry identifiers of other notes.**
   - A link to a private or other-team note sends that note's number and ULID (S2-4). The spec's failure table accepts "the link travels".
   - Under J8 an `E-` `ref_value` names the author's private number, which means nothing to teammates. Display should come from `target_ulid` ("not shared with you"), never from `ref_value`.
   - Secondary tags in another team's module send that module's **slug** to the team (S2-4). Rule 2 only says tags never *cause* sending. Decide whether `entry_modules` rows for modules outside the connection's team are filtered out of the push.
5. **(change) Hard deletes don't travel under a module filter** (S2-6b). Today's product code only tombstones, but cascades and scripts hard-delete. Either state that hard deletes are local-only, or place a delete by the row's last known module.
6. **0009 can use the 0008 path for `entries` as is** (S3-1 to S3-4). It writes no sync changes, so every machine must run it itself, and existing notes are `'E'` everywhere. Renumbering into a team series (J16/J19) is an explicit `UPDATE series/id` and replicates (S3-4).
7. **(change) Mixed versions fail with a bare `SQL logic error`** and roll back the whole batch on either side, which blocks that connection (S3-5). The existing schema guard (409 on mismatched `latestMigration`) is what prevents this. Keep it as a hard precondition, and order the upgrade office first, with no `series` writes until every member is on 0009. The guard, not `applyChanges`, must produce the "update this laptop" message.
8. **(change) J17 is a conversion, not an existing property.**
   - Storage already replicates `target_ulid`.
   - Before any renumbering, these must move to the ULID: `getEntry`'s refs (return `target_ulid`), the UI's `parseInt(ref_value)` links, the integer `superseded_by` reads (UI, MCP text, export, doctor), doctor `orphan_refs`/`dangling_superseded`, and rollup's by-number link writes.
   - `trg_refs_fill_target_ulid`'s SQL parser must learn series (`ACME-12` is unresolved today) or be replaced by writers that always pass `target_ulid`.
   - **(change)** `dispatches.entry_id` is a by-number link the spec doesn't mention.
9. **Size of the series change:**
   - 93 sites: 14 MCP tools, 16 REST routes, 20 UI sites including `/merge/:id`, the post office allocator (`po_allocations.id` is one UNIQUE counter), 7 scripts and about 30 core functions. No shared formatter exists, so `formatEntryRef` should land first and replace the 6 helpers and about 40 inline formats.
   - Golden impact: 11 of 14 snapshot files change shape, and none needs a literal E-number edited.
10. **Not tested here:** two real post offices' allocators handing out the same numbers (J8 exists for that), and courier timing (one office down). S1 was out of scope for this plan.
