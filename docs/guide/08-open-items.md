# 8. Open items

As of 2026-10-18.

## Next up

1. **Rinku updates** to migration 0013: pull, rebuild, migrate. Until then his courier shows needs-update. (S2 is merged; COLLAB-189.)
2. **RnR S3:** the team admin screens. Role editing must protect the Owner and Office admin names and stop people from managing someone above them.
3. **After S3:** the office records a promoted project's note numbers, closing the number-squatting window (your ruling, COLLAB-190).
4. **RnR S4:** AI Allow / Ask me / Deny and the approve/reject list.
5. **Web UI part 3:** this-laptop controls (not designed yet).

## Decided after RnR S2 (COLLAB-190)

1. **Speed budget:** target stays 5 ms per 2000-change batch; the strict test fails only above 6 ms.
2. **Office member and `module.edit`:** stays admin-only. Rinku can write notes in any module, but not change a module's settings.
3. **Number squatting on a promoted project:** fixed after S3.

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

## Parked after RnR S2 (COLLAB-189)

| Item | Note |
|---|---|
| Re-inserting a deleted (tombstoned) note: its number is not checked (security, existed before S2) | COLLAB-189 |
| Archive reads every number as an `E` number | COLLAB-189 |
| Archive roll-up of an `E` note can leak team text | COLLAB-189 |
| A refused split creation leaves its first half in the office tables | COLLAB-189 |
| `copyRefused` ignores removed refs | COLLAB-189 |
| A flaky CLI TLS test | COLLAB-189 |
| 4 stale server snapshots | COLLAB-189 |
| Project make-solo / delete inactive (overrides spec R7b) | COLLAB-189 |
