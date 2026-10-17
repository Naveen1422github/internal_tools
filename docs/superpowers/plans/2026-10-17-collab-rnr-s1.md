# Collab RnR stage S1 (catalog, membership, delivery by project) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team-project membership with roles, held by the post office, and each project's notes delivered only to its members. Members added later get the full history; removed members keep a read-only copy.

**Architecture:** One permission catalog in `core` is shared by office and laptop. The office owns roles and membership in `po_*` tables that never sync. It stamps every accepted change with its project and filters deliveries by the caller's membership. It also answers `GET /v1/access` and rings an `access` event. The courier caches that answer in a new local table (migration 0012, which is also the schema bump), marks dropped projects as left, and runs history replays.

**Tech Stack:** TypeScript (ESM), better-sqlite3 + cr-sqlite, Node `https`, `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-17-collab-rnr-design.md`. S1 covers the catalog, R1, R2, R3, R7a, R11, R12, R13, R14 and R15. R4-R10 (enforcement of changes, AI) are S2-S4 and out of scope here.

## Global Constraints

- Work on a new branch `collab-rnr-s1` from `collabv1`. Never commit to `collabv1` directly; the user merges.
- Solo projects and `E` notes: behaviour byte-for-byte unchanged (spec rule 2). Rows with no project (legacy `E` shared-module notes, `modules` rows) still go to every member.
- No `po_*` table and no new local table is ever in `SYNCED_TABLES` or `CRR_ALTERS`.
- Stored role keys are sanitized against the catalog on every read. A key not in code grants nothing.
- The office spends < 5 ms extra per accepted batch of 2000 changes (spec rule 6).
- Every 403 names the missing key in plain words: `You need "<label>" (<key>) in <CODE> to do this` for project keys, `... in this office` for office keys.
- Copy is plain English, no internal jargon in user-facing strings. Comments follow the existing style: short, spec-referenced (`R3`, `R14`).
- Codex/subagents never push. Run only the targeted test files per task. The full workspace suite runs once in Task 9.

## Review Focus

1. **Orphan cells.** A `refs`/`entry_modules`/`entry_revisions` cell whose owning entry the office doesn't hold yet must not go to everyone. It's held (`project_ulid = '?'`) and released to the right members once the entry arrives. Test lives in Task 5.
2. **Role granted while the laptop is offline.** On reconnect (`ready`), the courier fetches access and runs the replay. Test lives in Task 7.
3. **Last Owner / last Office admin removed by `remove` or `revoke`, not only by demotion.** All paths are refused. Test lives in Task 3.
4. **Old laptop (latest migration 0011) connects** to an upgraded office: 409 schema, nothing delivered, courier shows needs-update. Test lives in Task 9.
5. **Replay of a project whose code clashes locally**: the existing P10 clash hold applies. Nothing is applied and the replay bookmark stays put. Test lives in Task 7.

---

### Task 1: Permission catalog

**Files:**
- Create: `core/src/access/catalog.ts`
- Modify: `core/src/index.ts` (re-export)
- Test: `core/test/access-catalog.test.ts`

**Interfaces:**
- Produces:
  - `type Scope = "project" | "office"`
  - `interface PermissionDef { key: string; label: string; description: string; checkedOn: "office" | "laptop"; active: boolean }`
  - `interface PermissionArea { area: string; label: string; scope: Scope; permissions: PermissionDef[] }`
  - `const CATALOG: PermissionArea[]`
  - `function keysOf(scope: Scope, opts?: { includeInactive?: boolean }): string[]`
  - `function sanitizeKeys(scope: Scope, keys: unknown): string[]` (drops unknown keys, wrong-scope keys and duplicates; keeps inactive ones, which grant nothing until active)
  - `function labelOf(key: string): string`
  - `const STARTER_PROJECT_ROLES: Array<{ name: "Owner" | "Editor" | "Contributor" | "Reader"; keys: string[] }>`
  - `const STARTER_OFFICE_ROLES: Array<{ name: "Office admin" | "Office member"; keys: string[] }>`

Values (from the spec, exact):
- Project scope: Notes `note.view, note.create, note.edit.own, note.edit.any, note.supersede, note.archive, note.copy.out`. Tasks `task.create, task.assign, task.status.change` (all `active: false`). Conflicts `merge.resolve`. Project `project.edit, project.make_solo, project.delete`. Team & access `member.invite, member.revoke, role.manage, ai_limits.manage`.
- `checkedOn: "laptop"` for `note.copy.out, project.edit, project.make_solo, project.delete` (R7b). Everything else is `"office"`.
- Office scope: `office.project.create, office.module.share, office.member.add, office.member.revoke, office.role.manage, module.create, module.edit`.
- Starter roles: Owner = all project keys. Editor = Notes + Tasks + Conflicts. Contributor = `note.view, note.create, note.edit.own, task.status.change`. Reader = `note.view`. Office admin = all office keys. Office member = `office.project.create`.

- [ ] **Step 1: Write the failing test**

```ts
test('catalog: every key unique, scoped, labelled', () => {
  const all = CATALOG.flatMap(a => a.permissions.map(p => p.key));
  assert.equal(new Set(all).size, all.length);
  assert.ok(keysOf('project').includes('note.view'));
  assert.ok(!keysOf('project').includes('module.create'));    // moved to office (R13)
  assert.ok(keysOf('office').includes('module.create'));
  assert.ok(!keysOf('project').includes('task.create'));      // inactive: tasks don't sync
  assert.ok(keysOf('project', { includeInactive: true }).includes('task.create'));
});
test('sanitizeKeys drops unknown, wrong-scope and duplicate keys', () => {
  assert.deepEqual(sanitizeKeys('project', ['note.view', 'note.view', 'ticket.close', 'office.member.add', 7]), ['note.view']);
  assert.deepEqual(sanitizeKeys('project', 'nope'), []);
});
test('starter roles hold only catalog keys; Owner = all project keys', () => {
  const owner = STARTER_PROJECT_ROLES.find(r => r.name === 'Owner')!;
  assert.deepEqual([...owner.keys].sort(), keysOf('project', { includeInactive: true }).sort());
  for (const r of STARTER_PROJECT_ROLES) assert.deepEqual(sanitizeKeys('project', r.keys), r.keys);
  for (const r of STARTER_OFFICE_ROLES) assert.deepEqual(sanitizeKeys('office', r.keys), r.keys);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd core && npx tsx --test test/access-catalog.test.ts` (module not found).
- [ ] **Step 3: Implement `core/src/access/catalog.ts`** with the values above and a one-paragraph header comment quoting rule 4 ("a key that guards nothing is not offered"). Re-export from `core/src/index.ts`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(core): RnR permission catalog (project + office scopes)`

---

### Task 2: Local access cache (migration 0012, the schema bump)

**Files:**
- Create: `mcp/migrations/0012_access_cache.sql`
- Create: `core/src/access/cache.ts`
- Modify: `core/src/db.ts` (append `"0012_access_cache"` to the known-migrations list at ~line 306), `core/src/ops/doctor.ts:193` (expect table `access_cache` when applied), tests asserting `latestMigration === '0011_project_modules'` (`core/test/bind.test.ts:136`, `core/test/project-left.test.ts:27,44`): change them to 0012
- Test: `core/test/access-cache.test.ts`

**Interfaces:**
- Produces:
  - Table `access_cache (scope_key TEXT PRIMARY KEY, project_ulid TEXT, role_name TEXT NOT NULL, keys TEXT NOT NULL, ai TEXT NOT NULL DEFAULT '{}', fetched_at TEXT NOT NULL DEFAULT (datetime('now')))`. `scope_key` = `'office'` or the project ULID. LOCAL: plain `BEGIN/COMMIT` like 0011, not a CRR.
  - `interface AccessPayload { office: { role: string; keys: string[] } | null; projects: Array<{ ulid: string; code: string; role: string; keys: string[]; ai: Record<string, "allow" | "ask" | "deny"> }>; replays: Array<{ project_ulid: string; upto_seq: number }> }` (shared with Task 4's endpoint; define it here)
  - `function writeAccessCache(db: DB, p: AccessPayload): { dropped: string[] }`: replaces all rows in one transaction and returns the project ULIDs that were cached before and are absent now (R15 input). Keys pass through `sanitizeKeys`.
  - `function readAccessCache(db: DB): Map<string, { role: string; keys: Set<string>; ai: Record<string, string> }>`

- [ ] **Step 1: Write the failing test**

```ts
test('0012 is local and latest', () => {
  assert.equal(latestMigration(t.db), '0012_access_cache');
  assert.ok(!SYNCED_TABLES.includes('access_cache' as never));
});
test('writeAccessCache replaces rows and reports dropped projects', () => {
  writeAccessCache(t.db, { office: { role: 'Office member', keys: ['office.project.create'] },
    projects: [{ ulid: A, code: 'SH', role: 'Owner', keys: ['note.view', 'bogus'], ai: {} },
               { ulid: B, code: 'NV', role: 'Reader', keys: ['note.view'], ai: {} }], replays: [] });
  assert.deepEqual([...readAccessCache(t.db).get(A)!.keys], ['note.view']);   // bogus sanitized away
  const r = writeAccessCache(t.db, { office: null, projects: [{ ulid: A, code: 'SH', role: 'Owner', keys: ['note.view'], ai: {} }], replays: [] });
  assert.deepEqual(r.dropped, [B]);
  assert.equal(readAccessCache(t.db).has('office'), false);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd core && npx tsx --test test/access-cache.test.ts`
- [ ] **Step 3: Write the migration and `cache.ts`; update the registry, doctor and the three 0011 assertions.**
- [ ] **Step 4: Run** `npx tsx --test test/access-cache.test.ts test/bind.test.ts test/project-left.test.ts test/known-migrations.test.ts test/setup-doctor.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(core): 0012 local access_cache (RnR S1 schema bump)`

---

### Task 3: Office roles, membership, guards and upgrade seeding

**Files:**
- Create: `post-office/src/access.ts`
- Modify: `post-office/src/store.ts` (`PO_SCHEMA`: new tables; `registerProject` takes the creator device and seeds roles + Owner; `openStore`/`createStore` call `seedAccess`)
- Test: `post-office/test/access.test.ts`

**Interfaces:**
- Consumes: `CATALOG`, `sanitizeKeys`, `STARTER_*` (Task 1).
- Produces (all in `post-office/src/access.ts`):
  - Tables (in `PO_SCHEMA`): `po_roles (ulid PK, project_ulid TEXT NOT NULL, name TEXT NOT NULL, keys TEXT NOT NULL, is_starter INTEGER NOT NULL DEFAULT 0, created_at, UNIQUE(project_ulid, name))`, `po_project_members (project_ulid, device_id, role_ulid, PRIMARY KEY(project_ulid, device_id))`, `po_project_ai (project_ulid, key, state CHECK(state IN ('allow','ask','deny')), PRIMARY KEY(project_ulid, key))`, `po_note_owners (ulid PK, device_id)`, `po_office_roles (ulid PK, name UNIQUE, keys, is_starter)`, `po_office_members (device_id PK, role_ulid)`, `po_replays (device_id, project_ulid, upto_seq INTEGER NOT NULL, PRIMARY KEY(device_id, project_ulid))`.
  - `function projectKeys(db: Store, deviceId: string, projectUlid: string): Set<string>` (empty when not a member)
  - `function officeKeys(db: Store, deviceId: string): Set<string>`
  - `function memberProjects(db: Store, deviceId: string, key?: string): string[]` (projects where the device holds `key`, default `note.view`)
  - `function requireProjectKey(db: Store, deviceId: string, projectUlid: string, key: string): void` and `requireOfficeKey(db, deviceId, key)`: both throw `StoreError(<message per Global Constraints>, 403)`
  - `function seedProjectRoles(db: Store, projectUlid: string): Map<string, string>` (starter name → role ulid; idempotent)
  - `function setProjectMember(db: Store, actor: string, projectUlid: string, deviceId: string, roleName: string | null): void`: `null` removes. Gates: adding a non-member needs `member.invite`, changing a role needs `role.manage`, removing needs `member.revoke`. Refuses to leave zero Owners. Gaining `note.view` inserts `po_replays (device, project, upto_seq = lastSeq(db))` (R14). Losing it deletes any pending replay.
  - `function setOfficeRole(db: Store, actor: string | null, deviceId: string, roleName: string): void` (`actor = null` = office-machine CLI, unguarded). Refuses to leave zero Office admins.
  - `function seedAccess(db: Store): void`: idempotent, guarded by meta `access_seeded`. Starter office roles. Office admin = earliest-joined non-revoked member (by `joined_at`, then `created_at`), all others Office member. **This is my call:** the office can't know which laptop is the operator's; the CLI in Task 8 corrects it. Starter project roles + every current member as Owner of every existing `po_projects` row (R11). `po_note_owners` backfilled from the earliest `po_deliveries.origin` per `entries` pk.
  - `registerProject(db, p, creatorDevice: string)`: seeds roles; creator = Owner; caller must hold `office.project.create` (checked in Task 4's route, not here).
  - `revokeMember` (existing): refuses when it would leave zero Office admins, and refuses a device that is the last Owner of any project.

- [ ] **Step 1: Write the failing tests**

```ts
test('seedAccess: earliest member is Office admin, others Office member; all Owners of existing projects', ...);
  // two members N (joined first), R; one existing project P
  // assert officeKeys(N) has 'office.role.manage'; officeKeys(R) equals {'office.project.create'}
  // assert projectKeys(R, P) has 'role.manage'; second seedAccess call changes nothing
test('registerProject: creator is Owner, nobody else is a member', ...);
  // assert memberProjects(R) excludes the new project
test('setProjectMember gates on member.invite / role.manage / member.revoke', ...);
  // Reader actor adding someone -> throws status 403, message includes 'member.invite'
test('last Owner cannot be demoted, removed, or revoked', ...);   // Review Focus 3: three paths
test('last Office admin cannot be demoted or revoked', ...);
test('gaining note.view queues a replay at the current last seq; losing it clears it', ...);
test('stored bogus keys grant nothing', ...);
  // UPDATE po_roles SET keys = '["note.view","ticket.close"]'; projectKeys has no 'ticket.close'
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/access.test.ts`
- [ ] **Step 3: Implement.** Existing `registerProject` callers (server route, tests, `test/office.ts`) pass a creator device. Tests that predate RnR pass the first member.
- [ ] **Step 4: Run** `npx tsx --test test/access.test.ts test/projects.test.ts test/store.test.ts test/cli.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): roles, membership, office scope, upgrade seeding (RnR R1/R11/R13)`

---

### Task 4: Office endpoints and gating

**Files:**
- Modify: `post-office/src/server.ts`
- Test: `post-office/test/access-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 functions; `AccessPayload` (Task 2).
- Produces (HTTP, all behind the existing auth + schema guard):
  - `GET /v1/access` → `AccessPayload` for the caller (`ai` = `po_project_ai` rows, `{}` when none; `replays` = the caller's `po_replays`).
  - `GET /v1/projects` → only projects the caller is a member of (R7a).
  - `POST /v1/projects` → requires `office.project.create`; creator = caller.
  - `POST /v1/modules` → requires `office.module.share`.
  - `GET /v1/projects/:ulid/members` → `{ members: [{ device_id, name, role, last_seen_at }], roles: [{ ulid, name, keys }] }`. The caller must be a member.
  - `PUT /v1/projects/:ulid/members/:device` body `{ role }` / `DELETE` same path → `setProjectMember`.
  - `PUT /v1/office/members/:device` body `{ role }` → `setOfficeRole` (requires `office.role.manage`).
  - `POST /v1/office/members` body `{ name }` → requires `office.member.add`; returns `{ device_id, secret }` (the laptop builds the join code).
  - `DELETE /v1/office/members/:device` → requires `office.member.revoke`.
  - Every membership/role change rings `access` to all streams. Project create still rings `projects`.

- [ ] **Step 1: Write the failing tests** (use `post-office/test/office.ts` to start a real office with members N and R)

```ts
test('GET /v1/access returns the caller role, keys and pending replays', ...);
test('GET /v1/projects hides projects the caller is not in', ...);
test('POST /v1/projects without office.project.create -> 403 naming the key', ...);
  // demote R to a custom office role with no keys first
test('PUT member by a Reader -> 403 "member.invite"; by an Owner -> 200 and an access event is rung', ...);
test('POST /v1/office/members returns a secret that /v1/join redeems', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/access-routes.test.ts`
- [ ] **Step 3: Implement the routes.** Path params are parsed with one small `match(route, /^PUT \/v1\/projects\/([^/]+)\/members\/([^/]+)$/)` helper. Keep the existing `switch` for fixed routes.
- [ ] **Step 4: Run** `npx tsx --test test/access-routes.test.ts test/server.test.ts test/projects.test.ts test/schema-guard.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): access + membership endpoints; gate project/module/member routes`

---

### Task 5: Delivery by project

**Files:**
- Modify: `post-office/src/store.ts` (add column `po_deliveries.project_ulid TEXT` via `ALTER` when missing, and index `idx_po_deliveries_project (project_ulid, seq)`), `post-office/src/deliveries.ts`
- Test: `post-office/test/deliveries-by-project.test.ts`

**Interfaces:**
- Consumes: `memberProjects` (Task 3).
- Produces:
  - `function stampProjects(db: Store, seqs: number[]): void`: runs inside `acceptChanges` after `applyChanges`. It resolves each row's owning entry ULID: `entries` → the pk; `refs`/`entry_modules` → the pk's `entry_ulid`; `entry_revisions` → the `entry_revisions.entry_ulid` of the pk; `modules` → none. Then it sets `project_ulid` to that entry's `project_ulid`, to `NULL` when the entry has no project or the table is `modules`, and to `'?'` when the entry isn't held yet. It then re-stamps any older `'?'` rows whose entry now exists. Also records `po_note_owners (ulid, origin)` on the first `entries` insert (`INSERT OR IGNORE`).
  - `function backfillProjectStamps(db: Store): void`: one-time (meta `deliveries_stamped`), run from `openStore` after `seedAccess`.
  - `fetchDeliveries(db, deviceId, after, limit)`: same signature. Adds `WHERE (project_ulid IS NULL OR project_ulid IN (<memberProjects(device)>))`. `'?'` rows go to nobody. `last_seq` still advances past filtered rows, so the bookmark logic is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test('member of A never receives B rows: entries, refs, entry_modules, entry_revisions', ...);
test('legacy E shared-module rows and modules rows still reach every member', ...);
test('orphan ref held as "?" and released when its entry arrives', ...);   // Review Focus 1
test('first insert records the note owner from the authenticated origin, not the author cell', ...);
test('backfill stamps pre-upgrade rows once', ...);
test('stamping 2000 changes adds < 5 ms', ...);
  // time acceptChanges for a 2000-change batch with vs without stampProjects (median of 5 runs);
  // assert (with - without) < 5
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/deliveries-by-project.test.ts`
- [ ] **Step 3: Implement.** Batch the entry lookups in one `IN (...)` query per call. No query per change: the 5 ms budget depends on it.
- [ ] **Step 4: Run** `npx tsx --test test/deliveries-by-project.test.ts test/deliveries.test.ts test/merge.test.ts test/merge-resolve.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): deliver each project's changes only to its members (R3)`

---

### Task 6: History replay endpoint

**Files:**
- Modify: `post-office/src/deliveries.ts`, `post-office/src/server.ts`
- Test: `post-office/test/replay.test.ts`

**Interfaces:**
- Consumes: `po_replays` (Task 3), stamped deliveries (Task 5).
- Produces:
  - `function fetchReplay(db: Store, deviceId: string, projectUlid: string, after: number, limit: number): { changes: WireChange[]; last_seq: number; more: boolean; done: boolean }`. It returns rows with `project_ulid = projectUlid AND seq > after AND seq <= upto_seq`, in seq order. When `after >= upto_seq`, it deletes the `po_replays` row and returns `done: true`. The row is deleted only on that confirming call, so a courier crash mid-replay just resumes. No `po_replays` row means `done: true` with no changes.
  - `GET /v1/replay?project=<ulid>&after=<n>&limit=<n>` → the above. The caller must hold `note.view` in the project.

- [ ] **Step 1: Write the failing tests**

```ts
test('replay returns only that project, only up to upto_seq, paged', ...);
test('replay row is deleted only by the confirming call (after >= upto_seq)', ...);
test('non-member gets 403 naming note.view', ...);
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run** `npx tsx --test test/replay.test.ts`, **expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): per-project history replay for new members (R14)`

---

### Task 7: Courier — access refresh, read-only on removal, replay

**Files:**
- Modify: `courier/src/engine.ts`
- Test: `courier/test/access.test.ts` (uses `courier/test/world.ts`)

**Interfaces:**
- Consumes: `GET /v1/access`, `GET /v1/replay` (Tasks 4, 6); `writeAccessCache` (Task 2); `markProjectLeft` (`core/src/projects.ts:258`); the existing apply + `reindexFts` path in `pull()`.
- Produces (private methods on the engine):
  - `refreshAccess(): Promise<void>`: GET `/v1/access`, then `writeAccessCache`. For each `dropped` project that is a local team project of this office, `markProjectLeft` (R15). Then `runReplays(payload.replays)`. A 404 (older office) is a no-op, logged once.
  - `runReplays(list)`: per project, loop `GET /v1/replay` from bookmark `sync_state['replay:<ulid>']` (default 0). Apply each page with the same transaction shape as `pull()`: apply, reindex, then move this bookmark. Use the same `namesUnknownProject` → `refreshProjects` → clash hold as `pull()`; on a clash, stop without moving the bookmark. Finish with the confirming call, then delete the bookmark key.
  - Wiring: `refreshAccess` runs inside the existing `syncNow` sequence (after `refreshProjects`, before `push`), and on a new `access` stream event via `enqueue`.

- [ ] **Step 1: Write the failing tests**

```ts
test('added to a project later: receives its full history', ...);
  // N creates SH and writes 3 notes; R is not a member -> R has none; N adds R as Reader -> R gets all 3
test('role granted while R is offline: history arrives after reconnect', ...);   // Review Focus 2
test('removed from a project: R keeps its notes, project marked left, nothing new arrives', ...);
test('replay of a project whose code clashes locally holds, bookmark unchanged', ...);   // Review Focus 5
test('access_cache mirrors the office after an access event', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd courier && npx tsx --test test/access.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/access.test.ts test/team-projects.test.ts test/engine.test.ts test/project-never-sent.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(courier): cache access, replay history, mark removed projects left (R2/R14/R15)`

---

### Task 8: CLI for testing before the UI

**Files:**
- Create: `cli/src/team.ts`
- Modify: `cli/src/main.ts` (route `team` and `office`), `post-office/src/cli.ts` (`set-office-role <member> <role>`, unguarded, office machine only)
- Test: `cli/test/team.test.ts`, extend `post-office/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 4 endpoints through core's `requestJson` with the notebook's sync target (the way `resolveAllocator` finds it).
- Produces commands, each printing one plain line or a small table:
  - `collab team list <CODE>`: members, their roles, and the project's roles.
  - `collab team set <member> <CODE> <role>` / `collab team remove <member> <CODE>`
  - `collab office role <member> <role>` · `collab office invite <name>` (prints a join code via `formatJoinCode`, the same format as `post-office add-member`) · `collab office revoke <member>`
  - `<member>` accepts a device id or a unique member name. An ambiguous name gets the same message style as `revokeMember` (`store.ts:307`).
  - Solo or no project: `team` commands answer `<CODE> is a solo project: it has no team or roles`.

- [ ] **Step 1: Failing tests** for: list output, a 403 shown as its plain message (exit code 1), the solo message, and `set-office-role` fixing the seeded admin.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run** `cd cli && npx tsx --test test/team.test.ts` and `cd post-office && npx tsx --test test/cli.test.ts`, **expect PASS.**
- [ ] **Step 5: Commit** — `feat(cli): collab team / office commands; post-office set-office-role`

---

### Task 9: Acceptance, regression and timing

**Files:**
- Create: `courier/test/rnr-s1-acceptance.test.ts`
- Test only. No product code unless a failure demands it (then fix in the owning task's files, with its own commit).

- [ ] **Step 1: Write the acceptance test**, two laptops plus an office, end to end:
  1. An upgraded office seeds N as Office admin and R as Office member.
  2. R creates project RK: only R sees it.
  3. R invites N as Reader: N receives RK's history.
  4. N (Reader) tries `team set` → refused, naming `role.manage`.
  5. R removes N: N's RK is read-only and receives nothing new.
  6. Legacy `E` shared-module note still reaches both.
  7. A laptop pinned at migration 0011 → 409 schema, courier state `needs-update`, nothing delivered (Review Focus 4).
- [ ] **Step 2: Regression on a copy of the real data.** Copy `mcp/collab.db` and the office store (see `post-office` `paths.ts` for its location) into a temp dir. Open both with the new build. Assert: every `entries` row unchanged; every pre-upgrade delivery still reaches every current member (R11 makes everyone Owner); `collab doctor` on the copy has no new errors. **Never open the real files for writing.**
- [ ] **Step 3: Run the full workspace suite once**, in a background subagent: `npm run test:all`. Expected: everything passes except the 4 known golden failures in the root suite (COLLAB-124). Report counts per package.
- [ ] **Step 4: Commit** — `test: RnR S1 acceptance + real-notebook regression`

---

## After S1 (not part of this plan)

S2 (change enforcement R4-R7, `can()` R8), S3 (team admin UI), S4 (AI R9-R10) each get their own plan once S1 is merged and verified on Windows.
