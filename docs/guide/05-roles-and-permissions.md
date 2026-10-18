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

## The AI part (stage S4, not built yet)

- Each permission has three AI settings: **Allow** (the AI just does it), **Ask me** (the AI saves a draft that waits for your approve/reject in the web UI) or **Deny**.
- Two layers: the project's limit (set by the owner) and your personal limit for your own AI, which can only be stricter.
- **Known limitation (deferred, COLLAB-180):** collab can't reliably tell your AI from you. The AI can run the CLI in a terminal and get your permissions. A real fix needs a separate key for the AI, checked at the post office. Until then, AI limits protect against your own AI's mistakes, not against a teammate trying to bypass them.

## What's left

| Stage | What |
|---|---|
| **S2** | Done 2026-10-18 (see above). |
| **S3** | The team admin screens in the web UI (members, roles, "who can do what", AI settings), with collab's own design rather than a copy of SupportHub or emp1st. |
| **S4** | AI Allow / Ask me / Deny and the drafts-to-approve list. |

## Speed promise

- No extra network call when you save.
- A permission check on the laptop adds under 1 ms; the post office's filtering adds under 5 ms per 2000 changes (measured: about 3–4 ms).
- Solo projects skip all of it.
