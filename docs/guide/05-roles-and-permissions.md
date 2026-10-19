# 5. Roles & permissions (RnR)

Designed 2026-10-17 (COLLAB-180). Spec: `docs/superpowers/specs/2026-10-17-collab-rnr-design.md`.

## Your rules (what you asked for)

1. **Nothing is hardcoded.** Every "may X do Y" comes from a role. Starter roles are just editable presets.
2. **Team projects only.** Solo projects have no checks and no screens.
3. **Two kinds of actor:** you, and your AI.
4. **The AI can never do more than its human.**
5. **It must not make collab slow.**

## The model (copied from SupportHub, not emp1st)

- A **catalog** of permissions lives in code (`core/src/access/catalog.ts`). A role can only hold keys from it, so a database row can't grant something the code never checks.
- A **role** is a named bundle of keys. Each member gets **one role per team project**.
- There are two levels: **Project** (notes, conflicts, project settings, team) and **Office** (create projects, share legacy modules, add or remove members, manage modules). It's like a GitHub organisation vs a repository.

**Why not emp1st's model:** emp1st has the same 10 on/off actions on every screen, and they're mostly checked in the browser. SupportHub has named permissions checked on the server, which is the industry standard.

Starter roles:

- **Project:** Owner (everything), Editor, Contributor, Reader
- **Office:** Office admin, Office member (can create projects)

Task permissions (`task.*`) exist but are **switched off**, because tasks don't sync yet. A permission that guards nothing is never offered.

## Where it's enforced

Each laptop holds the whole notebook in a file it can edit, so **any check on the laptop can be bypassed**. Real enforcement can only happen at the **post office**. Laptop checks are for user experience and for limiting your own AI.

## Stage S1 — live since 2026-10-18 (COLLAB-182/183)

- **Membership:** a new project starts with only its creator, as Owner. Others are added with a role. Projects you're not in are hidden from you.
- **Each project's notes go only to its members.** This is the core security change. Before S1, every member received every team project.
- **History for new members:** someone added later receives the project's full past.
- **Removed members** keep a read-only copy and receive nothing new.
- **Guards:** a project always has at least one Owner, the office always has at least one Office admin, and **nobody can hand out a role with more rights than they hold.**
- **Upgrade:** you became Office admin and Rinku Office member; you're both Owner of TT.
- **Commands:** `collab team list|set|remove|office-role|invite|revoke`, plus `collab office set-office-role` and `collab office set-project-role` on the office machine (the emergency fix-it).

### Bugs the reviews caught before go-live

- someone allowed to invite could invite a new member straight in as Owner
- non-members could find out a project exists (through error messages and notifications)
- a big upload could split a note so half of it went to everyone
- a project's only Owner couldn't be removed from the office
- a stray note could appear on reconnect
- rolling the office back would reopen the leak

All fixed, with tests.

### Behaviour changes you'll notice

- Rinku, as Office member, can no longer share old `E` modules.
- New projects start with only the creator.

## Stage S2 — built 2026-10-18 (COLLAB-189)

- **Enforced at the office.** Every laptop save is checked against the person's role. This is the real lock.
- **Pre-checked on the laptop** (`can` / `assertCan`), so you get the answer at once instead of after a sync. Your AI is checked as actor `ai`.
- **Refusal wording:** `You need "<label>" (<key>) in <CODE> to do this`.
- **Note numbers** are accepted only if the office allocated them to that note.
- **Project make-solo and delete are inactive for now.** (This overrides spec R7b.)
- A refused change is undone on your laptop; see file 4 and `collab refused` in file 7.

## Stage S3 — built 2026-10-19 (RnR S3)

The team admin screens in the web UI. The post office decides every change; the screens only ask and show its answer, word for word.

### The screens

- **Team page (`/team`).** A picker at the top: each team project you're in (`CODE · Name`), plus "Office" if you hold an office role. The choice stays in the address, so a reload keeps it. Three tabs:
  - **Members:** name, last seen, role and Remove. Changing the role applies at once. Remove asks first: "Remove <name> from <CODE>? They keep a read-only copy of the project's notes and receive nothing new." Your own row is marked "You". In Office scope you change office roles only; there is no Remove.
  - **Roles:** one card per role (built-ins first, then custom roles by name) with its member count and permissions. Edit, Duplicate, Delete (custom roles only) and New role. The editor shows only permissions that are switched on, grouped by area.
  - **Who can do what:** roles across the top, permissions down the side, with each role's members named under it. Read-only.
- **Refused changes page (`/refused`).** The changes the post office turned down, kept on this laptop only. Copy one into a solo project, or delete it. The sidebar shows "Refused changes" with a count only when there are some.

Controls you may not use are shown disabled with the reason, not hidden. That is only a convenience: the office still checks everything.

### The rules (one line each)

| # | Rule |
|---|---|
| S3-1 | **Rank:** you can change or remove a member, or edit or delete a role, only if you hold every permission their role holds. The refusal names the first one you lack. |
| S3-2 | **Locked built-ins:** Owner and Office admin can't be renamed, changed or deleted. Office member can't be renamed or deleted, but its permissions can change. Editor, Contributor and Reader are fully editable but can't be deleted. |
| S3-3 | **Deleting a role:** only custom roles, and only when nobody holds it. Removed devices count: then the message says "...including N removed device(s). It can't be deleted while a removed device still holds it." |
| S3-4 | **Switched-off permissions are kept:** saving a role keeps its stored `task.*` keys. Unknown or switched-off keys in a request are refused, not dropped. |
| S3-5 | **A role edit moves history:** whoever gains "View notes" through it receives the project's history; whoever loses it gets a read-only project and nothing new. |
| S3-6 | **Role names:** 1–40 characters, unique ignoring case, and never a built-in name ("owner" is refused). |
| S3-7 | **Office scope is on the page;** removing a device from the office stays on the CLI (`collab team revoke`). |
| S3-8 | **Deliberate change from the spec (your ruling):** the matrix is roles × permissions, not members × permissions. |
| S3-9 | **No "add a member" in the UI.** Use `collab team set <member> <CODE> <role>`. |
| S3-10 | **Refused changes have their own page**, because a refusal can come from any project. |
| S3-11 | **"Team" shows in the sidebar** only when this notebook is connected to a post office and is in a team project or holds an office role. Solo-only notebooks see nothing new. |
| S3-12 | **Fresh answers:** the Team page asks the post office on every load. Offline, it says the post office can't be reached; nothing stale is shown. Once the sidebar has shown "Team" it keeps it, so you can open the page and see why. |
| S3-13 | **Laptop-checked permissions** (`note.copy.out`; `project.edit` until UI parity moved it to the post office) carry the note "Checked on this laptop. It limits your AI, but it is not a security boundary." |
| S3-14 | **No escalation (your ruling):** you can give, create or extend a role only with permissions you hold yourself. |
| S3-15 | **Your own role (your ruling):** With Manage roles, you can lower your own role but not raise it; the last Owner can't lower themselves. |

### How it was checked

- The rank and no-escalation rules (S3-1, S3-14, S3-15) are tested by sending the request straight to the post office as the lower-ranked laptop, with no web server in the path.
- The role rules (S3-2 to S3-6) are tested at the post office; the screens (S3-8 to S3-13) are tested in the UI suite.
- The acceptance test (`test/rnr-s3-acceptance.test.mts`) runs the whole story with two laptops and one office.

## UI parity — built 2026-10-19

Your rule: you never need the command line for anything you do yourself. The AI may use the MCP tools; every action a person takes has a screen.

- **Team page, people:**
  - **Invite a person** (Office scope). It shows the one-time join code, with a Copy button, and says how it is used: `collab sync setup <code>` on their laptop, until Stage D gives joining a screen.
  - **Add a member** to a team project, from the office's members. Only roles you could give are offered; the default is Reader.
  - **Revoke** a device (Office scope), with a confirmation.
  - These replace S3-7 ("revoke stays on the CLI") and S3-9 ("no add a member in the UI").
- **Every one of them is checked at the post office**, with the same refusal sentence as S3. Greyed-out controls show the same sentence; they are a convenience only.
- **Renaming a team project goes to the post office** and is checked there with "Edit project" (`project.edit`). Before, a laptop-only rename was put back by the courier on its next sync. So `project.edit` is no longer laptop-checked; only `note.copy.out` carries the S3-13 note now.
- **What the AI may do (MCP):** promote and rename projects, list a team, list refused changes and keep one in a solo project. It may **not** change roles or members, invite, revoke, or discard a refused change: the office can't tell your AI from you yet (see below), so a person does those in the UI until S4.

## The AI part (stage S4, not built yet)

- Each permission has three AI settings: **Allow** (the AI just does it), **Ask me** (the AI saves a draft that waits for your approve/reject in the web UI) or **Deny**.
- Two layers: the project's limit (set by the owner) and your personal limit for your own AI, which can only be stricter.
- **Known limitation (deferred, COLLAB-180):** collab can't reliably tell your AI from you. The AI can run the CLI in a terminal and get your permissions. A real fix needs a separate key for the AI, checked at the post office. Until then, AI limits protect against your own AI's mistakes, not against a teammate trying to bypass them.

## What's left

| Stage | What |
|---|---|
| **S2** | Done 2026-10-18 (see above). |
| **S3** | Done 2026-10-19 (see above). The AI settings tab moved to S4. |
| **S4** | AI Allow / Ask me / Deny, the AI settings tab and the drafts-to-approve list. |

## Speed promise

- No extra network call when you save.
- A permission check on the laptop adds under 1 ms; the post office's filtering adds under 5 ms per 2000 changes (measured: about 3–4 ms).
- Solo projects skip all of it.
