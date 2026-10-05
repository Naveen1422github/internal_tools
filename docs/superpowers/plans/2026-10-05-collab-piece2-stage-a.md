# Collab piece 2, stage A: one number formatter, links read by ULID

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** groundwork for note-number series (stage B) with no visible change except one fix: every place that prints a note number uses one formatter, and every place that follows a link between notes follows the target's ULID, not its number.

**Architecture:** a `formatEntryRef(id, series = "E")` in core (and a mirror in the UI, which doesn't import core) replaces 6 local helpers and the hand-written `E-${…}` formats. Link readers (`getEntry`'s refs, `superseded_by` displays, doctor link checks, the web UI's entry drawer) switch to `refs.target_ulid` / `entries.superseded_by_ulid`, which already replicate correctly (spike `post-office/test/spike-refs.test.ts`). Link writers (rollup, archive) pass `target_ulid` instead of relying on the number-parsing trigger.

**Tech Stack:** TypeScript 5.3 ESM, better-sqlite3 + cr-sqlite, node:test + tsx, React + vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-collab-join-and-teams-design.md` (J17, J24 stage A). Evidence: `docs/superpowers/specs/2026-10-05-collab-join-spikes-verdict.md` (Inventory section lists every site). Read both.

## Global Constraints

- Behaviour stays the same except: (1) the 4 unpadded formats become padded (`E-12` → `E-00012`): `core/src/ops/merge.ts` (~line 65), `core/src/ops/update.ts` (~109), `mcp/src/scripts/log-collab.ts` (~28), `mcp/src/scripts/sweep-deps.ts` (~377); (2) the web UI's entry drawer can open links stored as `E-214` / `#214` (today they are not clickable) and shows a link whose target isn't on this laptop as "not on this laptop"; (3) `getEntry` returns extra link fields.
- `parseEntryRef` keeps returning a number in this stage (series arrive in stage B). Bare numbers, `#n`, `E-n`, `E-0000n` keep working everywhere.
- Code paths for notebooks older than 0005 (no `target_ulid`) and older than 0006 (no `superseded_by_ulid`) keep working with the old number-based logic; check with the existing helpers (`hasUlidPrimaryKey`, pragma checks) as the surrounding code does.
- Golden snapshots: only `mcp_get_entry` (and any REST snapshot of `GET /api/collab/entry`) may change, because `getEntry` gains fields. Regenerate them in the task that changes `getEntry`, and state in the commit message exactly which fields were added. Every other golden must stay byte-identical; the 4 known failing goldens (search all / by module / by category, doctor) must fail exactly as before.
- Tests use temp folders only; every connection with cr-sqlite loaded is closed via `SELECT crsql_finalize()` first (collab E-764).
- One commit per task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A link whose target is a tombstoned note: still opens it (D5b), labelled as deleted.
2. A link whose target isn't on this laptop (`target_ulid` set, no row): shown as "not on this laptop", never as a broken button or NaN.
3. Two notes sharing one E-number (possible today, no UNIQUE): following a link must reach the linked note by ULID, not "the first note with that number".
4. A pre-0005 notebook (no `target_ulid`): `getEntry`, doctor and the UI still work by number.
5. `formatEntryRef(null)` / `undefined` (rows from before numbers existed): prints `E-?`, never `E-0null`.

---

### Task 1: one formatter

**Files:**
- Create: `core/src/entry-ref.ts`, `core/test/entry-ref.test.ts`, `ui/src/format.ts`, `ui/src/format.test.ts`
- Modify: `core/src/index.ts`; replace the 6 local helpers (`core/src/ops/doctor.ts:123` `toEntryId`, `core/src/ops/export.ts:60` `toEntryId`, `core/src/ops/supersede.ts:20` `toEntryId`, `core/src/preflight-0006.ts:21` `eid`, `mcp/src/server.ts:827` `E`, `post-office/src/cli.ts:30` `pad`) and every inline `E-${…}` in `core/src`, `mcp/src`, `server/src`, `post-office/src`, `mcp/src/scripts` (37 sites; `grep -rnE 'E-\$\{' --include=*.ts`), and in `ui/src` (`EntryDrawer.tsx` and the pages listed in the verdict: CommandPalette, DraftCard, Knowledge, Dashboard, Modules, Health, NeedsMerge, Merge).

**Interfaces:**
- Produces: `formatEntryRef(id: number | null | undefined, series?: string): string` in core and, identical, in `ui/src/format.ts`.

- [ ] **Step 1: Failing tests** `core/test/entry-ref.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { formatEntryRef } from '../src/entry-ref.js';
import { parseEntryRef } from '../src/ulid.js';

test('pads to 5 digits with the E series by default', () => {
  assert.equal(formatEntryRef(12), 'E-00012');
  assert.equal(formatEntryRef(123456), 'E-123456');
});
test('a missing number prints E-?, never E-0null', () => {
  assert.equal(formatEntryRef(null), 'E-?');
  assert.equal(formatEntryRef(undefined), 'E-?');
});
test('a series other than E is accepted (stage B)', () => {
  assert.equal(formatEntryRef(7, 'ACME'), 'ACME-00007');
});
test('round trip with parseEntryRef for the E series', () => {
  for (const n of [1, 42, 760, 99999, 100000]) assert.equal(parseEntryRef(formatEntryRef(n)), n);
});
```

`ui/src/format.test.ts`: the same four expectations against `ui/src/format.ts` (vitest `describe/it/expect`; skip the parseEntryRef round trip).

- [ ] **Step 2: Run, expect FAIL** (`cd core && npx tsx --test test/entry-ref.test.ts`; `cd ui && npx vitest run src/format.test.ts`).

- [ ] **Step 3: Implement.**

`core/src/entry-ref.ts`:

```ts
// file: core/src/entry-ref.ts
// The one way to print a note number (stage A of piece 2; series arrive in
// stage B). ui/src/format.ts mirrors this: the UI doesn't import core.
export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-?`;
  return `${series}-${String(id).padStart(5, "0")}`;
}
```

`ui/src/format.ts`: the same function, with a comment pointing at `core/src/entry-ref.ts`.

Then replace every helper and inline format listed under Files with `formatEntryRef(...)`. For `preflight-0006.ts` `eid(null)`, the old output `E-0000?` becomes `E-?`; that's intended. Keep message wording otherwise identical.

- [ ] **Step 4: Run** the new tests (PASS), then core, post-office, mcp, root and ui suites. Root: only the 4 known goldens fail, and fail exactly as before (diff their output against the baseline you record before Step 3).
- [ ] **Step 5: Commit** `refactor: one formatEntryRef for every note number (core + ui mirror)`.

---

### Task 2: `getEntry` returns link targets by ULID; `getEntryByUlid`

**Files:**
- Modify: `core/src/ops/get.ts`, `core/src/index.ts`
- Test: `core/test/get-links.test.ts`; regenerate the `mcp_get_entry` golden (and any REST snapshot of the entry route)

**Interfaces:**
- Produces:

```ts
export interface EntryRef {
  ref_type: string;
  ref_value: string;
  /** ref_type 'entry', 0005+: the linked note, followed by ULID (J17). null = unresolved or pre-0005. */
  target?: { ulid: string; id: number | null; title: string | null; deleted: boolean; present: boolean } | null;
}
// EntryFull gains:
superseded_target?: { ulid: string; id: number | null; title: string | null; deleted: boolean; present: boolean } | null;
export function getEntryByUlid(db: DB, ulid: string): EntryFull | null;
```

`present: false` = `target_ulid` is set but no row with that ULID exists on this laptop (not shared with you / not synced yet).

- [ ] **Step 1: Failing tests** `core/test/get-links.test.ts` (migrated temp notebook via `getDb(path, { create: true })` + `migrate`; `closeDb()` in `finally`):
  1. Note A links to note B (`refs: [{ ref_type: 'entry', ref_value: 'E-' + B }]`): `getEntry(A).refs[0].target` = `{ ulid: B.ulid, id: B.id, title: B.title, deleted: false, present: true }`.
  2. Two notes share an E-number (insert a second row with the same `id` and a higher ULID directly); A links to the one with the higher ULID by writing `target_ulid` explicitly; `target.ulid` is that one (proves ULID, not number).
  3. Target tombstoned (`deleteEntry`): `target.deleted === true`, `present === true`.
  4. Target ULID set to a ULID that doesn't exist: `present === false`, `id === null`.
  5. `superseded_target` filled from `superseded_by_ulid` after `supersede`.
  6. `getEntryByUlid(B.ulid)` equals `getEntry(B.id)`.
  7. A url ref has `target` undefined or null.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `getEntry`, when `target_ulid` exists (0005+), select refs with `LEFT JOIN entries t ON t.ulid = r.target_ulid` and build `target` for `ref_type = 'entry'` rows with a non-null `target_ulid`; when `superseded_by_ulid` exists (0006+), resolve `superseded_target` the same way. Factor the row-to-`EntryFull` assembly into one internal function used by both `getEntry` and `getEntryByUlid`.
- [ ] **Step 4: Run** tests; regenerate the `mcp_get_entry` golden with the repo's existing golden-update mechanism (find it in `mcp/test/golden/`), and confirm the diff only adds `target` / `superseded_target`. All other goldens unchanged.
- [ ] **Step 5: Commit** `feat(core): getEntry follows links and superseded_by by ULID (target, superseded_target); getEntryByUlid` and list the golden fields added.

---

### Task 3: link writers pass `target_ulid`

**Files:**
- Modify: `core/src/ops/rollup.ts` (the two `insertRefs` calls, ~lines 275 and 412)
- Test: extend the existing rollup tests (find them with `grep -rln "rollup" core/test mcp/test`) or add `core/test/rollup-links.test.ts`

- [ ] **Step 1: Failing test:** after `rollup` and after `archive` on a 0006 notebook, every `refs` row from the new note has `target_ulid` equal to the original note's ULID, **with the `trg_refs_fill_target_ulid` trigger dropped in the test** (proves the writer, not the trigger, sets it).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** look up each original's ULID (`SELECT ulid FROM entries WHERE id = ? ORDER BY deleted_at IS NOT NULL, ulid LIMIT 1`, the same tie-break `getEntry` uses) and pass `target_ulid` in each `RefRowInput`. Keep `ref_value` as today (the formatted number) for display.
- [ ] **Step 4: Run** core + mcp suites.
- [ ] **Step 5: Commit** `fix(core): rollup and archive link their originals by ULID`.

---

### Task 4: doctor link checks by ULID

**Files:**
- Modify: `core/src/ops/doctor.ts` (`data.orphan_refs.entry` ~line 259, `data.dangling_superseded` ~line 334)
- Test: `core/test/doctor-links.test.ts`

Rules (0005+ / 0006+ files; older files keep today's number-based checks):
- `data.orphan_refs.entry`: an entry ref is an orphan when `target_ulid` is set and no row has that ULID. Rows with `target_ulid IS NULL` are already reported by `data.unresolved_entry_refs`, so don't count them twice.
- `data.dangling_superseded`: `superseded_by_ulid` set and no row with that ULID.
- `items` print with `formatEntryRef`.

- [ ] **Step 1: Failing tests:** (a) a link to an existing note whose E-number is ALSO used by another note → not an orphan; (b) `target_ulid` pointing at a missing ULID → orphan; (c) a link with `target_ulid` NULL → not in `orphan_refs`, but in `unresolved_entry_refs`; (d) `superseded_by_ulid` pointing at a missing ULID → dangling; (e) a pre-0005 file → behaves as today.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** core, mcp, root suites. The `doctor` golden is one of the 4 already failing; record whether its diff changes and explain it in the commit.
- [ ] **Step 5: Commit** `fix(core): doctor follows links and superseded_by by ULID`.

---

### Task 5: printed `superseded_by` and the web route by ULID

**Files:**
- Modify: `mcp/src/server.ts` (~line 1293, the "superseded by" text), `core/src/ops/export.ts` (~line 110), `server/src/tools/collab.ts` (`GET /api/collab/entry` accepts `?ulid=`; the export query ~line 440 selects `superseded_by_ulid` too)
- Test: `test/api.entry-ulid.test.mts` (root suite, using `test/helpers/server.mjs`)

Rule: print "superseded by <formatEntryRef(current number of the note at superseded_by_ulid)>" when the ULID resolves; fall back to the integer `superseded_by` only on files without `superseded_by_ulid`.

- [ ] **Step 1: Failing tests:** `GET /api/collab/entry?ulid=<B.ulid>` returns B (200); unknown ULID → 404; neither id nor ulid → 400; an exported note superseded by B prints B's current number.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (route: `getEntryByUlid` when `ulid` is given; validate ULID shape with the existing ULID helper in `core/src/ulid.ts`).
- [ ] **Step 4: Run** root + mcp suites.
- [ ] **Step 5: Commit** `feat: superseded-by printed from the ULID; GET /api/collab/entry?ulid=`.

---

### Task 6: web UI opens links by ULID

**Files:**
- Modify: `ui/src/store/ui.ts` (`openDrawer` accepts `number | { ulid: string }`; state `drawerEntry: { id: number } | { ulid: string } | null`, keep `drawerEntryId` as a derived getter only if other code reads it, otherwise migrate readers), `ui/src/api/client.ts` (`entryByUlid(ulid)`), `ui/src/components/EntryDrawer.tsx` (load by id or ULID; links and superseded-by use `target` / `superseded_target`)
- Test: `ui/src/components/EntryDrawer.links.test.tsx` (pattern: `ui/src/pages/Health.setup.test.tsx`, jsdom, mocked client)

Rendering rules for an entry link:
- `target.present` → button labelled `formatEntryRef(target.id)` + ` · ` + title; click opens by `{ ulid }`; a deleted target adds "(deleted)".
- `target` set but `present === false` → plain text `formatEntryRef(parseEntryRef-able number or ref_value)` + " · not on this laptop".
- No `target` (pre-0005 or unresolved) → today's behaviour, but parse with the same rules as core (`E-214`, `#214`, `214` all clickable by number) instead of `parseInt`.

- [ ] **Step 1: Failing tests:** a ref `{ ref_value: 'E-214', target: { present: true, ulid: 'U', id: 214, title: 'T', deleted: false } }` renders a button "E-00214 · T" that calls the open action with `{ ulid: 'U' }`; `present: false` renders "not on this laptop" with no button; a ref without `target` and value `#214` renders a button that opens 214.
- [ ] **Step 2: Run, expect FAIL** (`cd ui && npx vitest run src/components/EntryDrawer.links.test.tsx`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd ui && npx vitest run` and `npx tsc -p tsconfig.app.json --noEmit`.
- [ ] **Step 5: Commit** `feat(ui): the entry drawer follows links and superseded-by by ULID`.

---

## Done means

- Every suite passes except the 4 known goldens, which fail exactly as before (except the doctor golden diff explained in Task 4's commit).
- `grep -rnE 'E-\$\{' --include=*.ts --include=*.tsx core/src mcp/src server/src post-office/src ui/src cli/src` finds only `entry-ref.ts` and `ui/src/format.ts`.
- `grep -rn "parseInt(ref" ui/src` finds nothing.
- Not in this stage: series (`parseEntryRef` returning `{ series, id }`), `dispatches.entry_id`, migration 0009, the trigger's parser learning series. Those are stage B.
