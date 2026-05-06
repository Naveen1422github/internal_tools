# Jules Dispatch Plan

This folder is the source of truth for tasks dispatched to Jules (jules.google).

## Snapshot
| ID | Title | Branch | PR |
|----|-------|--------|----|
| T1 | Real PTY backend (Phase 1) | `jules/t1-pty-backend` | _opened by Jules_ |
| T2 | Frontend visual parity + designer C-borrows (Phase 2) | `jules/t2-frontend-parity` | _opened by Jules_ |
| T3 | Agent CLI adapter scaffolds (Phase 3, scaffold only) | `jules/t3-agent-adapters` | _opened by Jules_ |

## File-boundary discipline
Each brief lists exactly which files Jules may touch and which are off-limits. The three tasks are designed to run **in parallel without merge conflict**:

| File | T1 | T2 | T3 |
|------|----|----|----|
| `tools/console.js` | ✅ rewrite | ❌ | ❌ |
| `server.js` | ✅ extend | ❌ | ❌ |
| `package.json` | ✅ add `node-pty` | ❌ | maybe `test` script |
| `public/index.html` | ❌ | ✅ | ❌ |
| `public/app.js` | ❌ | ✅ | ❌ |
| `public/styles*.css` | ❌ | ✅ | ❌ |
| `tools/agents/**` (new) | ❌ | ❌ | ✅ |
| `tools/codex.js` | ❌ | ❌ | read-only |
| `tools/collab.js` | ❌ | ❌ | ❌ |

## Phases not yet dispatched
- **Phase 4** — drag-task envelope into agent stdin + activity log entry on completion. Needs T1 + T2 + T3 merged first; small, do together with the user awake.
- **Phase 5** — review + fold Profiles/Collab tabs into the unified console activity bar (Identities + Knowledge sections). Architecture decision; do with the user awake.

## How to assign on jules.google
1. Open <https://jules.google>, sign in.
2. Pick repo `Naveen1422github/internal_tools`, branch `main`.
3. Paste the task description. Use one of:
   - **T1:** "Implement task T1 from `briefs/T1-pty-backend.md`. Read it in full, follow file-scope discipline, open a PR titled exactly as specified."
   - **T2:** same wording, brief `T2-frontend-parity.md`.
   - **T3:** same wording, brief `T3-agent-adapters.md`.
4. Repeat for all three (free tier supports 3 concurrent).

## Design reference
The original handoff bundle from claude.ai/design lives in `design-reference/`. Briefs reference it by file path so Jules has the exact source to port from.
