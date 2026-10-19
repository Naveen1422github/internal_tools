# 7. Running it

All commands are run from `frontend2\internal-tools` unless noted. `C` below means `node cli/dist/bin.js`.

## Everyday

| What | Command |
|---|---|
| Health check (explains every problem with the fix) | `C doctor` |
| Start the post office (keep this terminal open) | `C office serve` |
| Start / stop / check the courier | `C sync start` · `C sync stop` · `C sync status` |
| List projects | `C project list` |
| See a team's members and roles | `C team list TT` |
| Give someone a role | `C team set <member> TT <role>` |
| List changes the office refused | `C refused list` |
| Keep a refused note in a solo project | `C refused copy <id> --to <SOLO CODE>` |
| Throw a refused change away | `C refused delete <id>` |
| Web UI | `C web`, then open `http://127.0.0.1:7473` |
| Manage members and roles on the web | `http://127.0.0.1:7473/team` ("Team" in the sidebar) |
| Refused changes on the web | `http://127.0.0.1:7473/refused` ("Refused changes" in the sidebar, shown only when there are some) |
| Projects on the web: create, make team, rename, bind modules, copy notes in | `http://127.0.0.1:7473/projects` ("Projects" in the sidebar) |
| Invite a person, add a member, revoke a device | the Team page: Office → Members, or a project → Members |
| Write a note yourself | "New note" at the top of every page |
| This laptop, the post office's address, start sync at login | `http://127.0.0.1:7473/settings` ("Settings" in the sidebar) |
| Fix a setup problem the safe way, see the notebooks | the Health page ("Fix" next to a check it can repair) |

**The Team page needs an updated post office.** It asks the office for every answer. An office still on the old code shows "The post office needs updating before roles can be managed here." Update and restart the office. Laptops need no migration; rebuild a laptop to see the screens. "Team" only appears when the notebook is connected to a post office and is in a team project or holds an office role.

**Trap:** running the CLI from inside `internal-tools/` picks up an empty stray `collab.db` there and fails with "no such table: entries". Set `COLLAB_DB_PATH` to `internal-tools/mcp/collab.db`, or run it from a folder whose `.collab` names your notebook.

**Start the post office in your own terminal, not inside a Claude session.** Claude Code stops background programs when memory runs low.

## After a code update (merge into `collabv1`)

1. Back up both databases (the notebook and `%LOCALAPPDATA%\collab\post-office\store.db`).
2. Merge, then **rebuild every package in the same step**: core, post-office, courier, cli, mcp, server, ui. An old build left running against new code has caused real damage before (COLLAB-109).
3. Restart the post office (it migrates its own store on start).
4. Migrate the notebook. **The courier does not migrate it**: either reconnect the collab MCP (`/mcp` → collab → Reconnect) or run core's migrate.
5. Restart the courier. Check that `C sync status` says **connected**.
6. Tell Rinku to pull, rebuild and migrate. Until he does, his courier shows **needs-update**.

## Backups

- Automatic snapshot when a Claude session ends (COLLAB-19).
- Before every merge or migration, a manual backup goes into `internal-tools/backups/` (e.g. `collab-pre-rnr-s1-20261018.db`).
- Migrations also back the file up themselves before changing it.

## Known traps (the ones that actually bit)

| Trap | What happened | Note |
|---|---|---|
| Old build left running after a merge | it applied a migration the wrong way and the office refused every save; repaired | COLLAB-109 |
| Changing networks (home ↔ office) | the Wi-Fi IP changed, saves were refused and the courier went offline | COLLAB-98. Now: Settings → "The post office moved?" (or `C sync set-address <https://host:port>`); the address is accepted only if your post office's certificate answers there. |
| Windows file locks | closing the database without finalizing the sync add-on leaves the file locked | COLLAB-95 |
| Sync add-on missing on a new machine | migrations ran, then sync failed, leaving a half-made file | COLLAB-68 |
| Certificate generation flake | tests sometimes fail with `ERR_OSSL_ASN1_ILLEGAL_PADDING`; rerun passes (fix branch exists, not merged) | COLLAB-119 |
| 4 golden tests fail in the root suite | known, unrelated; must now count 20 tables | COLLAB-124 |
