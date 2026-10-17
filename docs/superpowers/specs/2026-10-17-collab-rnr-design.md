# Collab RnR: who (and whose AI) may do what in a team project

Status: direction agreed with the user in conversation 2026-10-17 (COLLAB-180); awaiting the user's review of this document. Web UI part 4 ("team admin") of the series in `2026-10-04-collab-web-lock-design.md` becomes this spec. Part 3 ("this-laptop controls") is a separate, later spec.

## In one paragraph (plain language)

Today every member of a post office can do everything in every team project, and every member receives every team project's notes. This piece adds Roles & Responsibilities. A **catalog** of permissions lives in code. A **role** is a named bundle of catalog permissions. Each member gets **one role per team project**. The **post office** checks every incoming change against the sender's role and refuses what the role doesn't allow, and it only delivers a project's notes to that project's members. Each permission also has an **AI setting**: Allow, Ask me, or Deny. "Ask me" turns an AI action into a draft that waits on your laptop until you approve it. Your AI can never do more than you can. Solo projects have none of this: no checks, no screens, no cost.

## Rules

1. **Nothing is hardcoded.** Every "may X do Y" answer comes from a role or an AI setting. Starter roles and default AI settings are presets, and every value in them can be edited. The only fixed rules are structural: a project always has at least one Owner, and the AI can never exceed its human.
2. **Team projects only.** Solo projects and `E` notes are never checked and never show RnR screens. A permission check on a solo project returns "allowed" without a lookup.
3. **The post office is the enforcer.** Checks on the laptop are for UX and for guarding your own AI. Any of them can be bypassed by editing the local notebook file, so security comes only from the office.
4. **A key that guards nothing is not offered.** Every catalog key must be checked somewhere real. Keys whose action isn't enforceable yet are present in the catalog but marked inactive and hidden in the UI (SupportHub's rule: a database row can never grant what the code never checks).
5. **Nothing is lost silently.** A change the office refuses is shown on the sender's laptop with the reason. Offline work refused on reconnect stays on the laptop, visible and recoverable.
6. **Speed is a requirement.** No network call is added to a save. A laptop-side check adds < 1 ms to a save. The office spends < 5 ms extra per accepted batch of up to 2000 changes. Breaking a budget is a bug.
7. **Identity = laptop for now.** One `po_members` row (device) is treated as one person. Person→devices is deferred (COLLAB-180).

## Permission catalog (approved 2026-10-17)

The catalog lives in one file, `core/src/access/catalog.ts`, imported by both the office and the laptop. Shape: area → keys, each key with a label and a description, as in `ingxt-supportHub/server/helpers/permissionCatalog.ts`.

| Area | Keys |
|---|---|
| Notes | `note.view`, `note.create`, `note.edit.own`, `note.edit.any`, `note.supersede`, `note.archive`, `note.copy.out` |
| Tasks | `task.create`, `task.assign`, `task.status.change` |
| Conflicts | `merge.resolve` |
| Project | `project.edit`, `project.make_solo`, `project.delete` |
| Team & access | `member.invite`, `member.revoke`, `role.manage`, `ai_limits.manage` |

**Starter roles** (presets, editable, more can be added): Owner = all keys. Editor = Notes + Tasks + Conflicts. (`module.*` moved to the Office scope, R13.) Contributor = `note.view`, `note.create`, `note.edit.own`, `task.status.change`. Reader = `note.view`. The project's creator becomes its Owner. Removing or demoting the last Owner is refused.

**Default AI settings for a new team project** (presets, editable): Allow for `note.view`, `note.create`, `note.edit.own`, `task.status.change`. Ask me for `note.edit.any`, `note.supersede`, `note.archive`, `note.copy.out`, `merge.resolve`. Deny for everything in Project and Team & access. Keys not listed default to Ask me.

### What the code shows about the catalog (resolved by R7b and R13)

- **Tasks don't sync.** `SYNCED_TABLES` is `entries, refs, entry_modules, entry_revisions, modules` (`core/src/sync/enable.ts:7`). A team project's tasks never reach the office, so `task.*` guards nothing today. Under rule 4 they ship **inactive** until tasks sync (my call).
- **Modules are notebook-wide.** The `modules` table has no project. Bindings (0011) are local and never reach the office. The office can't tell which project a `module.create` belongs to, so a per-project module key can't be enforced as written.
- **Some actions belong to the whole office, not one project.** Today any member can call `POST /v1/projects` (register a team project) and `POST /v1/modules` (share a legacy `E` module). `add-member` and `revoke` are CLI commands run on the office machine. None of these is inside a project.

## Decisions

| # | Decision | Why |
|---|---|---|
| R1 | Office-owned tables, never synced: `po_roles (ulid PK, project_ulid, name, keys JSON, is_starter, created_at)`, `po_project_members (project_ulid, device_id, role_ulid, PK(project_ulid, device_id))`, `po_project_ai (project_ulid, key, state, PK(project_ulid, key))`, `po_note_owners (ulid PK, device_id)`. Stored keys are sanitized against the catalog on every read, so a key removed from code grants nothing | Roles must never ride the CRDT sync (same reasoning as `project_modules`, COLLAB-179). The office is the source of truth |
| R2 | `GET /v1/access` returns, for the calling device: every team project it belongs to, its role's keys, and the project AI settings. The office rings an `access` event on the existing `/v1/events` stream whenever a role, membership or AI setting changes. The courier stores the answer in a local, unsynced table `access_cache` and refreshes it on that event | Gives the < 1 ms laptop check (rule 6). No call on save |
| R3 | **Delivery by project.** `po_deliveries` gains `project_ulid`, stamped when a change is accepted. It's resolved from the row's own `entries.project_ulid`, or from the owning entry for `refs`, `entry_modules` and `entry_revisions`. `fetchDeliveries` returns a row only if its `project_ulid` is a project the caller belongs to with `note.view`. Rows with no project (legacy `E` shared-module notes, `modules` rows) keep today's behaviour and go to every member | Today `fetchDeliveries` sends every row to every member (`deliveries.ts:78`), so `note.view` would mean nothing |
| R4 | **Classifier.** The office maps each incoming cell to one catalog key: insert of a new `entries` row = `note.create`. `superseded_by` set = `note.supersede`. `deleted_at`/`deprecated` set = `note.archive`. `needs_merge` 1→0 = `merge.resolve`. Any other `entries`/`refs`/`entry_modules`/`entry_revisions` cell on an existing note = `note.edit.own` if `po_note_owners` says the sender created it, else `note.edit.any`. Ownership comes only from `po_note_owners` (recorded from the authenticated device on first insert). Never from the incoming `author` cell, which a laptop can forge | The office sees cells `(table, pk, cid, val, col_version)`, not actions (`deliveries.ts:42`) |
| R5 | **Refusal unit = one laptop transaction** (same `site_id` + `db_version`). If any cell in a group is refused, the whole group is refused and not recorded. Other groups in the batch are still accepted, so a mixed batch is partly accepted. `POST /v1/changes` answers with an added `refused: [{site_id, db_version, ulid, key, reason}]` | A laptop transaction is one user action; accepting half of it would leave a broken note |
| R6 | **Undoing a refusal on the sender.** Edit to an existing note refused: the office writes its own current value back with column version = (highest version in the refused group) + 1, so it always wins on the sender's laptop. A plain +1 can lose to a run of offline edits. Before the courier applies that write-back, it saves the laptop's refused values. Both refused edits and refused new notes go into a local, unsynced table `refused_changes (ulid, kind: new\|edit, key, reason, values JSON, at)`. The UI lists them with actions: copy to a solo project, or delete. Nothing typed is lost (rule 5) | Rule 5. A new note can't be "written back" because the office never had it. (Builder check, my call) |
| R7 | `POST /v1/allocate` checks `note.create` for the note's project before numbering a pending note. A refused allocate is recorded by the courier into `refused_changes` straight from the allocate answer. **A new note is judged as a whole:** the office never accepts a later group of a note whose creation was refused | A pending note spans several laptop transactions, so R5's per-transaction rule can't apply to creation (builder check, my call) |
| R7a | **Default membership.** A newly registered project has only its creator, as Owner. A device joining the office gets no project role automatically. Projects you aren't a member of are not shown to you (`GET /v1/projects`, `/v1/status` and the `projects` event are filtered). S1 ships CLI `collab team add <member> <project> <role>` so membership works before the UI | Builder check, my call |
| R7b | **Laptop-checked keys.** `note.copy.out` and `project.edit`/`make_solo`/`delete` act only on the laptop; the office never sees them. They ship **active**, are checked by R8, and the UI marks them "checked on your laptop (guards your AI, not a security boundary)". Rule 4 is met because they guard the AI path for real | Builder check, my call. Consistent with COLLAB-180 deferred item 1 |
| R8 | Laptop check `can(projectUlid, key, actor)` in core: solo or no project = allowed without lookup. Team = an in-memory lookup in `access_cache`. `actor` is `human` or `ai`. MCP calls are `ai`, CLI and web are `human` | One function for all entry points |
| R9 | **AI effective setting** = the strictest of the role (no key = Deny), the project AI setting, and the personal AI setting (order Deny > Ask me > Allow). Personal settings live in a local, unsynced table `ai_personal (project_ulid, key, state)` and can only be stricter than the project setting. Enforced on the laptop's MCP path only | AI ≤ its human. Office-side AI enforcement needs a separate AI key (deferred, COLLAB-180) |
| R10 | **Ask me = AI draft.** The MCP tool doesn't apply the change. It stores the intended operation in a local, unsynced table `ai_drafts (ulid PK, project_ulid, key, op JSON, summary, created_at, status)` and answers "saved as a draft for approval: <id>". The web UI shows a badge with the count. Approving runs the op as `human` (role check applies). Rejecting discards it. The AI panel's existing in-memory `DraftCard` stays as is for new-note drafts typed in the panel. This queue is for MCP operations | The current DraftCard (`ui/src/components/DraftCard.tsx`) is in-memory and only drafts new notes. Supersede, archive and edit drafts need to survive a restart |
| R11 | **Existing data.** `po_projects` has no creator column today. When this ships, every current member becomes Owner of every existing team project (today that's NAVEEN + Rinku, test projects only). New projects: the registering device becomes Owner. Every existing note gets an owner backfilled from the earliest `po_deliveries.origin` for its insert. Notes with no record are owned by nobody, so only `note.edit.any` may edit them | My call: no one loses access on upgrade |
| R12 | Office schema version bumps. Every laptop must update before it can sync (the existing 409 schema guard). Rinku updates after NAVEEN | Wire contract change |

## Web UI (team admin)

The look is collab's own, built on the existing shell (`AppShell`, `Sidebar`, Tailwind). Do not copy SupportHub's or emp1st's screens. Shown only when the current project is a team project.

- **Team page** (`/team`, per project), with tabs:
  - **Members:** name, last seen, role (picker), remove.
  - **Roles:** list. Editing a role shows the catalog grouped by area, one toggle per key, with the key's description. Starter roles can be edited or duplicated.
  - **Who can do what:** a matrix of members × keys, read-only. It answers "why can't Rinku supersede?" at a glance.
  - **AI settings:** a three-state control per key, with two columns, "Project" and "My AI". "My AI" can't be set looser than "Project". Controls the viewer may not change are shown disabled, not hidden.
- **Waiting for you:** a sidebar badge and a list of AI drafts (R10) and refused notes (R6), each with approve/reject or copy/delete.
- **Every refusal names the missing key** in plain words ("Your role (Contributor) doesn't allow superseding notes in SH"), in MCP answers, the CLI and the UI.

## Build order (each stage tested on Windows and merged before the next)

1. **S1 catalog + membership + delivery by project:** the catalog file (both scopes), R1 + R13 tables, R2 endpoint and event, courier `access_cache`, R3 filtered delivery, R7a membership, R14 history replay, R15 read-only on removal, R11 backfill, R12 schema bump. CLI: `collab team role list|set <member> <role>` for testing before the UI exists.
2. **S2 enforcement:** R4 classifier, R5 refusals, R6 undo + `refused_notes`, R7, R8 on the CLI/web paths.
3. **S3 team admin UI:** Members, Roles, Who can do what, refused-notes list.
4. **S4 AI:** R9, R10, the AI settings tab and the drafts list.

## Testing ("done" = all pass)

- **No regressions.** A copy of the real notebook plus office, before and after: every solo, `E` and legacy shared-module behaviour is identical.
- **Delivery.** Member of project A only never receives a project-B row, including refs, tags and revisions of B notes.
- **Classifier.** One test per key: an allowed change is accepted and delivered. A refused change is not recorded or delivered, and the answer names the key.
- **Forged author.** A laptop that sends `author = <someone else>` on an edit is still judged by `po_note_owners`.
- **Mixed batch.** Two transactions, one allowed and one refused: the first is delivered, the second is refused whole.
- **Refused edit reverts the sender. Refused new note** shows in `refused_notes` and can be copied to solo.
- **Last Owner** can't be removed or demoted.
- **AI.** Allow / Ask me / Deny each behave as R9-R10. Personal can't loosen project. AI never exceeds role.
- **Timing.** Laptop check < 1 ms (p99 over 10k calls). Office extra < 5 ms per 2000-change batch.
- **Solo.** Zero access lookups, zero network calls.

## Not in this piece

- A separate AI key so the office can tell AI changes apart (deferred, COLLAB-180).
- Person identity with several devices per person (deferred, COLLAB-180).
- Syncing tasks (the `task.*` keys wait for it).
- Web UI part 3 (this-laptop controls): its own spec, next.

## Settled with the user (2026-10-17)

| # | Decision | Why |
|---|---|---|
| R13 | **Two scopes: Office and Project.** Office keys: `office.project.create` (register a team project), `office.module.share` (share a legacy `E` module), `office.member.add` (issue a join code), `office.member.revoke`, `office.role.manage`, plus `module.create` and `module.edit`, which **move out of the project catalog** because modules are notebook-wide. Starter office roles: **Office admin** (all keys) and **Office member** (`office.project.create`). Each device holds one office role. New tables: `po_office_roles (ulid PK, name, keys JSON, is_starter)` and `po_office_members (device_id PK, role_ulid)`. `POST /v1/projects` and `POST /v1/modules` are gated, and so are new endpoints for add/revoke, so the office machine's CLI isn't the only way. At least one Office admin must always exist. Project `member.invite` = give an existing office member a role in this project | Like GitHub's organization owner vs repository admin. Module changes can't be tied to a project |
| R14 | **Joining a project gives its full history.** When a device gains `note.view` in a project, the office replays every stored row of that project to it once, through a per-device-per-project replay cursor (`po_replays (device_id, project_ulid, after_seq)`), independent of the normal `receive_bookmark`. The courier applies replayed rows like normal deliveries; cr-sqlite makes re-applying a row harmless | Like Slack channels or `git clone`. Adds about 3-5 h to S1 |
| R15 | **Removed from a project = keep a read-only copy.** The removed device keeps its local notes of that project, marked read-only like `left_at` (P11). It receives nothing new | Same behaviour as leaving a team today |

R11 upgrade rule, extended: after the upgrade, the office machine's own device (NAVEEN) is **Office admin**, and every other current device (Rinku) is **Office member**. The office can't tell which member is its operator, so the seeding picks the **earliest-joined member** (NAVEEN today). `collab-post-office set-office-role` on the office machine corrects it if needed.
