# Collab UI parity: implementation plan

**Status: waiting for the owner's approval. Nothing is built yet.**

**Goal:** the web UI covers the everyday actions that today exist only on the CLI. Collab is UI-first; the CLI stays as a power tool.

**Brief:** `docs/superpowers/prompts/collab-ui-parity.md`.

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
| `collab doctor --fix` | no, backlog | Rare repairs: fetch the add-on, start the courier, remove stale status files. Starting the courier is web UI part 3. Recommended default: a "Fix" button on Health after part 3 lands. |
| `collab sync status` | yes (exists) | SyncBar on every page |
| `collab sync status --team` | partly | Team → Members shows "last seen". The "behind by N" figure is a backlog item. |
| `collab sync start / stop / run` | no, out of scope | Web UI part 3 (brief). `run` is the courier process itself. |
| `collab sync setup <join code>` | no, out of scope | Joining from a new laptop is Stage D (brief) |
| `collab sync set-address <url>` | no, backlog | Needed only when the office's address changes (COLLAB-98). It is a repair, and the courier must be stopped and restarted around it, which is part 3. Recommended default: build it with part 3. Guide 07's "there's no command" is out of date; Task 7 fixes the wording. |
| `collab sync modules / share / unshare` | no | Shares legacy `E` modules office-wide. That is the old model, which projects replace; Office member lost it in S1. The Modules page already shows Shared or Private. |
| `collab sync autostart on/off`, `uninstall` | no | One-time machine setup, run once per laptop |
| `collab copy --from … --to …` | no, **needs your ruling (R1)** | It moves notes between modules and projects. It is a one-off cleanup (after a clash, or when adopting projects), not daily, but the clash and promote messages point people to it. Recommended default: backlog, as a "Copy notes here" action on the Projects page in a follow-up. |
| `collab notebook list / adopt / new / default / which` | no | Picks which notebook the programs open. The web server is bound to one notebook when it starts, so this can't be changed from inside it. `which` is already on the Health page. |
| `collab notebook reindex` | no | A rare repair; never run automatically (spec P11) |
| `collab office init / serve / add-member / revoke / set-office-role / set-project-role / status / share / unshare / modules` | no | They run on the office machine, which has no web UI. `add-member` and `revoke` have laptop equivalents (`team invite` and `team revoke`), which are now in the UI. The `set-*` commands are the emergency fix-it for when nobody holds the needed role. |
| `collab mcp`, `collab web`, `collab --version` | no | They start programs. The version is on the Health page (Version group). |

## Decisions (my calls; you can overrule them)

| # | Decision | Cost if wrong |
|---|---|---|
| **D1** | **Renaming a team project is broken today, so it gets fixed at the office.** Today `renameProject` changes only the local row, and the courier's `refreshProjects` puts the office's name back (`upsertTeamProjectFromOffice` overwrites a different name). The fix: a new office route `PUT /v1/projects/:p {name}`. It requires `project.edit` at the office and checks names are unique (`registerProject`'s check and wording, including "that project name is taken" for a project you're not in). It rings `projects`. Core's `renameProject` becomes async and office-first for team projects, keeping the laptop `assertCan`. The CLI awaits it (the MCP server has no rename tool). **So `project.edit` stops being laptop-checked:** it comes out of `LAPTOP` in `catalog.ts`, the UI catalog copy follows, and the S3-13 note is dropped from it. `note.copy.out` keeps the note. No migration: `po_projects.name` already exists. An older office answers 404, and the UI then says "The post office needs updating…". | If you'd rather keep `project.edit` laptop-checked, renames still have to reach the office, or they keep being undone. The other choice is to grey out team rename in the UI. Either way it is one route and one catalog line. |
| **D2** | **Invite** is in Team → Office → Members, as "Invite a person" with a name field. The success panel shows the join code in monospace with a Copy button, and says: "Give this code to <name>. On their laptop they run `collab sync setup <code>`. It works once and expires in 7 days. Treat it like a password: it is shown only once." It also says the person appears in the list once they have joined. The code is never logged, cached or put in the URL, and it is cleared when the panel is closed or the page is left. The office's answer gains an additive `expires_at` field, so the UI doesn't hard-code 7 days. An older office doesn't send it, and the sentence then leaves the expiry out. | Joining from a new laptop is Stage D, so "how they use it" is the CLI line for now. Stage D replaces one sentence. |
| **D3** | **Add an existing member** is in Team → <project> → Members, as "Add a member". It has a select of live office members not in the project (from `GET /api/team/office`) and a role select. The role select **offers only roles whose keys you hold** (S3-14), defaults to Reader, and says "Roles with permissions you don't hold aren't offered." It sends the existing `member/set`, so the office checks `member.invite` and no escalation. The CLI hint "Add one with `collab team set …`" goes. **This replaces ruling S3-9.** | Defaulting to Reader means least privilege; a wrong default costs one extra click. |
| **D4** | **Revoke** is in Team → Office → Members, as a "Revoke" button per row. It is greyed without `office.member.revoke`, or when the target's office role holds a key you lack (rank, S3-1; the reason names the first missing key, as the office would). It is also greyed on your own row: "This is this laptop. Revoke it from another laptop." The office still decides. Confirmation: "Revoke <name> from the office? Every request from that laptop is refused from now on, and it receives nothing new from any project. Notes already on it stay there. This can't be undone; to let them back, invite them again." The CLI hint goes. **This replaces ruling S3-7.** | Greying your own row is only a UI rule; the CLI can still do it. Lifting it is a one-line change. |
| **D5** | **Promote confirmation:** "Make <CODE> a team project? Its notes keep their numbers; new notes continue after <CODE>-<n> at the post office <url>. The courier sends all its notes to the office on its next sync. You become its Owner, and only members you add can see it. A team project can't be made solo again." `<n>` comes from `highestNumberOf`, which the list returns for solo rows. | The wording is easy to change. |
| **D6** | **Greyed controls on the Projects page** come from `/api/team/overview`, which is asked for separately so the page never waits for the office. Team create and Promote need `office.project.create`. Team rename needs `project.edit` in that project. The reasons use `needSentence`. With no post office: "This notebook isn't connected to a post office." With the office down: "The post office can't be reached right now." Only the team controls are greyed; everything solo stays usable. | None known; the office still checks everything. |
| **D7** | **Core's office errors get types.** `registerAtOffice` throws `OfficeUnreachableError` (a connect failure or timeout) and `OfficeRefusedError { status, officeError }` (an office 4xx). The messages stay word for word, so the CLI output and tests are unchanged. The web server maps them to 503, to the office's status with its sentence, or to 501 for an older office. | Purely additive. |
| **D8** | **A "Projects" link always shows in the sidebar**, after Modules. Solo projects need no office (rule 2). | Placement only. |
| **D9** | **Binding:** each project row lists its bound modules, each with Unbind. "Bind a module" offers this notebook's modules. Re-binding a bound module moves it, as the CLI does, and the page shows core's `bindChangeLine` sentence. Left projects can't be bound to (core refuses), so the control is greyed with core's reason. | None known. |

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

### Task 7: Acceptance, docs, full suite, branch review
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

## Needs your ruling

- **R1:** is `collab copy` everyday enough to need a UI now? The default is backlog.
- **D1:** do you accept it, including `project.edit` becoming checked at the office?
- Everything else above goes ahead with the stated default unless you say otherwise.

## Backlog (not in this plan, with recommended defaults)

- Pending invites, and revoking an unused join code, in the UI. Default: a "Waiting to join" section in Office → Members, using `GET /v1/status`.
- "Behind by N" on the Members tab.
- A team rename can collide with a local project name on another laptop: the upsert renames without a clash check. Default: record it as a project clash, as P10 does.
- `doctor --fix` and `sync set-address` buttons, with web UI part 3.
