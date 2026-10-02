# T-011 Main Note per Topic: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each collab module names ONE main note (hub). Reading the module tells you which important notes the hub does not reach. Links to retired notes stop counting, and links to replaced notes follow to the replacement.

**Architecture:** One new core file `core/src/ops/hub.ts` holds all hub logic: resolve a link to a live note, set the hub, compute coverage. Three readers use it: `getModule` (the topic card), `doctor` (on-demand check), and the `collab_add` response (tells the writing agent where to link). There is no migration and no schema change, because `modules.hub` (ULID) was added in 0005 for this purpose (E-657), and `refs.target_ulid` / `entries.superseded_by_ulid` already exist. Expiry is computed when links are read. No ref is ever deleted automatically: deleting refs would create sync conflicts under cr-sqlite and erase history.

**Tech Stack:** TypeScript 5.3, better-sqlite3, node:test via tsx, MCP SDK (zod schemas).

**Spec:** Decision E-657 (2026-09-24: one named hub per module; dangling = decision/proposal/gotcha not reachable within 2 links; read-time + doctor; `collab_add` response names the hub). Also the user's additions of 2026-10-02 in session: deprecated links must expire, and token usage must not grow.

## Global Constraints

- No new migration. Use the existing `modules.hub TEXT` (stores an entry ULID, never an E-number).
- "Linked" is decided ONLY through `refs.target_ulid`. A match on an E-number or `ref_value` must never count. E-numbers can collide across machines (E-648).
- Important types = `decision`, `proposal`, `gotcha` (E-657). Handoffs, session notes, changelogs, and reviews are never flagged.
- Reach = the hub's own links plus the links of those notes (2 hops, E-657).
- A link to a deprecated note that has a live replacement (`superseded_by_ulid` chain) counts for the replacement. A link to a deprecated note with no live replacement is **expired**: it does not count and is reported, and it is never deleted automatically.
- Tombstoned (`deleted_at`) notes are never hubs, never candidates, and never relay links.
- Topic card token budget: the hub section adds at most 6 lines. At most 5 unlinked notes are listed, with titles cut at 80 chars. When a hub is set, the old "Indexes:" section is not printed.
- The feature works at schema 0005 and 0006 (tests use `testAtEachLevel`). Before 0005 it reports `state: "unset"` and never queries ULID columns.
- Agents never `git commit` (the user is the integration gatekeeper). Each "Commit" step = stop and hand the diff to the user.
- Never run `npm run build` (the user builds). Tests run only via a background subagent, targeted spec only.

## Review Focus

1. **Hub itself retired or replaced.** Someone supersedes the SupportHub map with a newer map. Expected: the card shows the new map as main note ("moved from E-613"), and coverage uses the new map's links. Pinned in Task 1 (`resolveLive` follows the chain) and Task 1 test "hub superseded".
2. **Supersede cycle or very long chain** (bad data: A replaced by B, B replaced by A). Expected: no infinite loop, the note counts as expired. Pinned in Task 1 test "cycle".
3. **Two notes share an E-number** (sync collision). The hub links E-700 and both notes exist. Expected: only the note whose ULID the ref resolved to counts. Pinned in Task 1 test "duplicate E-number".
4. **Topic with no main note set.** Expected: one line "not set", no flood of warnings, doctor lists the module once under `hub.missing`. Pinned in Task 2 and Task 3 tests.
5. **Notes in topics with no `modules` row** (business-rule, emp-service, leave-service exist only in `entry_modules`). Expected: `setModuleHub` refuses with a clear message, and doctor's `hub.missing` lists only registered modules. The 69 orphan-module entries stay T-011-adjacent cleanup, not this plan. Pinned in Task 1 test "unknown module".

---

## Preconditions (user)

- [ ] On `collabv1`, commit the go-live leftovers: `mcp/migrations/staged/0006_ulid_contract.sql` deleted and `mcp/migrations/0006_ulid_contract.sql` added (git currently shows them as `D` / `??`).
- [ ] Create a worktree: `git worktree add ../../wt-collab-t011 -b collab-t011-hub collabv1` (from `frontend2/internal-tools`'s repo root). Then run `npm install` inside it. Do NOT symlink node_modules (E-698).

---

### Task 1: Core hub logic (`hub.ts`)

**Files:**
- Create: `core/src/ops/hub.ts`
- Modify: `core/src/index.ts` (add one export line)
- Test: `core/test/hub.test.ts`

**Interfaces:**
- Consumes: `ownerOf(db, id)` from `core/src/entry-write.ts`, `liveEntry(db, alias)` from `core/src/schema.ts`, `hasUlidColumns(db)` from `core/src/db.ts`.
- Produces:
  - `IMPORTANT_TYPES: readonly ["decision","proposal","gotcha"]`
  - `interface LiveTarget { ulid: string; id: number; title: string; followed: boolean }`
  - `resolveLive(db: DB, ulid: string): LiveTarget | null`
  - `setModuleHub(db: DB, args: { slug: string; id: number | null }): { slug: string; hub: { id: number; ulid: string; title: string } | null }`
  - `type HubState = "unset" | "retired" | "ok"`
  - `interface HubCoverage { hub: LiveTarget; linked_count: number; unlinked_count: number; unlinked: Array<{ id: number; type: string; title: string }>; expired: Array<{ from_id: number; to_id: number | null; to_ref: string }> }`
  - `getHubStatus(db: DB, slug: string, limit?: number): { state: HubState; coverage: HubCoverage | null }`

- [ ] **Step 1: Write the failing tests**

Create `core/test/hub.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { testAtEachLevel, dbAt, assertFtsIntact } from './helpers/levels.js';
import { addEntry } from '../src/ops/add.js';
import { initModule } from '../src/ops/module.js';
import { supersede } from '../src/ops/supersede.js';
import { updateEntryRefs } from '../src/ops/update.js';
import { setModuleHub, getHubStatus, resolveLive } from '../src/ops/hub.js';
import { newUlid } from '../src/ulid.js';

const M = 'demo-topic';
const note = (db: any, type: any, title: string, refs: string[] = []) =>
  addEntry(db, { type, title, summary: 's', module: M, refs: refs.map((r) => ({ ref_type: 'entry' as const, ref_value: r })) }).id;
const ulidOf = (db: any, id: number) => (db.prepare('SELECT ulid FROM entries WHERE id = ?').get(id) as { ulid: string }).ulid;

testAtEachLevel('no hub set -> state unset, no coverage', (db) => {
  initModule(db, { slug: M });
  note(db, 'decision', 'd1');
  const s = getHubStatus(db, M);
  assert.equal(s.state, 'unset');
  assert.equal(s.coverage, null);
});

testAtEachLevel('direct and 2-hop links count; 3-hop and unlinked do not', (db) => {
  initModule(db, { slug: M });
  const deep = note(db, 'gotcha', 'three hops away');
  const mid2 = note(db, 'decision', 'two hops', [String(deep)]);
  const mid1 = note(db, 'decision', 'one hop', [String(mid2)]);
  const lonely = note(db, 'proposal', 'nobody links me');
  note(db, 'handoff', 'handoffs are never flagged');
  const hub = note(db, 'decision', 'main map', [String(mid1)]);
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.equal(c.linked_count, 2); // mid1, mid2
  assert.deepEqual(c.unlinked.map((u) => u.id).sort(), [deep, lonely].sort());
  assert.equal(c.unlinked_count, 2);
  assertFtsIntact(db);
});

testAtEachLevel('link to a replaced note follows to the replacement', (db) => {
  initModule(db, { slug: M });
  const oldN = note(db, 'decision', 'old');
  const newN = note(db, 'decision', 'new');
  const hub = note(db, 'decision', 'main', [String(oldN)]);
  supersede(db, { ids: [oldN], by: newN });
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.equal(c.unlinked_count, 0, JSON.stringify(c.unlinked));
  assert.equal(c.expired.length, 0);
});

testAtEachLevel('link to a retired note expires: not counted, reported, not deleted', (db) => {
  initModule(db, { slug: M });
  const gone = note(db, 'decision', 'retired');
  const hub = note(db, 'decision', 'main', [String(gone)]);
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(gone);
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M).coverage!;
  assert.deepEqual(c.expired.map((e) => e.to_id), [gone]);
  assert.equal(c.linked_count, 0);
  const refCount = (db.prepare(`SELECT COUNT(*) c FROM refs WHERE ref_type='entry' AND ref_value = ?`).get(String(gone)) as { c: number }).c;
  assert.equal(refCount, 1, 'expiry must never delete the ref');
});

testAtEachLevel('hub superseded -> replacement becomes the main note', (db) => {
  initModule(db, { slug: M });
  const d = note(db, 'decision', 'only new map links me');
  const hubOld = note(db, 'decision', 'old map');
  const hubNew = note(db, 'decision', 'new map', [String(d)]);
  setModuleHub(db, { slug: M, id: hubOld });
  supersede(db, { ids: [hubOld], by: hubNew });
  const s = getHubStatus(db, M);
  assert.equal(s.state, 'ok');
  assert.equal(s.coverage!.hub.id, hubNew);
  assert.equal(s.coverage!.hub.followed, true);
  assert.equal(s.coverage!.unlinked_count, 0);
});

testAtEachLevel('hub retired with no replacement -> state retired', (db) => {
  initModule(db, { slug: M });
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(hub);
  assert.equal(getHubStatus(db, M).state, 'retired');
});

testAtEachLevel('supersede cycle does not loop', (db) => {
  initModule(db, { slug: M });
  const a = note(db, 'decision', 'a');
  const b = note(db, 'decision', 'b');
  db.prepare('UPDATE entries SET deprecated = 1, superseded_by_ulid = ? WHERE id = ?').run(ulidOf(db, b), a);
  db.prepare('UPDATE entries SET deprecated = 1, superseded_by_ulid = ? WHERE id = ?').run(ulidOf(db, a), b);
  assert.equal(resolveLive(db, ulidOf(db, a)), null);
});

testAtEachLevel('setModuleHub guards', (db) => {
  initModule(db, { slug: M });
  initModule(db, { slug: 'other-topic' });
  const elsewhere = addEntry(db, { type: 'decision', title: 'x', summary: 's', module: 'other-topic' }).id;
  assert.throws(() => setModuleHub(db, { slug: 'no-such-topic', id: elsewhere }), /not found/);
  assert.throws(() => setModuleHub(db, { slug: M, id: elsewhere }), /not in module/);
  assert.throws(() => setModuleHub(db, { slug: M, id: 99999 }), /no entry/);
  const hub = note(db, 'decision', 'map');
  assert.equal(setModuleHub(db, { slug: M, id: hub }).hub!.id, hub);
  assert.equal(setModuleHub(db, { slug: M, id: null }).hub, null);
  assert.equal(getHubStatus(db, M).state, 'unset');
});

test('duplicate E-number: only the ULID the ref resolved to counts [0006]', () => {
  const { db, cleanup } = dbAt('0006');
  try {
    initModule(db, { slug: M });
    const target = note(db, 'decision', 'real target');
    const hub = note(db, 'decision', 'map', [String(target)]);
    // A synced twin with the same E-number, different ULID, same module.
    const twin = newUlid();
    db.prepare(`INSERT INTO entries (ulid, id, type, kind, title, summary, module, category) VALUES (?, ?, 'gotcha', 'signal', 'twin', 's', ?, 'Reference')`).run(twin, target, M);
    db.prepare(`INSERT INTO entry_modules (entry_ulid, entry_id, module, is_primary) VALUES (?, ?, ?, 1)`).run(twin, target, M);
    setModuleHub(db, { slug: M, id: hub });
    const c = getHubStatus(db, M).coverage!;
    assert.equal(c.linked_count, 1);
    assert.deepEqual(c.unlinked.map((u) => u.title), ['twin']);
    assertFtsIntact(db);
  } finally { cleanup(); }
});

testAtEachLevel('unlinked list is capped and newest first', (db) => {
  initModule(db, { slug: M });
  const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => note(db, 'gotcha', `g${n}`));
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  const c = getHubStatus(db, M, 5).coverage!;
  assert.equal(c.unlinked_count, 7);
  assert.equal(c.unlinked.length, 5);
  assert.equal(c.unlinked[0].id, ids[6]);
});
```

Also add one pre-0005 test. `migrateTo` exists in `core/src/db.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from '../src/db.js';

test('pre-0005 DB reports unset and never touches ULID columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-0004-'));
  const db = new Database(join(dir, 'collab.db'));
  try {
    migrateTo(db, '0004');
    initModule(db, { slug: M });
    assert.deepEqual(getHubStatus(db, M), { state: 'unset', coverage: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts`
Expected: FAIL, `Cannot find module '../src/ops/hub.js'`.

- [ ] **Step 3: Implement `core/src/ops/hub.ts`**

```ts
import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { liveEntry } from "../schema.js";
import { ownerOf } from "../entry-write.js";

// T-011: one main note (hub) per module (E-657). All "is it linked?" logic
// lives here. Rules:
// - Linked is decided ONLY via refs.target_ulid, never by E-number (E-648:
//   E-numbers can collide across machines).
// - A link to a deprecated note follows superseded_by_ulid to its live
//   replacement. With no live replacement the link is EXPIRED: it stops
//   counting, is reported, and is never deleted here (deleting refs would
//   fight cr-sqlite sync and erase history).
// - Reach = hub's links + their links (2 hops).

export const IMPORTANT_TYPES = ["decision", "proposal", "gotcha"] as const;
const MAX_HOPS = 10;

export interface LiveTarget {
  ulid: string;
  id: number;
  title: string;
  followed: boolean; // true when reached through a supersede chain
}

export type HubState = "unset" | "retired" | "ok";

export interface HubCoverage {
  hub: LiveTarget;
  linked_count: number;
  unlinked_count: number;
  unlinked: Array<{ id: number; type: string; title: string }>;
  expired: Array<{ from_id: number; to_id: number | null; to_ref: string }>;
}

/** Follow the supersede chain from `ulid` to a live, non-deprecated entry; null if retired, tombstoned, missing or cyclic. */
export function resolveLive(db: DB, ulid: string): LiveTarget | null {
  const stmt = db.prepare(
    `SELECT e.ulid, e.id, e.title, e.deprecated, e.superseded_by_ulid FROM entries e
      WHERE e.ulid = ? AND ${liveEntry(db, "e")}`,
  );
  const seen = new Set<string>();
  let cur = ulid;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const r = stmt.get(cur) as
      | { ulid: string; id: number; title: string; deprecated: number; superseded_by_ulid: string | null }
      | undefined;
    if (!r) return null;
    if (r.deprecated === 0) return { ulid: r.ulid, id: r.id, title: r.title, followed: hop > 0 };
    if (!r.superseded_by_ulid) return null;
    cur = r.superseded_by_ulid;
  }
  return null;
}

export function setModuleHub(
  db: DB,
  args: { slug: string; id: number | null },
): { slug: string; hub: { id: number; ulid: string; title: string } | null } {
  if (!hasUlidColumns(db)) throw new Error("main notes need migration 0005 or later");
  const mod = db.prepare(`SELECT slug FROM modules WHERE slug = ?`).get(args.slug);
  if (!mod) throw new Error(`module '${args.slug}' not found; create it with collab_module_init first`);

  if (args.id === null) {
    db.prepare(`UPDATE modules SET hub = NULL WHERE slug = ?`).run(args.slug);
    return { slug: args.slug, hub: null };
  }

  const owner = ownerOf(db, args.id);
  if (!owner || owner.ulid === null) throw new Error(`no entry found with id ${args.id}`);
  const member = db
    .prepare(`SELECT 1 FROM entry_modules WHERE entry_ulid = ? AND module = ?`)
    .get(owner.ulid, args.slug);
  if (!member) throw new Error(`E-${String(args.id).padStart(5, "0")} is not in module '${args.slug}'`);
  const live = resolveLive(db, owner.ulid);
  if (!live || live.followed) throw new Error(`E-${String(args.id).padStart(5, "0")} is deprecated; pick a live note`);

  db.prepare(`UPDATE modules SET hub = ? WHERE slug = ?`).run(owner.ulid, args.slug);
  return { slug: args.slug, hub: { id: live.id, ulid: live.ulid, title: live.title } };
}

export function getHubStatus(
  db: DB,
  slug: string,
  limit = 5,
): { state: HubState; coverage: HubCoverage | null } {
  if (!hasUlidColumns(db)) return { state: "unset", coverage: null };
  const row = db.prepare(`SELECT hub FROM modules WHERE slug = ?`).get(slug) as { hub: string | null } | undefined;
  if (!row || !row.hub) return { state: "unset", coverage: null };
  const hub = resolveLive(db, row.hub);
  if (!hub) return { state: "retired", coverage: null };

  const outLinks = db.prepare(
    `SELECT target_ulid, ref_value FROM refs
      WHERE entry_ulid = ? AND ref_type = 'entry' AND target_ulid IS NOT NULL`,
  );
  const idOf = db.prepare(`SELECT id FROM entries WHERE ulid = ?`);

  const reach = new Set<string>();
  const expired: HubCoverage["expired"] = [];
  const firstHop: string[] = [];
  for (const l of outLinks.all(hub.ulid) as Array<{ target_ulid: string; ref_value: string }>) {
    const t = resolveLive(db, l.target_ulid);
    if (!t) {
      const r = idOf.get(l.target_ulid) as { id: number | null } | undefined;
      expired.push({ from_id: hub.id, to_id: r?.id ?? null, to_ref: l.ref_value });
      continue;
    }
    if (!reach.has(t.ulid)) firstHop.push(t.ulid);
    reach.add(t.ulid);
  }
  for (const u of firstHop) {
    for (const l of outLinks.all(u) as Array<{ target_ulid: string }>) {
      const t = resolveLive(db, l.target_ulid);
      if (t) reach.add(t.ulid);
    }
  }

  const types = IMPORTANT_TYPES.map((t) => `'${t}'`).join(",");
  const candidates = db
    .prepare(
      `SELECT e.ulid, e.id, e.type, e.title FROM entries e
        WHERE e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)
          AND ${liveEntry(db, "e")} AND e.deprecated = 0
          AND e.type IN (${types}) AND e.ulid != ?
        ORDER BY e.created_at DESC, e.ulid DESC`,
    )
    .all(slug, hub.ulid) as Array<{ ulid: string; id: number; type: string; title: string }>;
  const unlinked = candidates.filter((c) => !reach.has(c.ulid));

  return {
    state: "ok",
    coverage: {
      hub,
      linked_count: candidates.length - unlinked.length,
      unlinked_count: unlinked.length,
      unlinked: unlinked.slice(0, limit).map(({ id, type, title }) => ({ id, type, title })),
      expired,
    },
  };
}
```

Add to `core/src/index.ts`, after the `module.js` line:

```ts
export * from './ops/hub.js';
```

- [ ] **Step 4: Run the tests and verify they pass**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts`
Expected: PASS, all tests at both levels plus the 0006-only and pre-0005 tests.

Note for the implementer: "newest first" sorts on `created_at` (second resolution) and then `ulid`. ULIDs are time-ordered, so notes created in the same second still sort correctly. If the cap test is flaky, check for this before changing the test.

- [ ] **Step 5: Hand the diff to the user to commit**

Suggested message: `feat(core): main note per module (hub) with 2-hop coverage and link expiry (T-011)`

---

### Task 2: Topic card + `collab_module_set_hub` tool + `collab_add` hint

**Files:**
- Modify: `core/src/ops/module.ts` (ModuleCard type + getModule)
- Modify: `mcp/src/server.ts` (imports, `collab_add` text, `collab_module_get` text, new `collab_module_set_hub` tool)
- Test: `core/test/hub.test.ts` (append)

**Interfaces:**
- Consumes: `getHubStatus`, `setModuleHub`, `HubState`, `HubCoverage` from Task 1.
- Produces: `ModuleCard.hub: { state: HubState; coverage: HubCoverage | null }`.

- [ ] **Step 1: Append the failing test**

```ts
import { getModule } from '../src/ops/module.js';

testAtEachLevel('module card carries hub status', (db) => {
  initModule(db, { slug: M });
  assert.equal(getModule(db, M).hub.state, 'unset');
  const g = note(db, 'gotcha', 'unlinked gotcha');
  const hub = note(db, 'decision', 'map');
  setModuleHub(db, { slug: M, id: hub });
  const card = getModule(db, M);
  assert.equal(card.hub.state, 'ok');
  assert.deepEqual(card.hub.coverage!.unlinked.map((u) => u.id), [g]);
  assert.deepEqual(getModule(db, 'no-such-topic').hub, { state: 'unset', coverage: null });
});
```

- [ ] **Step 2: Run and verify it fails**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts`
Expected: FAIL, `Cannot read properties of undefined (reading 'state')`.

- [ ] **Step 3: Implement in `core/src/ops/module.ts`**

Add the import:

```ts
import { getHubStatus, type HubState, type HubCoverage } from "./hub.js";
```

Add a field to `ModuleCard`:

```ts
  hub: { state: HubState; coverage: HubCoverage | null };
```

In the `if (!module)` early return, add `hub: { state: "unset", coverage: null },`. In the final return:

```ts
  const hub = getHubStatus(db, slug);
  return { module, active_tasks, indexes, recent_decisions, top_gotchas, recent_handoffs, hub };
```

- [ ] **Step 4: Run and verify it passes**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts test/read-paths-0006.test.ts`
Expected: PASS. `read-paths-0006` guards against regressions in the card.

- [ ] **Step 5: MCP wiring in `mcp/src/server.ts`** (there is no unit harness for server.ts; verified manually in Task 4)

5a. Add `getHubStatus, setModuleHub,` to the `@collab-mcp/core` import list.

5b. In the `collab_module_get` handler, insert this right after the "Active tasks" block, and wrap the existing `if (result.indexes.length > 0) {...}` block in `if (result.hub.state !== "ok") { ... }`:

```ts
    const E = (n: number) => `E-${String(n).padStart(5, "0")}`;
    const cut = (s: string) => (s.length > 80 ? s.slice(0, 79) + "…" : s);
    if (result.hub.state === "unset") {
      lines.push("\nMain note: not set (collab_module_set_hub picks one).");
    } else if (result.hub.state === "retired") {
      lines.push("\nMain note: retired with no replacement (collab_module_set_hub picks a new one).");
    } else {
      const c = result.hub.coverage!;
      lines.push(`\nMain note: [${E(c.hub.id)}] ${cut(c.hub.title)}${c.hub.followed ? " (replacement of the original)" : ""}`);
      if (c.unlinked_count === 0) {
        lines.push(`  reaches all ${c.linked_count} important notes.`);
      } else {
        lines.push(`  reaches ${c.linked_count} of ${c.linked_count + c.unlinked_count} important notes; not linked yet:`);
        for (const u of c.unlinked) lines.push(`    [${E(u.id)}] ${u.type} - ${cut(u.title)}`);
        if (c.unlinked_count > c.unlinked.length) lines.push(`    (+${c.unlinked_count - c.unlinked.length} more; collab_doctor lists all)`);
      }
      if (c.expired.length > 0) lines.push(`  ${c.expired.length} link(s) point at retired notes (ignored; collab_doctor lists them).`);
    }
```

5c. In the `collab_add` handler, replace the `const text = ...` statement with:

```ts
    let text = tt
      ? `Added E-${String(result.id).padStart(5, "0")} (${args.type}). `
        + `Auto-advanced ${tt.id}: ${tt.from} -> ${tt.to}.`
      : `Added E-${String(result.id).padStart(5, "0")} (${args.type}).`;
    // E-657 guardrail: tell the writing agent where its module's main note is,
    // only for important types (the hub must not become a dump).
    if (args.module && ["decision", "proposal", "gotcha"].includes(args.type)) {
      const hs = getHubStatus(db, args.module, 0);
      if (hs.state === "ok") {
        const h = hs.coverage!.hub;
        text += ` Main note for '${args.module}' is E-${String(h.id).padStart(5, "0")}; `
          + `if this belongs in it, link it with collab_update_refs (id ${h.id}, add entry '${result.id}').`;
      }
    }
```

5d. Register a new tool directly after `collab_module_get`:

```ts
// ------------------------------------------------------------
// Tool: collab.module.set_hub
// ------------------------------------------------------------
server.registerTool(
  "collab_module_set_hub",
  {
    title: "Set (or clear) a module's main note",
    description: [
      "Names ONE entry as the module's main note (hub). collab_module_get then reports",
      "which decisions/proposals/gotchas the main note does not reach within 2 links.",
      "The entry must belong to the module and be live. Pass id=null to clear.",
    ].join("\n"),
    inputSchema: {
      slug: z.string().min(1),
      id: z.number().int().min(1).nullable().describe("Entry id (integer inside E-NNNNN), or null to clear."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = setModuleHub(db, { slug: args.slug, id: args.id });
    const text = result.hub
      ? `Main note for '${result.slug}' is now E-${String(result.hub.id).padStart(5, "0")} (${result.hub.title}).`
      : `Main note for '${result.slug}' cleared.`;
    return { content: [{ type: "text", text }], structuredContent: structured(result) };
  }
);
```

Also update the `collab_module_get` description line 1 to: `"Returns: {module, active_tasks, indexes, recent_decisions, top_gotchas, recent_handoffs, hub}."`

- [ ] **Step 6: Hand the diff to the user to commit**

Suggested message: `feat(mcp): main note on the module card, set_hub tool, add-time hint (T-011)`

---

### Task 3: Doctor checks

**Files:**
- Modify: `core/src/ops/doctor.ts` (before the `fts.integrity` block)
- Test: `core/test/hub.test.ts` (append)

**Interfaces:**
- Consumes: `getHubStatus`, `IMPORTANT_TYPES` from Task 1.
- Produces: doctor checks `hub.missing`, `hub.unlinked`, `hub.expired_links` (all `warn` at most; never `error`, because a missing link is drift, not corruption).

- [ ] **Step 1: Append the failing test**

```ts
import { doctor } from '../src/ops/doctor.js';
const chk = (db: any, n: string) => doctor(db).checks.find((c) => c.name === n)!;

testAtEachLevel('doctor reports missing main notes, unlinked and expired links', (db) => {
  initModule(db, { slug: M });
  initModule(db, { slug: 'quiet-topic' }); // no important notes -> never "missing"
  note(db, 'decision', 'd');
  assert.deepEqual(chk(db, 'hub.missing').items, [M]);
  const gone = note(db, 'gotcha', 'retired');
  const hub = note(db, 'decision', 'map', [String(gone)]);
  db.prepare('UPDATE entries SET deprecated = 1 WHERE id = ?').run(gone);
  setModuleHub(db, { slug: M, id: hub });
  assert.equal(chk(db, 'hub.missing').severity, 'ok');
  assert.equal(chk(db, 'hub.unlinked').severity, 'warn');
  assert.match(String(chk(db, 'hub.unlinked').items![0]), new RegExp(`^${M}: 1 `));
  assert.match(String(chk(db, 'hub.expired_links').items![0]), /-> E-\d{5}/);
  assert.equal(doctor(db).ok, true, 'hub checks never fail the doctor');
});
```

- [ ] **Step 2: Run and verify it fails**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts`
Expected: FAIL, `Cannot read properties of undefined (reading 'items')`.

- [ ] **Step 3: Implement in `core/src/ops/doctor.ts`**

Add the import at the top: `import { getHubStatus, IMPORTANT_TYPES } from "./hub.js";`. Insert this before the `// fts.integrity:` comment:

```ts
  // T-011 / E-657: main note (hub) coverage. warn-only: drift, not corruption.
  // Only registered modules (modules table) are checked; modules that exist
  // only in entry_modules can't hold a hub and are covered by orphan_module.
  if (has0005) {
    const types = IMPORTANT_TYPES.map((t) => `'${t}'`).join(",");
    const slugs = (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
    const hasImportant = db.prepare(
      `SELECT 1 FROM entry_modules em JOIN entries e ON e.ulid = em.entry_ulid
        WHERE em.module = ? AND e.deprecated = 0 AND e.type IN (${types}) LIMIT 1`,
    );
    const missing: string[] = [];
    const unlinked: string[] = [];
    const expired: string[] = [];
    for (const slug of slugs) {
      const s = getHubStatus(db, slug, 0);
      if (s.state !== "ok") {
        if (hasImportant.get(slug)) missing.push(slug);
        continue;
      }
      const c = s.coverage!;
      if (c.unlinked_count > 0) unlinked.push(`${slug}: ${c.unlinked_count} not linked from ${toEntryId(c.hub.id)}`);
      for (const x of c.expired) expired.push(`${slug}: ${toEntryId(x.from_id)} -> ${x.to_id !== null ? toEntryId(x.to_id) : x.to_ref}`);
    }
    checks.push({
      name: "hub.missing",
      severity: missing.length > 0 ? "warn" : "ok",
      detail: missing.length > 0 ? `${missing.length} module(s) have important notes but no live main note` : "every module with important notes has a main note",
      items: missing.length > 0 ? missing : undefined,
    });
    checks.push({
      name: "hub.unlinked",
      severity: unlinked.length > 0 ? "warn" : "ok",
      detail: unlinked.length > 0 ? `${unlinked.length} module(s) have notes their main note does not reach` : "main notes reach every important note",
      items: unlinked.length > 0 ? unlinked : undefined,
    });
    checks.push({
      name: "hub.expired_links",
      severity: expired.length > 0 ? "warn" : "ok",
      detail: expired.length > 0 ? `${expired.length} main-note link(s) point at retired notes (remove with collab_update_refs)` : "no expired main-note links",
      items: expired.length > 0 ? expired : undefined,
    });
  }
```

`toEntryId` and `has0005` already exist in `doctor.ts`. Confirm their exact names with `grep -n "function toEntryId\|const has0005" core/src/ops/doctor.ts` before you paste, and adapt the names if they differ.

- [ ] **Step 4: Run and verify it passes, plus the doctor regression suite**

Run (background subagent): `cd core && npx tsx --test test/hub.test.ts test/doctor-0006.test.ts`
Expected: PASS. In particular 'a fresh DB is healthy at every level' stays ok, because a fresh DB has no modules.

- [ ] **Step 5: Hand the diff to the user to commit**

Suggested message: `feat(core): doctor checks for main-note coverage and expired links (T-011)`

---

### Task 4: Real-data check, then pick the main notes (user + Claude)

No new code. The user builds. Everything below runs against a **copy** of the live DB until step 4.

- [ ] **Step 1 (user): build** in the worktree: `npm -w @collab-mcp/core run build`, then `npm --prefix mcp run build`.
- [ ] **Step 2: speed + size on a copy.** Copy `mcp/collab.db` to the scratchpad. On the copy, set `supporthub` → E-613 and `custom-reports` → E-275 with `setModuleHub`. Time `getModule` 20 times per module, before and after. **Pass: median increase ≤ 5 ms.** Measure the `collab_module_get` text length for both modules. **Pass: no more than 6 lines added, and fewer lines than today wherever "Indexes:" disappears.** Record both numbers in the changelog.
- [ ] **Step 3: full core suite** (background subagent): `npm -w @collab-mcp/core test`, which reports counts only. Expected: all green, including the golden snapshots. If a golden snapshot changes because `ModuleCard` gained `hub`, show the user the diff before regenerating.
- [ ] **Step 4 (user decides): name the main notes.** Claude lists each registered module with its Index entries and a recommendation. The user picks, and Claude runs `collab_module_set_hub` once per module. Known picks to confirm: supporthub → the system map (E-613), custom-reports → the roadmap (E-275), rnr → the system map (E-304), workflow → E-204?, qa-system → the high-level design (E-523). collab-mcp has no Index entry yet. Leave it unset, or create one.
- [ ] **Step 5: first cleanup pass (optional, user decides how far).** For each module, read the "not linked yet" list and link what belongs with `collab_update_refs`. Custom-reports has about 100 unlinked notes. Link only the live roadmap items and leave history alone. The card shows 5 at a time, so this can be gradual.
- [ ] **Step 6:** log a collab changelog (module `collab-mcp`, task T-011) with the numbers from step 2 and the hubs chosen. Leave T-011 for the user to close.

---

## Out of scope (deliberately)

- REST `/api/collab/module-card` and the React UI. Both have their own SQL and do not show the hub. Follow-up if wanted.
- Automatically linking new notes to the hub (E-657: the agent decides; the tool must not dump everything into the hub).
- Automatically deleting expired links (sync conflicts + history loss; doctor lists them for one-call removal).
- The 69 orphan-module entries, and modules that exist only in `entry_modules`.
- Conflicts when two machines set different hubs under cr-sqlite. The last writer wins on `modules.hub`, and `hub.missing`/the card make the result visible. Revisit with the relay work.
- `collab_add` with a `task_id` silently moving the task to "review" (seen 2026-10-02). Separate gotcha.
