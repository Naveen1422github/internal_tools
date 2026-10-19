# Cloud task: collab UI parity

Repo: internal_tools, branch collabv1 (HEAD 1fe2cc9 or later). Build "collab UI parity": the web UI must cover the everyday actions that are CLI-only today. Owner's rule: collab is UI-first; the CLI stays as a power tool.

## Read first
- docs/guide/07-running-it.md (the command list) and docs/guide/05-roles-and-permissions.md
- docs/superpowers/plans/2026-10-19-collab-rnr-s3.md (how the Team page was built)
- cli/src/ for each command below, plus server/ and ui/src/ (pages/Team.tsx, team/)

## Must deliver
The UI must call the same core and post office code paths as the CLI; no duplicated logic.

1. Projects page:
   - list projects, with their mode and bound modules
   - create a solo project (name + code)
   - create a team project (name + code)
   - promote a solo project to team, with a confirm that explains what changes
   - rename a project
   - bind and unbind a module to a project
2. People, on the Team page:
   - invite a person to the office: show their join code, with a copy button, and say how they use it
   - add an existing office member to a team project with a role
   - revoke a device, with a confirm
   - (remove member and change role already exist)
3. Every action is permission-checked at the post office as in S3, with the same refusal wording. Controls you can't use are greyed out with the reason shown.
4. Solo projects work fully offline (no post office needed). Team actions show a plain "can't reach the post office" message when it's down.

## How to work
- Write a short plan to docs/superpowers/plans/2026-10-19-collab-ui-parity.md and STOP for my approval. In the plan, list every CLI command and say "UI: yes" or "UI: no + why". Nothing everyday may be CLI-only.
- After approval, build on branch collab-ui-parity from collabv1: TDD, one commit per task, a reviewer per task, and a whole-branch review at the end.
- Notes:
  - cli tests need post-office built first.
  - Root tests need the glob quoted: npx tsx --test "test/**/*.test.mts".
  - Use npm ci --force for the Windows-only rolldown package.
- No migration unless unavoidable; if needed, call it out.
- Push only collab-ui-parity. Never touch collabv1, never commit package-lock.json, never touch real notebook or office data.
- Final report: commits, test counts per package, decisions with what each costs if it's wrong, and anything that needs my ruling. Only flag blockers; everything else is a backlog item with your recommended default.

## Out of scope
Sync start/stop controls (web UI part 3), joining a team from a new laptop (Stage D), AI controls (S4).
