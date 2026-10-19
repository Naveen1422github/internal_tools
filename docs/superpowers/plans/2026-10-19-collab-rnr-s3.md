# Collab RnR stage S3 (team admin UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Owner (or anyone holding the right keys) manages a team project from the web UI: members and their roles, custom roles, a read-only "who can do what" matrix, and this laptop's refused changes. Every admin action is decided by the post office. The UI only asks and shows the answer.

**Architecture:** The office gains the missing admin rules and endpoints in `post-office/src/access.ts` and `server.ts`:
- role create, edit and delete, for both project and office scopes;
- the rank rule ("nobody manages someone above them");
- protected built-in roles.

The web server (`server/src/tools/team.ts`, new) forwards each UI call to the office as this laptop's device, through `requestJson` + `postOfficeTargetFromDb`. It passes the office's status and wording straight through. Refused changes stay local: `server/src/tools/refused.ts` (new) calls core's `listRefused` / `copyRefused` / `discardRefused`, the same functions as `collab refused`. Two new pages, `/team` and `/refused`, are built on `AppShell` and `Sidebar` with Tailwind.

**Tech Stack:** TypeScript (ESM), better-sqlite3 + cr-sqlite, Node `https`, `node:test` via `tsx --test`; UI: React 19, react-router 7, Tailwind 3, vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-17-collab-rnr-design.md`.
- **In S3:** the "Web UI (team admin)" section, minus the AI settings tab and the drafts list. The S1/S2 carry-overs come with it: the target's current-role check, and protected starter names (S2 plan, "After S2"; guide 08, "Next up" 2).
- **Rules S3 must keep:** R1 (the office owns the tables; stored keys are sanitized on read), R2 (the `access` event on every change), R7a (non-members see nothing), R7b (laptop-checked keys are marked), R13 (two scopes; one Office admin always), R14/R15 (gaining or losing `note.view` moves replays), and rule 4 (inactive keys are hidden and grant nothing).
- **Not in S3:** R9 and R10 are S4.

## Global Constraints

- New branch `collab-rnr-s3` from `collabv1` at `7f012d9`. Never commit to, push to or merge into `collabv1`; the user merges locally on Windows. Push only `collab-rnr-s3`, and only after the final review.
- **No migration 0014. No schema bump.**
  - Every office table S3 touches (`po_roles`, `po_office_roles`, `po_project_members`, `po_office_members`, `po_replays`) already exists in `PO_SCHEMA` (`CREATE TABLE IF NOT EXISTS`).
  - The laptop needs no new table: `access_cache` is 0012 and `refused_changes` is 0013.
  - So `X-Collab-Schema` stays `0013_refused_changes`. **Rinku does not need to migrate.** He needs a rebuild only to see the new screens, and his current build keeps syncing against the updated office.
  - If an office-only column turns out to be needed, add it the way `ensureDeliveryProjects` does (`ALTER TABLE` behind a `pragma_table_info` check), never under `mcp/migrations`. Report it.
- **The office decides, the UI asks.**
  - Every new rule lives in `post-office/src/access.ts` and is tested over HTTPS as the lower-ranked device.
  - Disabled controls in the UI are only a convenience. The spec says controls the viewer may not change are shown disabled, not hidden.
- **Refusal wording:**
  - A missing key uses S1's sentence: `You need "<label>" (<key>) in <CODE> to do this`, or `... in this office to do this`.
  - A structural refusal names no key and says what to do instead, as the existing Owner and Office admin guards do.
- **Speed (rule 6, ruling COLLAB-190):** the save path is untouched. The 5 ms target and the 6 ms strict gate stay as they are, and the existing perf tests must keep passing.
- **Unchanged rulings:**
  - Office member does not get `module.edit`.
  - `project.make_solo` / `project.delete` stay inactive, so they are hidden in the UI.
- **Data:** tests use temporary databases only (`mkdtemp`, `startOffice`, `startTestServer`). No task opens a real notebook or office file. There is none in this container, and there is no "regression on copies of the real data" step (unlike S2 Task 9).
- **Git hygiene:**
  - Never `git add -A` or `git add .`; stage files by name.
  - Never commit `package-lock.json` or `ui/package-lock.json`. No subagent runs `npm install`: dependencies were installed with `npm ci --force` because of the Windows-only `@rolldown/binding-win32-x64-msvc` in `ui/package.json`.
  - One commit per task, plus fix commits from reviews.
- **Tests per task:** each task runs only its targeted test files. The full suite runs once, in Task 10.
- **Baseline on `7f012d9`, measured 2026-10-19:**
  - core 413/413, post-office 139/139, courier 80 pass / 1 fail / 2 skipped (the ERR_OSSL_ASN1 cert flake, in `refusals.test.ts`), cli 29/29, mcp 7/7, gemini-mcp 14/14.
  - ui 46 pass / 4 skipped (vitest).
  - root 68 pass / 4 fail / 1 skipped: the 4 golden failures, `search all|by module|by category`, `doctor`.
  - The server package has no `test` script.
  - **Gotcha:** on Linux, `sh` expands the root script's unquoted `test/**/*.test.mts` to `test/*/*.test.mts`, so `npm test` runs only the golden file. Run the root tests with the glob quoted (`npx tsx --test 'test/**/*.test.mts'`); Windows passes it to Node unexpanded, so all files run there.
  - This container also needed `npm run fetch:crsqlite`; `vendor/` is git-ignored.
- **Baseline before Task 1:** run `npm run test:all` on `7f012d9` and record pass/fail counts per package. Known failures carried from S2: the 4 root golden failures (COLLAB-124), the ERR_OSSL_ASN1 CLI cert flake, and the 4 stale server snapshots (COLLAB-189).
- **UI copy:** plain and professional, in sentence case, with no jokes and no emoji. Name the action and its effect: "Remove from SH", "This role is held by 2 members. Give them another role first." Show the office's refusal text exactly as it arrives.
- **Scope:** don't add a feature the spec or the user didn't name. Leave out the AI settings tab, the drafts list, the promoted-project number fix and the parked archive/security bugs.
- **Tooling note:** the `superpowers:*` skills and the collab MCP (`collab_search`) are not available in this session. The process is followed by hand, and the knowledge-base entries (decision, gotcha, changelog) are listed in the final report for the user to record.

## Decisions made in this plan (my calls; the user can overrule)

| # | Decision | Default, and what it costs if wrong |
|---|---|---|
| S3-1 | **Rank = key sets.** You may change or remove a member, or edit or delete a role, only if your active keys include every active key of the target's current role. The refusal names the first key you lack, in the standard wording. Applies to project members (set and remove), office members (office role, revoke), and role edit and delete. The office machine's CLI (`actor = null`) stays exempt. | It is the same comparison S1 already uses for "nobody hands out a role above their own". Active keys only (`grant()`), so the inactive `task.*` keys stored in Editor never block a custom manager role. **If wrong:** two custom roles with different, non-nested keys can't manage each other. An Owner (all keys) can always manage everyone. |
| S3-2 | **Built-in roles are locked.** *Owner* and *Office admin*: name, keys and existence are fixed (keys = every key of their scope). *Office member*: name and existence are fixed, keys are editable. *Editor*, *Contributor* and *Reader*: fully editable, but can't be deleted while held, like any role. | The office counts Owners and Office admins **by name** (`liveOwners`, `liveOfficeAdmins`), and finds Office member by name when adding a device (`assignNewMemberOfficeRole`: a rename would crash every new join). Locking Owner's keys keeps "at least one Owner" meaningful: an Owner with no keys would lock the project. **If wrong:** someone who wanted a cut-down Owner must make a custom role instead. |
| S3-3 | **Delete a custom role** (not a built-in) only when no `po_project_members` / `po_office_members` row points at it, revoked devices included. | The user's rule ("built-ins can't be renamed or deleted") implies custom roles can be. A dangling `role_ulid` would make its holders silently drop out of every JOIN. **If wrong:** a cheap feature to remove (one endpoint, one button). |
| S3-4 | **Editing a role's keys keeps the role's stored inactive keys.** The UI sends active keys only; the office merges back the stored inactive ones (`task.*`). Unknown, wrong-scope or inactive keys in a request are refused with a message, not dropped. | Otherwise saving Editor would silently strip `task.*`, and Editor would lose them the day tasks sync. **If wrong:** the starter presets would differ after the first edit. |
| S3-5 | **A key edit moves access for every holder.** In the same transaction, each live holder that gains `note.view` gets a `po_replays` row (R14), and each that loses it has its replay dropped (R15). Then `access` is rung. The before/after logic moves out of `setProjectMember` into one helper used by both. | Without it, a member given `note.view` through a role edit would never receive the project's history. **If wrong:** none known; this is the existing behaviour, applied to one more path. |
| S3-6 | **Role names:** trimmed, 1–40 characters, unique **case-insensitively** within the project (or office), and never a built-in name. | `UNIQUE(project_ulid, name)` is case-sensitive, so "owner" would sit next to "Owner". **If wrong:** a looser rule is a one-line change. |
| S3-7 | **Office scope is in the UI.** The Team page has a scope picker: each team project the laptop belongs to, plus "Office". Office → Members lists office members and changes their office role. Office → Roles creates and edits office roles. **Revoking a device stays on the CLI** (`collab team revoke`). | The user's protected-name rule names Office admin, so office roles are managed in S3. Revoking is destructive and not named for the UI. **If wrong:** dropping the Office scope removes Task 3 and one picker entry. |
| S3-8 | **Deliberate deviation from the spec (user ruling 2026-10-19):** the spec's matrix is members × keys; S3 builds **roles × keys**, as the user asked. Each role column shows its members' names under the role name, so "why can't Rinku supersede?" is still answered at a glance. Read-only. Active keys only, grouped by area. | **If wrong:** transposing to members × keys is a view-only change. |
| S3-9 | **No "add a member to this project" in the UI.** Members lists the project's members only. Adding stays `collab team set <member> <CODE> <role>`. | Neither the spec's Members tab (name, last seen, role, remove) nor the brief names it. **If wrong:** one picker of office members not yet in the project, on an endpoint that already exists (PUT member with `member.invite`). |
| S3-10 | **Refused changes get their own page, `/refused`.** A sidebar item with a count appears only when there are any, like "Needs merge". It is not a tab of the Team page, because refusals span projects. "Copy to a solo project" offers only this notebook's solo projects. | The spec puts refused notes under "Waiting for you", which S4 builds out with the AI drafts. S4 can move the list there. **If wrong:** a route move. |
| S3-11 | **Where the Team page shows.** The sidebar shows "Team" only when this notebook is connected to a post office and belongs to at least one team project, or holds an office role. Solo-only notebooks see nothing new (rule 2). | The UI has no "current project" today. A picker on the page replaces it. **If wrong:** a later "current project" can preselect the picker. |
| S3-12 | **Fresh answers, not the cache.** The Team page reads members, roles and the viewer's own keys from the office on each load (`GET /v1/access` and the members call), not from `access_cache`. Offline means the page says the post office can't be reached; nothing is shown stale. | Admin screens must not show permissions the office has already changed. **If wrong:** none known; the office is one hop away on the LAN. |
| S3-13 | **Laptop-checked keys** (`checkedOn: 'laptop'`: `note.copy.out`, `project.edit`) carry the R7b mark in the role editor and the matrix: "Checked on this laptop. It limits your AI, but it is not a security boundary." | Spec R7b. |

**User rulings, 2026-10-19:** S3-1, S3-2, S3-3 and S3-7 to S3-10 are accepted as written. Two rules are added:

| # | Rule (enforced at the post office, not only in the UI) |
|---|---|
| S3-14 | **No escalation.** An actor may (a) assign a role, (b) create a role, or (c) add permissions to a role only when every active permission of that role is among the actor's own active permissions. For (c), the role's resulting key set is tested. This is S3-1's superset test, applied to the role being granted or created. Owner holds everything, so it is unaffected. The refusal names the first key the actor lacks, in the standard wording. |
| S3-15 | **Self-role changes.** Raising your own role is refused by S3-14. Lowering your own role is allowed. The exception is the last Owner (or the last Office admin), who can't demote themselves: the existing 409. |

## Review Focus

0. **Every escalation path is refused at the post office itself.** Each test sends HTTPS to the office as the lower-ranked device, with no web server in the path. Each refusal uses the standard wording. The paths:
   - assign a higher role, to someone else or to yourself;
   - create a role with permissions you lack;
   - edit a role to add permissions you lack;
   - manage (change, remove or revoke) a higher-ranked member.

   Both scopes are covered. Lowering your own role is accepted; the last Owner lowering themselves gets the 409. The tests live in `post-office/test/escalation.test.ts` (Tasks 1–3 each add their paths).

1. **The rank rule is enforced on every path, including the CLI routes.** `PUT/DELETE /v1/projects/:p/members/:d`, `PUT/DELETE /v1/office/members/:d`, and role edit/delete each refuse a lower-ranked actor over HTTPS. `collab team set|remove|office-role|revoke` inherits the rule (the CLI calls the same routes). Test lives in Task 1.
2. **Protected built-ins survive every path.** Renaming, deleting or changing the keys of Owner and Office admin is refused. Renaming or deleting Office member is refused. A custom role can't be named "owner". After a refused attempt, adding a new office member still works. Test lives in Tasks 2 and 3.
3. **A role key edit moves replays.** Give Reader `note.view` back after taking it away: every holder gets a `po_replays` row and an `access` ring, and the holder's courier receives the history (R14). Test lives in Task 2 (office) and Task 4 (world test with a courier).
4. **Office refusals reach the person in their own words.**
   - The web server passes the office's 403/404/409 status and its `error` through.
   - The UI client tells the web guard's `{ error: 'forbidden' }` (reload the page) apart from an office refusal (show the message).
   - An older office's `404 no such endpoint` reads "The post office needs updating before roles can be managed here."
   - A revoked device (`AccessRevokedError`) and a schema mismatch (`SchemaMismatchError`) are plain messages, not 500s.
   - Test lives in Tasks 4 and 6.
5. **The last Owner and the last Office admin hold on every new path.** Demote via the role picker, remove, and delete or edit a role. Test lives in Tasks 1–3.
6. **Copy and delete on the page are the CLI's actions.** The routes call the same core functions as `collab refused copy|delete`. A team target and an unknown id are 4xx with core's message. Test lives in Task 5.

---

### Task 1: Office — rank rule on members (S3-1)

**Files:**
- Modify: `post-office/src/access.ts` (`setProjectMember`, `setOfficeRole`, `assertRevocable` caller path; a new `requireOutranks`)
- Modify: `post-office/src/server.ts` (`DELETE /v1/office/members/:d` passes the actor)
- Modify: `post-office/src/store.ts` (`revokeMember` takes an optional `actor`)
- Test: `post-office/test/admin-members.test.ts` (new; HTTPS through `office.ts` helpers), `post-office/test/escalation.test.ts` (new, Review Focus 0: the member paths)

**Interfaces:**
- Produces:
  - `function activeKeysOfRole(scope: Scope, storedKeys: string): Set<string>` (the existing `grant`, exported under this name).
  - `function requireOutranks(db: Store, actor: string, scope: Scope, projectUlid: string | null, targetKeys: Set<string>): void`. For each target key the actor lacks, it throws the first one with `requireProjectKey` / `requireOfficeKey`, so the wording is unchanged.
  - `setProjectMember(db, actor, p, d, role)`: when `actor !== null` and the target has a current role, call `requireOutranks` on the current role's keys **before** the key checks on the new role.
  - `setOfficeRole(db, actor, d, role)`: the same, on the target's current office role.
  - `revokeMember(db, who, { deviceOnly, actor })`: with an actor, `requireOutranks` on the target's office role.

- [ ] **Step 1: Failing tests**

```ts
test('a custom manager role (role.manage + member.revoke, no project.edit) cannot change or remove an Owner, naming project.edit', ...);
test('the same role can change and remove a Contributor', ...);
test('an Editor-like custom role is not blocked by Editor\'s stored inactive task.* keys', ...);   // active keys only
test('an Owner can demote another Owner; the last Owner still cannot be demoted or removed (409)', ...);
test('office: a custom office role with office.role.manage but not office.member.add cannot change an Office admin\'s office role', ...);
test('office: revoking a device ranked above you is refused naming the key; the office CLI (actor null) is exempt', ...);
test('collab team set by a lower-ranked member prints the office refusal (cli)', ...);   // in cli/test/team.test.ts
// escalation.test.ts (S3-14/S3-15), raw HTTPS to the office:
test('assigning a role holding a key you lack, to someone else or to yourself -> 403 naming that key', ...);
test('managing a higher-ranked member (set, remove, office role, revoke) -> 403 naming the first key you lack', ...);
test('lowering your own role is accepted; the last Owner lowering themselves -> 409; the last Office admin likewise', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/admin-members.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/admin-members.test.ts test/access.test.ts test/access-routes.test.ts test/cli.test.ts` and `cd cli && npx tsx --test test/team.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): nobody manages a member ranked above them (RnR S3-1)`

---

### Task 2: Office — project roles: create, edit, delete (S3-2 to S3-6)

**Files:**
- Modify: `post-office/src/access.ts` (`createProjectRole`, `updateProjectRole`, `deleteProjectRole`, and `syncReplays` pulled out of `setProjectMember`)
- Modify: `post-office/src/server.ts` (routes; `membersOf` adds `is_starter` and `locked`)
- Test: `post-office/test/admin-roles.test.ts` (new), `post-office/test/escalation.test.ts` (extend: create a role with keys you lack; edit a role to add keys you lack -> 403 naming the key)

**Interfaces:**
- Produces:
  - `function createProjectRole(db, actor: string | null, projectUlid, input: { name: unknown; keys: unknown }): { ulid: string; name: string; keys: string[] }`. Needs `role.manage`. Every key must be an active project key (else 400 `"<key>" is not a permission that can be given`). Every key must be held by the actor (`requireProjectKey`, existing wording). The name follows S3-6. `is_starter = 0`.
  - `function updateProjectRole(db, actor, projectUlid, roleUlid, input: { name?: unknown; keys?: unknown }): boolean`:
    - needs `role.manage`, and `requireOutranks` on the role's current active keys;
    - every newly given key must be held by the actor;
    - Owner → 409 `The Owner role can't be renamed or changed`;
    - S3-4: the stored inactive keys are kept;
    - then `syncReplays` for each holder, all in one `.immediate()` transaction;
    - returns `true` when something changed.
  - `function deleteProjectRole(db, actor, projectUlid, roleUlid): void`:
    - needs `role.manage` and `requireOutranks`;
    - built-in → 409 `<Name> is a built-in role and can't be deleted`;
    - held → 409 `<N> member(s) hold <Name>. Give them another role first`.
  - `function syncReplays(db, deviceId, projectUlid, before: boolean): void` (R14/R15; shared with `setProjectMember`).
  - Routes, all behind `requireMembership` (R7a: 404 for a non-member). Each rings `access` when something changed:
    - `POST /v1/projects/:p/roles {name, keys}` → `{ role }`
    - `PUT /v1/projects/:p/roles/:r {name?, keys?}` → `{ ok: true }`
    - `DELETE /v1/projects/:p/roles/:r` → `{ ok: true }`
  - `GET /v1/projects/:p/members` roles gain `is_starter: boolean` and `locked: "all" | "name" | null`. Members gain `role_ulid`.

- [ ] **Step 1: Failing tests**

```ts
test('an Owner creates a custom role; a holder of role.manage without project.edit cannot create one holding project.edit', ...);
test('unknown, office-scope and inactive keys are refused by name; names clash case-insensitively; "owner" is refused', ...);
test('renaming, re-keying or deleting Owner -> 409; Editor can be renamed and re-keyed; Editor keeps its stored task.* keys', ...);   // S3-2, S3-4
test('a lower-ranked manager cannot edit or delete a role holding keys they lack', ...);   // S3-1
test('deleting a held role -> 409 with the count, revoked holders included; an unheld custom role is deleted', ...);   // S3-3
test('taking note.view from a role drops its holders\' replays; giving it back queues one per live holder and rings access', ...);   // Review Focus 3
test('a non-member gets the same 404 for every role route; nothing is rung', ...);   // R7a
test('membersOf marks built-in and locked roles', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/admin-roles.test.ts`
- [ ] **Step 3: Implement.** Comment at the top of the new functions: the S3-1/S3-2 rules and why the names are fixed (lookups by name).
- [ ] **Step 4: Run** `npx tsx --test test/admin-roles.test.ts test/admin-members.test.ts test/access.test.ts test/access-routes.test.ts test/replay.test.ts test/replay-barrier.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): create, edit and delete project roles; Owner fixed; edits move replays (RnR S3)`

---

### Task 3: Office — office roles and the office members list (S3-2, S3-7)

**Files:**
- Modify: `post-office/src/access.ts` (`createOfficeRole`, `updateOfficeRole`, `deleteOfficeRole`, `listOfficeMembers`)
- Modify: `post-office/src/server.ts` (routes)
- Test: `post-office/test/admin-office.test.ts` (new), `post-office/test/escalation.test.ts` (extend: the same create/edit/assign paths for office roles)

**Interfaces:**
- Produces:
  - Office roles, the same shape and rules as Task 2, with `office.role.manage` and the office keys:
    - Office admin: name, keys and existence locked.
    - Office member: name and existence locked, keys editable.
  - `GET /v1/office/members` (any live member) → `{ members: [{ device_id, name, role, role_ulid, last_seen_at }], roles: [{ ulid, name, keys, is_starter, locked }] }`. Only live, joined devices are listed. Waiting and revoked devices keep showing in `collab sync status` as today.
  - `POST /v1/office/roles`, `PUT /v1/office/roles/:r`, `DELETE /v1/office/roles/:r`. Each rings `access` when something changed.

- [ ] **Step 1: Failing tests**

```ts
test('Office admin cannot be renamed, re-keyed or deleted; Office member cannot be renamed or deleted, but its keys can change', ...);
test('after a refused rename of Office member, POST /v1/office/members still adds a device as Office member', ...);   // Review Focus 2
test('an Office member (no office.role.manage) gets 403 naming office.role.manage on every role route', ...);
test('a custom office role is created, assigned via PUT /v1/office/members/:d, and cannot be deleted while held', ...);
test('GET /v1/office/members lists live members with their office role', ...);
test('the last Office admin still cannot be moved to another office role (409)', ...);
```

- [ ] **Step 2: Run, expect FAIL** — `cd post-office && npx tsx --test test/admin-office.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/admin-office.test.ts test/admin-roles.test.ts test/admin-members.test.ts test/access-routes.test.ts test/cli.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(post-office): office roles can be created and edited; Office admin and Office member are fixed (RnR S3)`

---

### Task 4: Web server — `/api/team/*` forwards to the office

**Files:**
- Create: `server/src/tools/team.ts`
- Modify: `server/src/server.ts` (spread `team.routes`)
- Create: `test/helpers/team-server.mjs` (an office from `courier/test/world.ts`, a joined notebook, then `startTestServer`-style startup with `COLLAB_DB_PATH` set to that notebook)
- Test: `test/api.team.test.mts` (new; one office-backed web server per file: the server is a singleton)

**Interfaces:**
- Consumes: `postOfficeTargetFromDb`, `requestJson`, `AccessRevokedError`, `SchemaMismatchError` (core); Tasks 1–3 endpoints.
- Produces (POST for every change, like the existing routes):
  - `GET /api/team/overview`:
    - answers `{ connected: false }` when the notebook has no post office;
    - otherwise `{ connected: true, me: { device_id }, office: { role, keys } | null, projects: [{ ulid, code, name, role, keys }] }`;
    - built from the office's `GET /v1/access`, plus project names from this notebook.
  - `GET /api/team/project?ulid=` → the office's members call, as is.
  - `GET /api/team/office` → `GET /v1/office/members`, as is.
  - `POST /api/team/member/set {scope: 'project'|'office', project?, device, role}`
  - `POST /api/team/member/remove {project, device}` (project scope only, S3-7)
  - `POST /api/team/role/create {scope, project?, name, keys}`
  - `POST /api/team/role/update {scope, project?, role, name?, keys?}`
  - `POST /api/team/role/delete {scope, project?, role}`
  - **Errors:**
    - The office's status and `{ error }` pass through unchanged.
    - Office `404` with `no such endpoint` → `501 { error: "The post office needs updating before roles can be managed here." }`.
    - `AccessRevokedError` → `403 { error: "This laptop's access to the post office was revoked." }`.
    - `SchemaMismatchError` → `409 { error: <its message> }`.
    - A connect failure or timeout → `503 { error: "The post office can't be reached right now." }`.
    - No post office → `409 { error: "This notebook isn't connected to a post office." }`.
    - Every error body is `{ error }`, so the UI can tell it apart from the guard's `{ error: 'forbidden' }` (Review Focus 4).

- [ ] **Step 1: Failing tests**

```ts
test('overview: a solo-only notebook answers connected:false and never calls an office', ...);
test('overview lists the team projects this device belongs to with its keys, and its office role', ...);
test('member/set as a Reader -> 403 with the office\'s exact sentence (not 500, not "forbidden")', ...);
test('role/create then project shows the role; a role key edit is visible on the next project read', ...);
test('an older office (404 no such endpoint) -> 501 "needs updating"', ...);   // testHooks or a route the office lacks
test('office down -> 503 plain message', ...);
test('after member/set, the second laptop\'s courier refreshes access on the access event', ...);   // world.ts courier; Review Focus 3
```

- [ ] **Step 2: Run, expect FAIL** — `npm -w @collab-mcp/server run build && npx tsx --test test/api.team.test.mts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test test/api.team.test.mts test/api.refusal.test.mts test/web-guard.test.mts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(server): team admin routes forward to the post office and keep its wording (RnR S3)`

---

### Task 5: Web server — refused changes routes

**Files:**
- Create: `server/src/tools/refused.ts`
- Modify: `server/src/server.ts` (spread `refused.routes`)
- Test: `test/api.refused.test.mts` (new)

**Interfaces:**
- Consumes: `listRefused`, `copyRefused`, `discardRefused`, `listProjects`, `formatEntryRef` (core). The CLI's `noteLabel`/`projectCode` logic moves into core as `describeRefused(db, row)`, used by both the CLI and the web, so the two lists say the same thing.
- Produces:
  - `GET /api/refused` → `{ results: [{ id, at, project_code, kind, key, reason, note }], solo_projects: [{ code, name }] }`
  - `POST /api/refused/copy {id, to}` → `{ ref }` (e.g. `"MY-4"`)
  - `POST /api/refused/delete {id}` → `{ ok: true }`
  - Errors from core: an unknown id → 404; a team target or an unknown project → 400. Each carries core's message without the `[collab] ` prefix.

- [ ] **Step 1: Failing tests:**
  - list shows a seeded refusal with the project code and the note label;
  - copy into a solo project returns the new ref and removes the row;
  - copy into a team project → 400 with core's sentence;
  - delete of a `new` refusal removes the local note;
  - an unknown id → 404;
  - `collab refused list` output is unchanged (`cd cli && npx tsx --test test/refused.test.ts`).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run** `npx tsx --test test/api.refused.test.mts` and `cd cli && npx tsx --test test/refused.test.ts`, `cd core && npx tsx --test test/refused.test.ts`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(server): refused changes list, copy to solo and delete on the web (RnR R6)`

---

### Task 6: UI — client, Team page shell, Members tab

**Files:**
- Modify: `ui/src/api/client.ts` (team and refused calls; a `sendJson` helper that maps a 403 `{error:'forbidden'}` to `RELOAD_MESSAGE` and any other error body to its `error` text)
- Create: `ui/src/team/catalog.ts` (a copy of the catalog's areas, labels, descriptions, `checkedOn` and `active` for the UI: the UI's TS project can't import core). A test in `test/` asserts it equals `core`'s `CATALOG`, so it can never drift.
- Create: `ui/src/pages/Team.tsx`, `ui/src/team/Members.tsx`
- Modify: `ui/src/App.tsx` (route `/team`), `ui/src/components/Sidebar.tsx` ("Team" per S3-11)
- Test: `ui/src/pages/Team.members.test.tsx`, `ui/src/api/client.test.ts` (extend), `test/ui-catalog.test.mts`

**Interfaces / behaviour:**
- **Scope picker:** one entry per team project (`CODE · Name`), plus "Office" when the viewer holds an office role. The choice is kept in the URL (`/team?scope=SH`), so a reload keeps it.
- **Tabs:** Members, Roles, Who can do what.
- **Members (project):** a table with Name, Last seen, Role and an action.
  - Role is a select; changing it asks no question and applies at once.
  - Remove opens a confirmation: "Remove <name> from <CODE>? They keep a read-only copy of the project's notes and receive nothing new." Buttons: Remove, Cancel.
  - The viewer's own row is marked "You".
  - Controls are disabled with a `title` explaining why, from the viewer's keys: no `role.manage` → "You need "Manage roles" (role.manage) in SH to do this"; same sentence style for `member.revoke`. The office stays the judge.
- **Members (office):** Name, Last seen, Office role (select). No remove (S3-7). The page says: "To remove a device from the office, use `collab team revoke` on any laptop with that permission."
- **Errors:** any refusal is shown in a dismissible inline banner above the table, word for word. A 501/503 replaces the page body with the message.
- **Empty states:** "This project has no other members yet. Add one with `collab team set <member> <CODE> <role>`." (S3-9)

- [ ] **Step 1: Failing tests** (mocked client, jsdom):
  - the picker lists projects and Office;
  - changing a role calls `teamSetMember` with the device and role;
  - an office refusal is shown verbatim;
  - remove asks before calling;
  - without `role.manage` the select is disabled;
  - `{error:'forbidden'}` → `RELOAD_MESSAGE`, any other 403 → its text;
  - the UI catalog equals core's.
- [ ] **Step 2: Run, expect FAIL** — `cd ui && npx vitest run src/pages/Team.members.test.tsx src/api/client.test.ts` and `npx tsx --test test/ui-catalog.test.mts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, plus `cd ui && npx tsc -b`. **Expect PASS.**
- [ ] **Step 5: Commit** — `feat(ui): Team page and Members tab, per project and for the office (RnR S3)`

---

### Task 7: UI — Roles tab and role editor

**Files:**
- Create: `ui/src/team/Roles.tsx`, `ui/src/team/RoleEditor.tsx`
- Test: `ui/src/team/Roles.test.tsx`

**Behaviour:**
- **The list:** one card per role, built-in roles first, in catalog order (Owner, Editor, Contributor, Reader; Office admin, Office member), then custom roles by name. Each card shows:
  - the name, a "Built-in" tag where it applies, and the number of members;
  - its active keys as labels.
  - Buttons: Edit, Duplicate, Delete (custom roles only), and "New role".
- **The editor** (a panel on the page):
  - a name field;
  - the catalog grouped by area, one toggle per **active** key, with its label, its description and the key in monospace;
  - laptop-checked keys carry the S3-13 note;
  - inactive keys are not shown (rule 4).
  - Save / Cancel.
- **Duplicate** opens the editor prefilled with the same keys and the name "<Name> (copy)".
- **Owner and Office admin:** "Edit" is replaced by "View". The editor is read-only with the note "This built-in role always holds every permission. It can't be renamed or changed." Office member: its name field is read-only with "This built-in role can't be renamed."
- **Disabled toggles:** toggles for keys the viewer lacks are disabled, with "You can only give permissions you hold yourself."
- **Delete confirmation:** "Delete the role <Name>? This can't be undone." The office's 409 (held) is shown as is.

- [ ] **Step 1: Failing tests:**
  - built-ins listed first, custom ones by name;
  - inactive `task.*` keys never appear;
  - the Owner editor is read-only;
  - Duplicate prefills;
  - Save sends active keys only;
  - a toggle for a key the viewer lacks is disabled;
  - delete asks, then shows the office's 409 text.
- [ ] **Step 2: Run, expect FAIL** — `cd ui && npx vitest run src/team/Roles.test.tsx`
- [ ] **Step 3: Implement.** **Step 4: Run, expect PASS** (+ `npx tsc -b`).
- [ ] **Step 5: Commit** — `feat(ui): Roles tab: list, create, duplicate, edit and delete roles (RnR S3)`

---

### Task 8: UI — "Who can do what" matrix (S3-8)

**Files:**
- Create: `ui/src/team/Matrix.tsx`
- Test: `ui/src/team/Matrix.test.tsx`

**Behaviour:**
- **Layout:** rows are active keys grouped by area (an area header row), showing label and key. Columns are roles, in the Roles tab order. Each column header shows the role's name and, below it, its members' names (or "No members").
- **Cells:** a check mark with screen-reader text "Allowed", or an empty cell with "Not allowed".
- **Laptop marks:** laptop-checked rows carry the S3-13 mark.
- **Read-only.** In Office scope it shows office keys and office roles.
- **Width:** it scrolls horizontally inside its own box when there are many roles; the page itself never scrolls sideways.

- [ ] **Step 1: Failing tests:**
  - Contributor's column has `note.edit.own` allowed and `note.supersede` not;
  - members' names appear under their role;
  - no inactive key row;
  - office scope shows office keys.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(ui): who can do what, roles against permissions (RnR S3)`

---

### Task 9: UI — Refused changes page and sidebar count (S3-10)

**Files:**
- Create: `ui/src/pages/Refused.tsx`
- Modify: `ui/src/App.tsx` (route `/refused`), `ui/src/components/Sidebar.tsx` ("Refused changes" with a count, only when there are any; same 30 s refresh as Needs merge)
- Test: `ui/src/pages/Refused.test.tsx`

**Behaviour:**
- **Intro line:** "The post office turned down these changes. They are kept on this laptop only."
- **Table:** When, Project, Kind ("New note" / "Edit"), Note, Reason, and the actions.
- **Copy to a solo project:**
  - a select of `solo_projects` and a Copy button;
  - on success: "Copied as MY-4." and the row disappears;
  - with no solo project: "Create a solo project first: `collab project create <name>`."
- **Delete:** confirmation "Delete this refused change? What you typed is removed from this laptop." For a new note it adds "The note is removed too."
- **Empty:** "Nothing was refused." (the CLI's words).

- [ ] **Step 1: Failing tests:**
  - rows render with the reason verbatim;
  - Copy calls `refusedCopy(id, code)` and shows the new ref;
  - Delete asks first;
  - with no solo project the Copy select is replaced by the hint;
  - the sidebar shows the count only when > 0.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS** (+ `npx tsc -b`, `npm -w ui run build`).
- [ ] **Step 5: Commit** — `feat(ui): refused changes page with copy to solo and delete (RnR R6)`

---

### Task 10: Acceptance, docs and full suite

**Files:**
- Create: `test/rnr-s3-acceptance.test.mts`
- Modify: `docs/guide/05-roles-and-permissions.md` (a "Stage S3" section), `docs/guide/07-running-it.md` (where the screens are), `docs/guide/08-open-items.md` (S3 done; the rulings taken)
- Test only otherwise. If a failure demands product code, fix it in the owning task's files with its own commit.

- [ ] **Step 1: Acceptance**, over the web API with one office and two laptops (N, R):
  1. N (Owner) makes R a Contributor of SH via `/api/team/member/set`. R's courier refreshes and R can create a note.
  2. N creates "Reviewer" = Reader + `note.supersede`, and gives it to R.
  3. R, through R's own web server or straight over HTTPS as R, tries to change N's role → 403 naming `role.manage`. It is checked at the office: the UI is not in the path.
  4. N gives R `role.manage` + `member.revoke` (a custom "Lead" without `project.edit`). R tries to remove N (Owner) → 403 naming `project.edit` (rank, S3-1).
  5. Renaming or deleting Owner → 409. Demoting N while N is the only Owner → 409.
  6. N takes `note.view` from Reader while R holds a Reader-based role, then gives it back → R is owed a replay and receives the history.
  7. R has a refused edit (from S2's flow). `/api/refused` lists it. Copy to R's solo project gives a new note with R's text; delete removes another.
  8. Solo-only notebook: `/api/team/overview` → `connected: false`; zero office calls.
- [ ] **Step 2: Docs.**
  - Guide 05: what each screen does, and the rulings S3-1 to S3-13 in one line each.
  - Guide 08: S3 done. "Rinku: rebuild only, no migration."
- [ ] **Step 3: Full workspace suite once,** in a background subagent: `npm run test:all` and `cd ui && npx vitest run`. **Expected:** the baseline counts plus the new tests, with no new failures. Report counts per package.
- [ ] **Step 4: Commit** — `test: RnR S3 acceptance; docs: team admin screens`
- [ ] **Step 5: Whole-branch review** (a fresh reviewer over `git diff collabv1...collab-rnr-s3`). The Review Focus items above are the checklist, with the wording and plain-copy rule added. Fix rounds get their own commits.
- [ ] **Step 6: Push** `git push -u origin collab-rnr-s3`. Never `collabv1`.

---

## After S3 (not part of this plan)

- **Merge runbook:**
  1. Back up both DBs.
  2. Merge `--no-ff` on Windows.
  3. Rebuild every package (`npm run build`).
  4. Restart the post office, the courier, MCP and the web server.
  5. **No migrate step:** S3 has no migration.
  6. Rinku pulls and rebuilds; no migration for him either.
- **Next:**
  - the promoted-project number fix (ruling COLLAB-190);
  - then S4: AI Allow / Ask me / Deny and the drafts list, which may move the refused list under "Waiting for you".
