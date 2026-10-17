# 8. Open items

As of 2026-10-18.

## Next up

1. **Rinku updates** to migration 0012.
2. **RnR S2:** the post office refuses changes a role doesn't allow. It starts with the parked "stray note on reconnect" issue, plus two carried items: moving a team note out of every project, and checking permission before numbering a pending note.
3. **RnR S3:** the team admin screens. Role editing must protect the Owner and Office admin names and stop people from managing someone above them.
4. **RnR S4:** AI Allow / Ask me / Deny and the approve/reject list.
5. **Web UI part 3:** this-laptop controls (not designed yet).

## Not built yet

- **Stage D:** `collab join` with a code, leaving a team, the web welcome page. Leaving must also remove you at the post office.
- Moving the post office to the company server (decided, on hold: COLLAB-113/114).
- Syncing tasks (that's why `task.*` permissions are switched off).

## Parked / deferred on purpose

| Item | Why parked | Note |
|---|---|---|
| A separate key for the AI, so the office can tell AI actions apart | needed for real AI enforcement; later | COLLAB-180 |
| A member = a person with several laptops (today 1 laptop = 1 member) | data-model change; later | COLLAB-180 |
| Copy gaps: retire originals, multi-source links, verbose output, retire a project, tag trust | found while using copy | COLLAB-178 |
| "Save to collab" suggestion after research | low priority | T-009 |
| Index hub integrity (`reachable ≠ found`) | in progress | T-011 |
| Office advertises old IP | needs an "update address" command | E-767 |
| Stray empty `internal-tools/collab.db` | ask before deleting | COLLAB-183 |
