# 7. Running it: your do-it-yourself runbook

Everything here you can do yourself, without Claude. Updated 2026-10-26.

## 0. The `collab` command

`collab` works in any folder, in PowerShell, cmd or Git Bash. It always uses **your** notebook: `naveen` = `internal-tools\mcp\collab.db`.

- Check: `collab notebook which` should print `naveen (the default notebook): ...\mcp\collab.db`.
- How it's wired: `%APPDATA%\npm\collab.cmd` (and `collab` for Git Bash) runs `node ...\internal-tools\cli\dist\bin.js`. That's the same code your MCP and courier run.
- If `collab` is ever "not recognised", use the long form, which always works:
  ```
  node C:\Users\NaveenPrajapati\Downloads\dev\frontend2\internal-tools\cli\dist\bin.js <same arguments>
  ```
- **Don't** `npm install -g` the collab package on this laptop. That would replace the command with a second copy of the code. (On other people's laptops, `npm install -g` is exactly right.)

## 1. Everyday checks

| What | Command |
|---|---|
| Is sync working? | `collab sync status`. Want **last state: connected** |
| Is everything set up right? (explains each problem + the fix) | `collab doctor` |
| Who is in a team project | `collab team list <CODE>` (e.g. `collab team list TT`) |
| Which modules are linked to which project | `collab project list` |
| Changes the office refused | `collab refused list` |
| Web UI (Team, Projects, Settings, Health pages) | `collab web`, then open `http://127.0.0.1:7473` |

## 2. People (you are **Office admin**, so you do all of this from your laptop)

| What | Command |
|---|---|
| Add a person: prints their **join code** (valid 7 days, treat it like a password) | `collab team invite "Gaurav"` |
| Put them in a team project with a role | `collab team set "Gaurav" EMP Editor` |
| Take them out of one project | `collab team remove "Gaurav" EMP` |
| Their role in the whole office | `collab team office-role "Gaurav" "Office member"` |
| Cut a person off completely (every request refused from then on) | `collab team revoke "Gaurav"` |

**Project roles:**

| Role | Can do |
|---|---|
| Contributor | read, write, edit **own** notes |
| Editor | everything a Contributor can, plus edit anyone's notes, supersede, archive, tasks, resolve merges |
| Owner | everything an Editor can, plus invite/revoke, roles, rename/delete the project |

The web Team page does the same things with buttons.

## 3. Sharing: by project

Every note is in a project. A project is shared with chosen people, or it is private. Modules are tags inside a project. **E** is the emp1st project; old E numbers stay.

| What | Command |
|---|---|
| New shared project | `collab project create "Custom Reports" --code CR --team` |
| Make a private project shared (notes keep their numbers) | `collab project promote CR` |
| Make a module's new notes land in a project | `collab project bind custom-reports CR` |
| Give someone access | `collab team set "<member>" CR Editor` |
| Change where a note goes when nothing says | `collab project default <CODE>` |

Where a new note goes, in order: the project you named, the module's linked project, the folder's project, then PS (your private project). The AI tells you where each note went.

Sharing a module on its own is gone after the switch (section 10). `collab sync share` now says: "modules follow their project now: collab project bind <module> <CODE>". Before the switch it still works, and the switch steps use it once.

A teammate who tags a note with a new module can create it. Only that project's members see it. Someone who is taken out of a project stops receiving it and keeps the copies they already have.

## 4. Bringing a new person in

1. `collab team invite "<name>"` gives you the join code. Then `collab team set "<name>" <CODE> Editor` for each project they need.
2. Make the package: in `internal-tools`, run `npm run build`, then `npm run package`. That gives `internal-tools\dist-package\collab-mcp-collab-0.1.0.tgz`.
3. Send them the `.tgz`, the join code, and this message for their AI:
   > Install collab and join my team. Use **Node.js 22 or 24**.
   > `npm install -g <full path to collab-mcp-collab-0.1.0.tgz>`
   > `collab notebook new <your-name>`
   > `claude mcp add --scope user collab -- collab mcp` (then /mcp → Reconnect)
   > `collab sync setup <join code> --autostart` (starts sync at every login), then `collab sync start`, then `collab sync status` (should say connected).
   > Work notes: put them in E or in the team project you were given (e.g. `project: "E"`). Notes in your private projects never leave your laptop.
   > If `collab` doesn't run in PowerShell, use `collab.cmd`.
4. Check: `collab team list <CODE>` shows them with a "last seen" time.

## 5. The post office (Oracle VM)

| | |
|---|---|
| Address | `https://168.138.114.191:7443` |
| Log in | `ssh -i C:\Users\NaveenPrajapati\Downloads\dev\frontend2\.ssh\orcale-collab.key ubuntu@168.138.114.191` |
| Is it running? | `systemctl status collab-office` |
| Its log (refusals are logged too) | `sudo journalctl -u collab-office -n 50` |
| Restart | `sudo systemctl restart collab-office` |
| Office status (members, deliveries) | `sudo -u collab collab office status --data /var/lib/collab/office` |
| Any office command on the VM | `sudo -u collab collab office <command> --data /var/lib/collab/office` |

It restarts by itself if it crashes and starts when the VM boots.

**Updating the office's code:**
1. Build the package (section 4, step 2).
2. `scp -i <key> internal-tools\dist-package\collab-mcp-collab-0.1.0.tgz ubuntu@168.138.114.191:/tmp/`
3. On the VM: `sudo npm install -g /tmp/collab-mcp-collab-0.1.0.tgz`, then `sudo systemctl restart collab-office`.

## 6. Backups

| What | Where | When | Kept |
|---|---|---|---|
| Office (store + certificate + key) | VM `/var/lib/collab/backups/` | nightly 02:00 IST (`collab-office-backup.timer`) | 7 |
| Copy of the office backup | `%LOCALAPPDATA%\collab\backups\office\` | daily 12:00 + at login (task `CollabBackup`) | 14 |
| Your whole notebook (private notes too) | `%LOCALAPPDATA%\collab\backups\notebook\` | same task | 14 |

- Log: `%LOCALAPPDATA%\collab\backups\backup.log`
- Run it now: `powershell -ExecutionPolicy Bypass -File %LOCALAPPDATA%\collab\backup-job\collab-backup.ps1`
- Google Drive mirror (notebook only, never the office key): install Google Drive for desktop, then add `-DriveDir "G:\My Drive\collab-backups"` to the task's arguments.

**Restore your notebook:**
1. Close Claude sessions and run `collab sync stop`.
2. Copy the newest `notebook-*.db` over `internal-tools\mcp\collab.db`, after keeping the broken one aside.
3. `collab sync start`. Shared notes newer than the backup come back from the office automatically.

**Restore the office:**
1. On the VM (or any new Linux box set up the same way): `sudo systemctl stop collab-office`.
2. Unpack an `office-*.tgz` into `/var/lib/collab/office/` and run `sudo chown -R collab:collab /var/lib/collab/office`.
3. `sudo systemctl start collab-office`.

The certificate is inside the backup, so **nobody has to rejoin**. If the address changed, run `collab sync set-address https://<new>:7443` on every laptop.

## 7. Moving the office (e.g. to the company server later)

Full steps: `post-office/DEPLOY.md`. Short version:
1. Stop it.
2. `collab office bundle office.tgz --url https://<new address>:7443 --data <its data dir>`
3. Copy it to the new machine, unpack, serve it (section 5).
4. Every laptop: `collab sync set-address https://<new address>:7443`.
5. **Never start the old one again.** Two offices hand out the same numbers twice.

## 8. When the code changes (upgrades)

1. Back up: run the backup task now.
2. Merge, then rebuild **everything in the same step**: `npm run build` in `internal-tools`.
3. Update the office (section 5).
4. Reconnect the collab MCP in Claude (`/mcp` → collab → Reconnect). This migrates your notebook.
5. `collab sync stop` + `collab sync start`, then `collab sync status` → connected.
6. If the upgrade has a **migration**, everyone must update the same day. Until they do, their courier shows **needs-update** and the office refuses them.

## 9. Troubleshooting

| You see | Do |
|---|---|
| `collab sync status` → **offline** | Is the office up? (section 5, or your UptimeRobot alert). Then `collab sync stop` + `collab sync start`. |
| **needs-update** | That laptop is on older code than the office: update it (section 8). |
| "N change(s) refused by the post office" | `collab refused list`, then keep one in a private project (`collab refused copy <id> --to <CODE>`) or drop it (`collab refused delete <id>`). |
| A teammate doesn't get a project's notes | Check `collab team list <CODE>`, then their courier: `collab sync stop` + `collab sync start` on their laptop. |
| A teammate's sync dies after a reboot | `collab sync autostart on` on their laptop. |
| Install tries to compile / needs Visual Studio | No prebuilt database driver for that Node (odd-numbered or brand-new Node): use Node 22 or 24. |
| `EBUSY` / file locked on Windows | Close extra Claude/IDE windows using collab, then retry. |
| Notes stuck as "pending" | The office was unreachable. They're safe; they get numbers once `collab sync status` says connected. |

## 10. The E switch

One-time move from "modules shared with everyone" to "E is a project". Do it with Claude, in this order. Do not skip ahead: old numbers can only reach the office before the switch.

| # | Where | Do |
|---|---|---|
| 1 | laptop | Run the backup job (section 6). |
| 2 | laptop | Claude does these with you: delete the junk notes: E-13, E-14, E-178, E-179, E-191, E-192, E-193, E-209, E-824. |
| 3 | laptop | Claude does these with you: retag E-26 to `custom-reports`; E-532 to `timesheet`; E-377, 378, 379, 380, 407, 408, 409, 508 to a new module `infra`; the `supportHub` note to `supporthub`. Then `collab sync share infra` so these old notes reach the office now. |
| 4 | laptop | Make the private project: `collab project create "QA" --code QA`. Then, for each of workspace-redesign, internal-tools, workspace-mvp, dependency-audit, collab, collab-infra: `collab copy --from <module> --to COLLAB --yes`. Finally `collab copy --from qa-system --to QA --yes`. |
| 5 | laptop | `collab sync status` must say **connected** with nothing waiting. |
| 6 | the VM | `sudo -u collab collab office adopt-e --owner personal-laptop --data /var/lib/collab/office` |
| 7 | laptop | It switches by itself on the next sync. To watch it: `collab project adopt-e --default PS`. `infra` is linked to E automatically because step 3 shared it. |
| 8 | laptop | `collab team list E`. Read who is in it. When Gaurav joins: `collab team set "Gaurav" E Editor`. |
| 9 | laptop | `collab sync status`: connected, and a line "N private E notes kept on this laptop". |

**What you will see**
- After step 6, E reaches only E's members, and you are E's Owner.
- A laptop with notes not yet sent says "sync first" and tries again by itself.
- Notes that never reached the office stay private on that laptop (the line in step 9).
- Modules that used to be shared are linked to E.
- Teammates' laptops switch by themselves on their next sync. Nothing for them to do.
- E cannot be renamed, made private, or left like other projects.

## Known traps (the ones that actually bit)

| Trap | What happened | Note |
|---|---|---|
| Old build left running after a merge | it applied a migration the wrong way and the office refused every save; repaired | COLLAB-109 |
| Office on a laptop | it silently went down; all team saves waited. Fixed by the move to the VM | COLLAB-203 |
| One bad note blocks a whole upload | E-261 failed a database rule; fixed | COLLAB-205 |
| Oracle firewall | port 7443 must be opened in **both** the Oracle Security List and Ubuntu's iptables | COLLAB-203 |
| Ubuntu minimal has no `unzip` | the sync add-on install only warns; run `sudo apt install unzip`, then reinstall | COLLAB-203 |
| systemd `ProtectSystem=strict` | SQLite needs `/tmp`, so the service has `PrivateTmp=true` | COLLAB-205 |
| Windows file locks | closing the database without finalizing the sync add-on leaves the file locked | COLLAB-95 |
| Stray empty `collab.db` in `internal-tools/` | the CLI opened it instead of your notebook. Renamed `collab.db.stray-empty-2026-10-02`; the default notebook is now registered | 2026-10-25 |
