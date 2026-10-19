# Collab UI parity: implementation plan

**Status: approved 2026-10-19, with the rulings below. Being built on `collab-ui-parity`.**

**Owner's rulings (2026-10-19):**
- `collab copy` gets a UI: pick a source module or project, pick a target project, show the list, confirm, copy. It uses the same core code as the CLI.
- D1 is accepted: renaming a team project goes through the post office, and `project.edit` is checked there.
- D2 to D9: the defaults stand.
- **The owner's rule:** users should never need the command line for anything they do themselves. The AI may use the MCP, but every action a user takes needs a proper screen. Scope additions A to D follow (Tasks 9 to 12).
- R2 was not ruled on, so the default stands: the AI gets no team-admin tools until S4.

**Goal:** the web UI covers the everyday actions that today exist only on the CLI. Collab is UI-first; the CLI stays as a power tool.

**Brief:** `docs/superpowers/prompts/collab-ui-parity.md`.

**Owner's direction (2026-10-19, after the first draft):** move people off the command line as far as possible. There are two ways in:
- **the AI** does the operation for you (MCP tools);
- **the web UI**, when you want to do it yourself.

The CLI is left for one-time setup, the office machine, and emergency repairs. This version of the plan widens the scope to match:
- every row of the command table now says what the AI can do, as well as the UI;
- more commands get a screen.

**Architecture:**
- Projects are local core operations. A new `server/src/tools/projects.ts` calls the same core functions as `collab project`: `projectListRows`, `createProjectOp`, `promoteProject`, `renameProject`, `bindModule` and `unbindModule`.
- People go to the post office. `server/src/tools/team.ts` gains invite and revoke routes. They call the same office endpoints as `collab team invite|revoke`, plus core's `formatJoinCode`.
- "Add an existing member" uses the existing `member/set` route, which is the same `PUT` that `collab team set` sends.
- Two UI pieces: a new `/projects` page, and new controls on the Team page.

## Every CLI command

"Everyday" means guide 07's Everyday table, plus the project and team commands.

| Command | UI? | Where, or why not |
|---|---|---|
| `collab project list` | **yes (new)** | Projects page: code, name, mode, notes, waiting for a number, left team, bound modules |
| `collab project create <n> --code <C>` | **yes (new)** | Projects page, "New project", Solo |
| `collab project create … --team` | **yes (new)** | Projects page, "New project", Team |
| `collab project promote <code>` | **yes (new)** | Projects page, with a confirmation (D5) |
| `collab project rename <code> <name>` | **yes (new)** | Projects page. Team projects need the fix in D1. |
| `collab project bind <module> <code>` | **yes (new)** | Projects page, per project |
| `collab project unbind <module>` | **yes (new)** | Projects page, per bound module |
| `collab project use <code>` | no | It writes `.collab` in the terminal's current folder. The web server has no folder, so the action has no meaning there. |
| `collab team list <CODE>` | yes (S3) | Team → Members |
| `collab team set <member> <CODE> <role>` | yes (S3); **adding is new** | Changing a role already exists. "Add a member" is new (D3). |
| `collab team remove <member> <CODE>` | yes (S3) | Team → Members → Remove |
| `collab team office-role <member> <role>` | yes (S3) | Team → Office → Members |
| `collab team invite <name>` | **yes (new)** | Team → Office → Members → "Invite a person" (D2) |
| `collab team revoke <member>` | **yes (new)** | Team → Office → Members → "Revoke", with a confirmation (D4) |
| `collab refused list / copy / delete` | yes (S3) | Refused changes page |
| `collab doctor` | yes (exists) | Health page: setup checks with each printed fix, including which notebook is open |
| `collab doctor --json` | no | Machine output for scripts; the Health page reads the same report |
| `collab doctor --fix` | **yes (new)** | Health page: a "Fix" button on the checks it can repair safely: fetch the sync add-on, and remove leftover status files. It calls the same repairs as `--fix` (they move from `cli/src/doctor.ts` into core). "Start the courier" waits for web UI part 3. |
| `collab sync status` | yes (exists) | SyncBar on every page |
| `collab sync status --team` | partly | Team → Members shows "last seen". The "behind by N" figure is a backlog item. |
| `collab sync start / stop / run` | no, out of scope | Web UI part 3 (brief). `run` is the courier process itself. |
| `collab sync setup <join code>` | no, out of scope | Joining from a new laptop is Stage D (brief) |
| `collab sync set-address <url>` | **yes (new, C)** | Settings page: "The post office moved?" with an address field. It runs the same certificate check first, so an address where anything else answers is refused and nothing changes. A running courier picks up the new address on its next retry, so nothing needs stopping. The logic moves from `courier/src/cli.ts` into core. Guide 07's "there's no command" is out of date; Task 7 fixes the wording. |
| `collab sync modules / share / unshare` | **yes (new)** | Modules page: a Share / Stop sharing toggle on each module, using the same `GET` and `POST /v1/modules` calls. It needs `office.module.share` (checked at the office) and is greyed with the reason otherwise. These are the legacy office-wide modules, which projects replace, but they are still in use, so they get a screen. |
| `collab sync autostart on/off` | **yes (new, C)** | Settings page: "Start sync at login" (Task 11) |
| `collab sync uninstall` | no | Destructive and one-time: it removes sync from this machine. It stays a deliberate terminal action. |
| `collab copy --from … --to …` | **yes (new)** | Projects page: "Copy notes into <CODE>". Choose a module or project, and optionally mine only or since a date. The page lists what would be copied (`planCopy`), asks, then copies (`applyCopy`). That is the same list → ask → copy as the CLI, with core's words. The AI already has `collab_copy`. |
| `collab notebook list / which` | **yes (new, read-only)** | Health page: the notebooks on this computer, marking the one open now and the default |
| `collab notebook adopt / new / default` | no, backlog | They change which notebook the programs open. The web server is bound to one notebook when it starts, so switching means restarting it. Recommended default: a "Switch notebook" action once the web server can reopen its database (its own task). |
| `collab notebook reindex` | no | A rare repair; never run automatically (spec P11) |
| `collab office init / serve / add-member / revoke / set-office-role / set-project-role / status / share / unshare / modules` | no | They run on the office machine, which has no web UI. `add-member` and `revoke` have laptop equivalents (`team invite` and `team revoke`), which are now in the UI. The `set-*` commands are the emergency fix-it for when nobody holds the needed role. |
| `collab mcp`, `collab web`, `collab --version` | no | They start programs. The version is on the Health page (Version group). |

**Actions that had no command and no screen, or only the AI's draft card (scope additions A to D):**

| Action | Today | UI |
|---|---|---|
| Write a new note | the AI's draft card only (MCP `collab_add`) | **yes (new, A):** a "New note" button and form: type, title, summary, description, module, and a project picker that says where the note will land |
| See a note's project | not shown | **yes (new, B):** a project filter in Knowledge, and a project chip on note cards and in the drawer |
| Move a note to another project | `collab copy` (core only copies, on purpose: spec P8) | **yes (new, B):** "Copy to another project" in the drawer (D10) |
| Supersede a note | a browser prompt asking for the number | **yes (new, D):** a note picker |
| This laptop's notebook, member name and device id | `collab notebook which`; the device id and name are in no command | **yes (new, C):** Settings page. A core function `thisLaptop(db)` is added first. |
| Change the post office address | `collab sync set-address` | **yes (new, C):** Settings page (moved there from the Health task) |
| Start sync at login | `collab sync autostart on/off` | **yes (new, C):** Settings page, using the courier's own `autostartPlan`, `installAutostart` and `removeAutostart` (D11) |
| Errors, confirmations and prompts | browser `alert`, `confirm` and `prompt` | **yes (new, D):** proper dialogs and toasts everywhere |

## What the AI can do (MCP)

The AI already has these tools:
- `collab_project_create`, `collab_project_list`, `collab_project_bind`, `collab_project_unbind`;
- `collab_copy`, `collab_doctor`;
- all the note and task tools.

| Operation | AI tool | Why |
|---|---|---|
| Promote a project | **new: `collab_project_promote`** | The same `promoteProject`, with the same words as the CLI. Office-checked (`office.project.create`). |
| Rename a project | **new: `collab_project_rename`** | The same `renameProject` (D1). Team projects are checked at the office. |
| See a team's members and roles | **new: `collab_team_list`** (read-only) | Lets the AI answer "who can edit SH?" |
| Refused changes | **new: `collab_refused_list`**, `collab_refused_copy` | The AI can explain a refusal and keep the text in a solo project. **Delete stays human**, because it discards what you typed. |
| Change roles, add or remove members, edit roles | **no, until S4** | The office can't tell your AI from you (the known limitation in guide 05). The Allow / Ask me / Deny controls that would let you limit this are S4. Until then, team admin is done by a person in the UI. |
| Invite | **no, ever** | The join code is a password; it must not pass through the AI's context |
| Revoke | **no** | Destructive and can't be undone. A person does it, with a confirmation. |

## Decisions (my calls; you can overrule them)

| # | Decision | Cost if wrong |
|---|---|---|
| **D1** | **Renaming a team project is broken today, so it gets fixed at the office.** Today `renameProject` changes only the local row, and the courier's `refreshProjects` puts the office's name back (`upsertTeamProjectFromOffice` overwrites a different name). The fix: a new office route `PUT /v1/projects/:p {name}`. It requires `project.edit` at the office and checks names are unique (`registerProject`'s check and wording, including "that project name is taken" for a project you're not in). It rings `projects`. Core's `renameProject` becomes async and office-first for team projects, keeping the laptop `assertCan`. The CLI awaits it (the MCP server has no rename tool). **So `project.edit` stops being laptop-checked:** it comes out of `LAPTOP` in `catalog.ts`, the UI catalog copy follows, and the S3-13 note is dropped from it. `note.copy.out` keeps the note. No migration: `po_projects.name` already exists. An older office answers 404, and the UI then says "The post office needs updating…". | If you'd rather keep `project.edit` laptop-checked, renames still have to reach the office, or they keep being undone. The other choice is to grey out team rename in the UI. Either way it is one route and one catalog line. |
| **D2** | **Invite** is in Team → Office → Members, as "Invite a person" with a name field. The success panel shows the join code in monospace with a Copy button, and says: "Give this code to <name>. On their laptop they run `collab sync setup <code>`. It works once and expires in 7 days. Treat it like a password: it is shown only once." It also says the person appears in the list once they have joined. The code is never logged, cached or put in the URL, and it is cleared when the panel is closed or the page is left. The office's answer gains an additive `expires_at` field, so the UI doesn't hard-code 7 days. An older office doesn't send it, and the sentence then leaves the expiry out. | Joining from a new laptop is Stage D, so "how they use it" is the CLI line for now. Stage D replaces one sentence. |
| **D3** | **Add an existing member** is in Team → <project> → Members, as "Add a member". It has a select of live office members not in the project (from `GET /api/team/office`) and a role select. The role select **offers only roles whose keys you hold** (S3-14), defaults to Reader, and says "Roles with permissions you don't hold aren't offered." It sends the existing `member/set`, so the office checks `member.invite` and no escalation. The CLI hint "Add one with `collab team set …`" goes. **This replaces ruling S3-9.** | Defaulting to Reader means least privilege; a wrong default costs one extra click. |
| **D4** | **Revoke** is in Team → Office → Members, as a "Revoke" button per row. It is greyed without `office.member.revoke`, or when the target's office role holds a key you lack (rank, S3-1; the reason names the first missing key, as the office would). It is also greyed on your own row: "This is this laptop. Revoke it from another laptop." The office still decides. Confirmation: "Revoke <name> from the office? Every request from that laptop is refused from now on, and it receives nothing new from any project. Notes already on it stay there. This can't be undone; to let them back, invite them again." The CLI hint goes. **This replaces ruling S3-7.** | Greying your own row is only a UI rule; the CLI can still do it. Lifting it is a one-line change. |
| **D5** | **Promote confirmation:** "Make <CODE> a team project? Its notes keep their numbers; new notes continue after <CODE>-<n> at the post office <url>. The courier sends all its notes to the office on its next sync. You become its Owner, and only members you add can see it. A team project can't be made solo again." `<n>` comes from `highestNumberOf`, which the list returns for solo rows. With no number used yet, it says "new notes start at <CODE>-1" instead. | The wording is easy to change. |
| **D6** | **Greyed controls on the Projects page** come from `/api/team/overview`, which is asked for separately so the page never waits for the office. Team create and Promote need `office.project.create`. Team rename needs `project.edit` in that project. The reasons use `needSentence`. With no post office: "This notebook isn't connected to a post office." With the office down: "The post office can't be reached right now." Only the team controls are greyed; everything solo stays usable. | None known; the office still checks everything. |
| **D7** | **Core's office errors get types.** `registerAtOffice` throws `OfficeUnreachableError` (a connect failure or timeout) and `OfficeRefusedError { status, officeError }` (an office 4xx). The messages stay word for word, so the CLI output and tests are unchanged. The web server maps them to 503, to the office's status with its sentence, or to 501 for an older office. | Purely additive. |
| **D8** | **A "Projects" link always shows in the sidebar**, after Modules. Solo projects need no office (rule 2). | Placement only. |
| **D9** | **Binding:** each project row lists its bound modules, each with Unbind. "Bind a module" offers this notebook's modules. Re-binding a bound module moves it, as the CLI does, and the page shows core's `bindChangeLine` sentence. Left projects can't be bound to (core refuses), so the control is greyed with core's reason. | None known. |

| **D10** | **"Move to another project" is a copy.** Core moves notes between projects only by copying, on purpose (spec P8): the number is the project's (SH-12), so a note can't keep it in another project. The drawer offers "Copy to another project". It uses the copy flow with a new `ulids` filter on `planCopy`, limiting the plan to that one note. The original gets its `copied_to` link, as with `collab copy`. The note-create checks (`note.create` on the target; the target can't be a left team project) come from core, unchanged. | If you want a true move (copy, then retire the original), that is one more step after the copy: supersede the original by the copy. It is cheap to add. |
| **D11** | **Settings reuses the courier's own code.** The address change and start-at-login live in the courier package (they write the courier's config file and register the login task). The web server loads `@collab-mcp/courier` at run time, the way the CLI loads it. It does not add a dependency to `server/package.json`, because that would change `package-lock.json`, which must not be committed. The certificate check for an address change moves into core (`checkPostOfficeAt`). The courier's `setPostOfficeAddress` and `setAutostart` are exported and used by both `collab sync` and the web server. | If the courier package is missing (a broken install), Settings says so and shows the CLI fix. |
| **D12** | **The member name comes from the office.** The laptop stores only its device id. Settings asks the office for this device's name (`GET /v1/status`); offline it shows the device id with "name unavailable: the post office can't be reached". | None known. |
| **D13** | **One dialog and toast system** (`ui/src/components/Dialog.tsx` and `Toast.tsx`). It is used for every confirmation, error and success message that used `alert`, `confirm` or `prompt`. The Team page's inline confirmations stay as they are. A lint rule (`no-restricted-globals` for `alert`, `confirm` and `prompt` in `ui/src`) keeps them out. | Visual only. |

**No migration** on the laptop or the office. `X-Collab-Schema` stays the same, so Rinku only rebuilds.

## Global constraints

The S3 plan's constraints carry over unchanged:
- Stage files by name.
- Never commit `package-lock.json` or `ui/package-lock.json`.
- No `npm install`; use `npm ci --force`.
- Temporary databases only.
- Plain sentence-case copy, with the office's refusals shown verbatim.
- Build post-office before running the cli tests.
- Quote the root test glob: `npx tsx --test "test/**/*.test.mts"`.
- Push only `collab-ui-parity`.

Each task has one commit, a reviewer pass, and fix commits if the review finds anything.

## Tasks

### Task 1: Core, typed office errors (D7)
- **Files:**
  - Modify: `core/src/projects.ts`, `core/src/sync/errors.ts`
  - Test: `core/test/team-project-create.test.ts`
- **Tests:**
  - The office is down → `OfficeUnreachableError`, with the message unchanged.
  - An office 403 → `OfficeRefusedError`, with `status` 403 and the office's sentence in `officeError`.
  - An office 409 still throws `ProjectClashError`.
- **Commit:** `feat(core): office errors from project create/promote carry their status and wording`

### Task 2: Office and core, renaming a team project (D1)
- **Files:**
  - Modify: `post-office/src/store.ts` (`renameOfficeProject`), `post-office/src/server.ts` (route), `core/src/projects.ts`, `core/src/access/catalog.ts`, `ui/src/team/catalog.ts`, `cli/src/project.ts`
  - Test: `post-office/test/project-rename.test.ts` (new), `courier/test/` (the revert proof), `core/test/projects.test.ts`, `cli/test/`
- **Tests:**
  - **First, a failing proof:** rename a team project, the courier refreshes, and the name holds. Today the name is put back.
  - A Reader is refused with 403 `You need "Edit project" (project.edit) in SH to do this`.
  - A non-member gets 404.
  - A name taken by a project you're not in → 409 "that project name is taken".
  - The other laptop gets the new name on the `projects` ring.
  - Solo rename still makes no office call.
  - The UI catalog still equals core's.
- **Commit:** `fix: renaming a team project goes to the post office, so the courier no longer undoes it`

### Task 3: Web server, project routes
- **Files:**
  - Create: `server/src/tools/projects.ts`; modify `server/src/server.ts`
  - Test: `test/api.projects.test.mts`
- **Routes:**
  - `GET /api/projects` → `{ projects: rows (current = null), modules: [slug], office_url | null }`. Solo rows carry `highest`.
  - `POST /api/projects/create {name, code, team}`
  - `POST /api/projects/promote {code}`
  - `POST /api/projects/rename {code, name}`
  - `POST /api/projects/bind {module, code}` → `{ line }`
  - `POST /api/projects/unbind {module}` → `{ line }`
  - Errors are `{ error }` with core's text, without the `[collab] ` prefix:
    - not found → 404;
    - clash → 409;
    - office refusal → the office's own status and sentence;
    - unreachable → 503 "The post office can't be reached right now.";
    - older office → 501.
- **Tests:**
  - A solo-only notebook lists, creates, renames, binds and unbinds with **zero office calls**.
  - Creating a team project as an Office member works, and an Office member whose role lacks the key gets the office's 403 sentence.
  - Promote gives the next number in the response.
  - The office down → 503 for team create, while solo create still works.
- **Commit:** `feat(server): project routes call the same core operations as collab project`

### Task 4: Web server and office, invite and revoke (D2, D4)
- **Files:**
  - Modify: `server/src/tools/team.ts`, `post-office/src/server.ts` (`expires_at` on `POST /v1/office/members`)
  - Test: `test/api.team.test.mts` (extend), `post-office/test/`
- **Routes:**
  - `POST /api/team/invite {name}` → `{ device_id, name, join_code, expires_at? }`
  - `POST /api/team/revoke {device}`
- **Tests:**
  - The returned code parses with `parseJoinCode` and is redeemed by a second laptop.
  - Without `office.member.add` → the office's 403 sentence.
  - Revoking a higher-ranked device → 403 naming the key.
  - A successful revoke means that device's next request is refused.
  - Nothing the server logs contains the secret.
- **Commit:** `feat(server): invite and revoke from the web, through the same office endpoints as the CLI`

### Task 5: UI, Projects page (D5, D6, D8, D9)
- **Files:**
  - Create: `ui/src/pages/Projects.tsx`, `ui/src/pages/Projects.test.tsx`
  - Modify: `ui/src/api/client.ts`, `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`
- **Tests:**
  - Rows show mode and modules.
  - Solo create calls the client with `team: false`.
  - Promote asks first, with the D5 text and the number.
  - Team create is greyed with the reason when the key is missing, and when the overview fails with 503 (the solo controls stay enabled).
  - Rename sends the new name.
  - Bind and unbind show core's line.
  - The office's refusal is shown verbatim.
- **Commit:** `feat(ui): Projects page: list, create, promote, rename, bind and unbind`

### Task 6: UI, people on the Team page (D2, D3, D4)
- **Files:**
  - Modify: `ui/src/team/Members.tsx`, `ui/src/team/view.ts`, `ui/src/api/client.ts`
  - Create: `ui/src/team/Invite.tsx`
  - Test: `ui/src/pages/Team.members.test.tsx` (the two CLI-hint assertions are replaced), `ui/src/team/Invite.test.tsx`
- **Tests:**
  - Invite shows the code with Copy (`navigator.clipboard` is mocked) and the how-to sentence.
  - The code is gone after Close.
  - Invite is greyed without `office.member.add`, or without a key of Office member.
  - "Add a member" lists only office members not in the project, and only roles you can give.
  - Revoke asks first, is greyed by key and by rank, and is greyed on your own row.
  - The office's refusals show in the banner.
- **Commit:** `feat(ui): invite, add a member and revoke on the Team page`

### Task 7a: UI, copy notes into a project
- **Files:**
  - Server: `server/src/tools/projects.ts`
    - `POST /api/projects/copy/plan`: returns the plan as `{ target, items, lines }`, from `planCopy` and `copyPlanLines`.
    - `POST /api/projects/copy/apply`: plans again and applies. It answers 409 if the list changed since the plan.
  - UI: `ui/src/pages/Projects.tsx` (a copy panel)
  - Test: `test/api.projects.test.mts`, `ui/src/pages/Projects.test.tsx`
- **Tests:**
  - The plan lists the same notes as `collab copy`.
  - Apply copies them and shows `copyResultLines`.
  - A changed source gets the 409 "the list changed, check it again".
  - Copy into a team project you can't create notes in shows the refusal.
- **Commit:** `feat: copy notes into a project from the web, with the same plan, ask, copy as collab copy`

### Task 7b: Health page, safe fixes and notebooks (set-address moved to Task 11)
- **Files:**
  - Core: `core/src/setup/fix.ts` (new, moved out of `cli/src/doctor.ts`); `core/src/sync/address.ts` (new, moved out of `courier/src/cli.ts`)
  - CLI and courier: call those core functions
  - Server: `server/src/tools/setup.ts`
    - `POST /api/doctor/fix {id}`
    - `POST /api/sync/set-address {url}`
    - `GET /api/notebooks`
  - UI: `ui/src/pages/Health.tsx`
- **Tests:**
  - Fix runs only the repairs in the safe list (the add-on, stale status files); any other id → 400.
  - set-address with the wrong certificate → refused and nothing changes; with the right one, the DB and the courier config are updated.
  - `collab sync set-address` and `collab doctor --fix` output is unchanged.
  - The notebooks list marks the open one.
- **Commit:** `feat: Health page repairs, post office address and notebooks list (same code as the CLI)`

### Task 7c: Modules page, share and stop sharing
- **Files:**
  - Server: `server/src/tools/sync.ts`, `POST /api/sync/share {slug, shared}`, which forwards to `POST /v1/modules`
  - UI: `ui/src/pages/Modules.tsx`
- **Tests:**
  - Without `office.module.share`: greyed, with the reason, and the office's 403 sentence if sent anyway.
  - The office down → "The post office can't be reached right now."
- **Commit:** `feat(ui): share and stop sharing a module from the Modules page`

### Task 7d: MCP, the new AI tools
- **Files:** `mcp/src/server.ts`; tests next to the existing MCP tests
- **Tools:** `collab_project_promote`, `collab_project_rename`, `collab_team_list`, `collab_refused_list`, `collab_refused_copy`. Each calls the same core function and prints the same lines as the CLI.
- **Tests:**
  - Each tool's text equals the CLI's.
  - The AI actor's laptop checks apply (`project.edit` as `ai`).
  - There is no team-change, invite, revoke or refused-delete tool.
- **Commit:** `feat(mcp): AI tools for promote, rename, team list and refused changes`

### Task 9: New note form (A)
- **Files:**
  - Core: `noteDestination(db, { module, project })` (new, in `core/src/ops/add.ts`). It returns where a note would land: the project and why (named, bound module, or none), using the same `resolveProjectArg` as `addEntryAsync`.
  - Server:
    - `GET /api/collab/note-destination?module=&project=`
    - `POST /api/collab/entry/upsert` accepts `project`
  - UI:
    - `ui/src/components/NewNote.tsx`
    - a "New note" button in the header (AppShell) and on Knowledge
- **Tests:**
  - The form validates like `draftErrors`.
  - The project picker defaults to "automatic" and shows the destination line; choosing a project sends `project`.
  - A Reader in a team project is refused with the 403 sentence, shown in the form.
  - The server creates the note in the named project; a left project → 403.
- **Commit:** `feat(ui): New note form with a project picker that says where the note lands`

### Task 10: Notes show their project; copy a note to another project (B, D10)
- **Files:**
  - Core: a `ulids` filter on `planCopy`
  - Server:
    - `runSearch` takes `project` (a code, or `none` for E notes) and returns `project_ulid`
    - the entry read returns `project` (code, name, mode)
  - UI:
    - a Knowledge project filter
    - a project chip on cards and in the drawer
    - "Copy to another project" in the drawer, using the copy endpoints from Task 7a
- **Tests:**
  - Filter by SH returns only SH notes, and "No project" returns only E notes.
  - The chip shows the code and the name.
  - Copying one note copies exactly that note and shows the new number.
  - A target where `note.create` is refused shows the refusal.
  - A left project is not offered.
- **Commit:** `feat: notes show their project; filter by project; copy a note to another project`

### Task 11: Settings page (C, D11, D12)
- **Files:**
  - Core:
    - `thisLaptop(db)` → notebook name and path, device id, post office address, fingerprint
    - `checkPostOfficeAt(url, fingerprint)`
  - Courier: export `setPostOfficeAddress(dir, url)` and `setAutostart(dir, on)`; `collab sync set-address` and `collab sync autostart` call them, with output unchanged
  - Server: `server/src/tools/settings.ts`
    - `GET /api/settings`
    - `POST /api/settings/address {url}`
    - `POST /api/settings/autostart {on}`
  - UI: `ui/src/pages/Settings.tsx`, plus a sidebar link
- **Tests:**
  - Settings shows the notebook, the device id and the name (from the office).
  - Offline: the device id shows with the "name unavailable" line.
  - An address with the wrong certificate → refused and nothing changes; with the right one, the DB and the courier config are both updated.
  - Autostart on and off calls the plan's install and remove (with the deps stubbed) and writes `autostart` to the config.
  - The CLI output is unchanged.
- **Commit:** `feat: Settings page: this laptop, the post office address and start sync at login`

### Task 12: Dialogs and toasts instead of alert, confirm and prompt; a note picker for supersede (D)
- **Files:**
  - Create: `ui/src/components/Dialog.tsx`, `ui/src/components/Toast.tsx`, `ui/src/components/NotePicker.tsx`
  - Modify: `EntryDrawer.tsx`, `Health.tsx`, the ESLint config
- **Tests:**
  - Supersede opens the picker, a search finds a note, and choosing it asks to confirm, then calls `supersede`.
  - Delete asks in a dialog.
  - An error shows a toast.
  - Health's reassign-module and fix-summary use dialogs.
  - A grep test: no `alert(`, `confirm(` or `prompt(` remain in `ui/src` outside tests.
- **Commit:** `feat(ui): dialogs and toasts replace browser prompts; supersede picks a note`

### Task 13: Acceptance, docs, full suite, branch review
- **Files:**
  - Create: `test/ui-parity-acceptance.test.mts`
  - Modify: guides 05, 07 and 08
- **Acceptance**, with one office and two laptops, over the web API:
  1. Create a solo project.
  2. Promote it, then rename it; the name holds after the courier syncs.
  3. Bind a module.
  4. Invite R and join with the code.
  5. Add R as a Contributor.
  6. R tries to revoke N → 403.
  7. N revokes R.
  8. With the office stopped, the solo actions still work and the team actions → 503.
- **Docs:**
  - Guide 05: the new UI rows, and S3-7 and S3-9 replaced.
  - Guide 07: the Projects page; fix the set-address trap wording.
- **Full suite:** once, with counts per package against the baseline.
- **Then:**
  - a whole-branch review of `git diff collabv1...collab-ui-parity`;
  - fix commits for what it finds;
  - push `collab-ui-parity`.

## Rulings

All were taken on 2026-10-19; see the top of this plan.

## What still needs the terminal after this plan

- **One-time setup:** `collab sync setup` (Stage D gives it a screen), `notebook new/adopt`, `sync uninstall`.
- **Sync start and stop:** web UI part 3, the next piece. (Start-at-login is now in Settings.)
- **The office machine:** `collab office …`, which has no web UI.
- **Repairs:** `notebook reindex`.

## Backlog (not in this plan, with recommended defaults)

- Pending invites, and revoking an unused join code, in the UI. Default: a "Waiting to join" section in Office → Members, using `GET /v1/status`.
- "Behind by N" on the Members tab.
- A team rename can collide with a local project name on another laptop: the upsert renames without a clash check. Default: record it as a project clash, as P10 does.
- "Start the courier" as a Health fix, with web UI part 3.
