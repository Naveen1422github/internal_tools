# Collab easy setup, piece 2: spikes before the build (S2, S3, number inventory)

> **For agentic workers:** this is a SPIKE plan. Its output is evidence and a written verdict, not product code. Do not change anything under `core/src`, `courier/src`, `post-office/src`, `server/src`, `mcp/src`, `cli/src` or `ui/src`. New files only: spike tests and the verdict document.

**Goal:** prove or disprove the three assumptions piece 2's design rests on, before anyone builds it.

**Spec:** `docs/superpowers/specs/2026-10-05-collab-join-and-teams-design.md` (decisions J1-J19, especially J10-J12, J15-J17 and "Risks and open items"). Read it first.

**Branch:** `collab-join-spikes`, created from `collabv1` (942852a, piece 1 merged).

## Global Constraints

- No product code changes (see header). Spike tests live in `post-office/test/spike-*.test.ts` and `core/test/spike-*.test.ts` so they run with the existing suites and stay as regression evidence.
- Tests use temp folders only (`tempStore()`, `laptop()` from `post-office/test/helpers.ts`; `COLLAB_DATA_DIR` / `COLLAB_DB_PATH` set to temp paths). Never a real notebook.
- Every connection that loaded cr-sqlite is closed with `SELECT crsql_finalize()` first (collab E-764); otherwise Windows can't delete the temp files.
- A spike that disproves an assumption is a SUCCESS of this plan: record exactly what failed and stop that spike; do not work around it in product code.
- Report facts with evidence (test name + what it asserted + result). No "should work".

## Review Focus

1. A change in a team-A module leaking into team B's exchange through a shared row (`modules`, `entry_modules`, `refs`, `entry_revisions`) rather than through `entries`.
2. A note MOVED from a team-A module to a team-B module: what each office has afterwards.
3. The FTS triggers on `entries` (`trg_entries_fts_ai/ad/au`) and the other `entries` triggers surviving `crsql_begin_alter('entries')` / `crsql_commit_alter`.
4. Bookmarks: one notebook has ONE `crsql_db_version()` sequence but would keep a "sent up to" bookmark per team.
5. `refs.target_ulid` on a RECEIVING laptop: replicated value vs. re-resolved by the insert trigger (synced rows bypass triggers, collab E-643).

---

### Spike S2: one notebook, two post offices

**File:** `post-office/test/spike-two-offices.test.ts`

Build on the `machine()` pattern in `post-office/test/merge.test.ts` (push = `acceptChanges(store, dev, readOwnChanges(db, since))`, pull = `fetchDeliveries` + `applyChanges` + `reindexFts`), but with a **per-office filter** that mimics the courier's rule (`courier/src/engine.ts` `push()` / `placeOf()`): only changes whose note's PRIMARY module is in that office's module set; for `modules` rows, only that office's slugs.

Setup: two offices `A = tempStore()`, `B = tempStore()`; laptop `L1` (one notebook, member of both: modules `alpha` → A, `beta` → B, `private` → none); laptop `L2` member of A only; laptop `L3` member of B only.

Tests (each asserts with a query, not a log line):
1. **Isolation:** L1 writes notes in `alpha`, `beta`, `private`; push to A (A-filter) and B (B-filter). Assert: A's store has only `alpha` notes (and their `entry_modules`, `refs`, `entry_revisions` rows); B only `beta`; neither has `private`. L2 pulls from A: only `alpha`. L3 pulls from B: only `beta`.
2. **Edits both ways:** L2 edits an `alpha` note, pushes to A; L1 pulls from A; L1 edits a `beta` note, pushes to B; L3 pulls from B. Assert each side converges and nothing crosses.
3. **Bookmarks:** using `crsql_db_version()` per push, keep a separate "sent up to" per office. Interleave writes to `alpha` and `beta`; push to A only, then later to B. Assert B still receives every `beta` change (no change skipped because A's bookmark advanced past it), and re-pushing is a no-op.
4. **Shared side tables:** add a ref from an `alpha` note to a `private` note and to a `beta` note; add a secondary module tag `beta` on an `alpha` note (`entry_modules`). Assert what reaches A and B (row by row) and record whether any `beta`/`private` information reaches A. This is the main leak candidate (Review Focus 1).
5. **Move:** move an `alpha` note to `beta` (primary module change) on L1; push to both. Record what A and B hold afterwards (does A keep a stale copy? does B get the full note?). This is evidence for the design, not a pass/fail judgement.
6. **Causal length / site ids:** delete a `beta` note on L3, push to B, L1 pulls from B. Assert the delete applies on L1 and does not reach A.

Verdict for S2: "per-module filtering keeps teams apart" is TRUE only if tests 1-3 and 6 pass and test 4 shows no cross-team row. Otherwise FALSE, with the exact rows that crossed.

### Spike S3: migration 0009 alter on `entries`

**File:** `core/test/spike-0009-series.test.ts` (plus a two-laptop part in `post-office/test/spike-0009-replicate.test.ts`)

Do NOT add a file under `mcp/migrations/`. Inside the test, run the candidate SQL through the same path `core/src/db.ts` `applyMigrations` uses for `CRR_ALTERS` (copy that block into the test: one transaction, `crsql_begin_alter('entries')`, the SQL, `crsql_commit_alter('entries')`):

```sql
ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';
```

Tests:
1. On a shared notebook with notes: the alter succeeds; every existing row has `series = 'E'`.
2. FTS still works after the alter: a NEW note is found by `searchEntries`/FTS MATCH; an EDITED old note's new text is found; the old text is not. All `entries` triggers listed in `0006_ulid_contract.sql` still exist (query `sqlite_master`).
3. Atomicity: make the SQL fail on purpose (e.g. a second statement that errors) and assert the notebook is unchanged (no `series` column, triggers intact).
4. Replication (post-office file): two laptops + one office, all altered; L1 writes a note with `series = 'ACME'`; push/pull; L2 has `series = 'ACME'` for that note.
5. Mixed versions: L1 altered, L2 not; L1 pushes a change touching `series`; record what `applyChanges` on L2 does (error? ignored column?). Evidence for the schema guard, not a judgement.

Verdict for S3: TRUE if 1-4 pass; otherwise FALSE with the exact error.

### Inventory: every place that takes a note number

**Output:** a section of the verdict document (no code).

1. List every function, MCP tool, REST route, UI route and script that accepts or prints an E-number (search `parseEntryRef`, `ownerOf(`, `getEntry(`, `WHERE id =`, `E-${`, `padStart(5`, `/merge/`, `entry/`, `id:` params in `mcp/src/server.ts` tool schemas, `server/src/tools/*.ts`, `ui/src/**`). For each: file:line, what it does with the number, and whether it would need `(series, id)`.
2. Links: confirm how `refs` rows store the target (`ref_value` text + `target_ulid`, filled by `trg_refs_fill_target_ulid` from `0005`/`0006`). On a RECEIVING laptop, is `target_ulid` replicated as a column value or recomputed? (Write a small test in `post-office/test/spike-refs.test.ts`: L1 adds a note with an entry ref, push, L2 pulls; assert L2's `refs.target_ulid` equals L1's.) State whether J17 ("links resolve by ULID, never by number") already holds, and list any reader that resolves links by `ref_value` instead of `target_ulid`.
3. Count the golden tests whose snapshots contain E-numbers (they will change shape when numbers carry a series).

---

## Finish

1. Write `docs/superpowers/specs/2026-10-05-collab-join-spikes-verdict.md`: S2 verdict + evidence table, S3 verdict + evidence, the inventory, and a short "what this means for the piece 2 plan" list (only facts the spikes established; flag anything the design must change).
2. Run the suites that contain the spike tests (`cd core && npx tsx --test test/*.test.ts`, `cd post-office && npx tsx --test test/*.test.ts`) and report counts. A spike test that documents a FALSE verdict should assert the observed behaviour (so it stays green and documents reality) and say so in its name, e.g. `S2-4 (observed): a secondary tag in another team's module reaches office A`.
3. Commit with messages `spike(join): ...`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push `collab-join-spikes` only. Never commit or push to `collabv1` or any other branch; never force-push.
