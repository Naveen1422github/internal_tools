# 8. Open items

As of 2026-10-19.

## Next up

1. **Rinku updates** to migration 0013: pull, rebuild, migrate. Until then his courier shows needs-update. (S2 is merged; COLLAB-189.)
2. **RnR S3: done 2026-10-19** (the team admin screens; see file 5). **Rinku: rebuild only, no migration** (S3 has no 0014). The post office must be updated and restarted for the Team page to work.
3. **After S3:** the office records a promoted project's note numbers, closing the number-squatting window (your ruling, COLLAB-190).
4. **RnR S4:** AI Allow / Ask me / Deny, the AI settings tab and the approve/reject list.
5. **Web UI part 3:** this-laptop controls (not designed yet).

## Decided after RnR S2 (COLLAB-190)

1. **Speed budget:** target stays 5 ms per 2000-change batch; the strict test fails only above 6 ms.
2. **Office member and `module.edit`:** stays admin-only. Rinku can write notes in any module, but not change a module's settings.
3. **Number squatting on a promoted project:** fixed after S3.

## Decided in S3 (2026-10-19)

1. **No escalation:** you can give, create or extend a role only with permissions you hold (S3-14).
2. **Your own role:** you can lower it, not raise it; the last Owner or Office admin can't lower themselves (S3-15).
3. **Rank:** nobody manages a member or role holding a permission they lack (S3-1).
4. **Locked built-ins:** Owner and Office admin are fixed; Office member keeps its name but its permissions can change; Editor, Contributor and Reader are editable (S3-2).
5. **Custom roles can be deleted** once nobody holds them (S3-3).
6. **Office roles are managed on the Team page;** revoking a device stays on the CLI (S3-7).
7. **The matrix is roles × permissions**, a deliberate change from the spec (S3-8).
8. **No "add a member" in the UI;** refused changes get their own page (S3-9, S3-10).
9. **Adding a device is checked like assigning its role:** you need every permission of the office role the new device gets (S3-14).

## Needs your ruling (found in S3)

| # | Item | What happens today |
|---|---|---|
| 1 | Revoking a device compares **office** roles only | Someone with `office.member.revoke` can revoke a device that outranks them inside a project, unless it is that project's only Owner. |
| 2 | Office member's permissions are editable | An Office admin could give Office member `module.edit`. Your ruling fixed only the starter preset, not the role. |
| 3 | A role held only by a removed device can never be deleted | The CLI can't give a removed device another role, so the role stays forever. The page says why. |
| 4 | Losing "View notes" through a role edit shows the "team you left" wording | The person is still a member, but their laptop says `<CODE> (<name>) is a team you left: its notes are read-only`. |
| 5 | Root `npm test` on Linux runs only the golden file | `sh` expands the unquoted `test/**/*.test.mts`. Windows is fine. On Linux run `npx tsx --test 'test/**/*.test.mts'`. |
| 6 | The plan says S3-2 and S3-3 differently about deleting Editor, Contributor and Reader | The code follows S3-3: these built-ins can never be deleted, even when nobody holds them. |
| 7 | Renaming Editor, Contributor or Reader is permanent | The old name can't be taken back, so `collab team set … Editor` then fails in that project. |
| 8 | A revoke refusal names projects the caller may not be in (since S1) | "this is the only Owner of SH…" is shown even to a caller who isn't in SH (R7a). |

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
