# Collab easy setup, piece 2 of 4: `collab join`, teams and safe sharing

Status: design approved in conversation 2026-10-05 (sections A joining, B sharing rules, C courier + move-over), awaiting spec review. Builds on piece 1 (`docs/superpowers/specs/2026-10-05-collab-package-and-doctor-design.md`). Series: (1) package + doctor, (2) this, (3) `collab update`, (4) post office on a server + admin page. Decisions in collab: E-755, E-756, E-757, E-759, E-760, E-761, E-762, E-763; gotcha E-758. Hard rule: no quick fixes; judged by what an outside team adopting collab expects.

## In one paragraph (plain language)

A new person runs `collab join <code>` (or clicks "Join a team" on the web welcome page) and, in one step, gets connected: the code is checked, the post office is verified to be the real one, the notebook for the current folder is chosen, Claude Code is set up for their whole user account, sync starts at login, and the team's notes arrive. A notebook is one collection of modules; it can belong to several teams, and each shared module belongs to exactly one team. Nothing on a laptop is ever sent unless both the team shares that module and the laptop's owner agreed, so an admin can never pull someone's private notes by accident. Note numbers stop colliding: `E-` is always the notebook's own series, numbered on the laptop, and each team numbers its notes with its own code (`ACME-12`). One courier carries every notebook-and-team connection, each in its own loop. NAVEEN and RINKU move over without re-joining.

## Rules this piece must meet

1. Nothing leaves a laptop without both keys: the team shares the module AND this laptop agreed (E-759). Joining never sends a note that existed before the join.
2. A shared module belongs to exactly one team; a note goes where its PRIMARY module goes (existing rule D10); secondary module tags never cause sending.
3. A note number is unambiguous inside a notebook: series + number. Every existing `E-` reference stays valid forever.
4. Private notes never wait for a post office (relaxes E-708 for private notes only).
5. Joining is all-or-nothing: a failed join leaves no half-joined state, and the one-time key is spent only after every other check passed.
6. The join code carries the certificate fingerprint; a post office whose certificate doesn't match is never trusted (no trust-on-first-use).
7. One post office being down never slows or blocks another connection.
8. Piece 1 rules still hold (code/data separation, which-notebook rules, doctor explains everything, nothing silent).

## Decisions

| # | Decision | Why |
|---|---|---|
| J1 | Join code v2: `collab2-<label>-<payload>`, payload = base64url JSON `{ u: url, f: fingerprint, d: device, s: secret, t: team code, n: team name }`; `<label>` = team code lowercased, for humans only (the payload is authoritative). One use, 7 days (unchanged). `collab1-` codes still parse (team code then comes from the post office on first contact) | E-756: one self-contained code keeps the pin; readable label |
| J2 | `collab join <code> [--notebook <name> \| --new-notebook <name>]` joins the notebook of the current folder by piece 1's rules, printing which and why; with no notebook anywhere it creates one named after the team code | E-760: umbrella or per-project, the person's choice via `.collab` |
| J3 | Join steps in order: check code → connect + compare certificate → choose notebook → check team code is free in this notebook → list overlaps → register Claude Code (user scope) → redeem the key + add courier line + start courier with login start → wait for first delivery. Any failure undoes earlier steps; the key is redeemed only at the second-to-last step | Rule 5 |
| J4 | Claude Code registration: `claude mcp add --scope user collab -- collab mcp`, skipped when an equivalent entry exists; when `claude` isn't on PATH, print the exact JSON to add and continue | E-755 |
| J5 | Web setup mode: `collab web` with no notebook serves only a welcome page (Join a team / Start a new notebook / Use an existing file) and the join checklist; one core `joinTeam()` serves the page and the command | E-762; relaxes piece 1 P12 for the web server only |
| J6 | Two keys. Key 1 = the team's shared list (post office, as today). Key 2 = a per-laptop, never-synced consent table. Key 2 is set automatically only for a module that arrives from the team while this notebook has no own notes in it; otherwise by `collab share <module> --team <code>` or the web UI toggle; removed by `collab unshare <module>` | E-759, fixes E-758 |
| J7 | A module's team is recorded with key 2 and is fixed: a module bound to team A is never sent to team B. A same-slug module shared by a second team is not mixed in; collab warns and suggests `collab module rename` | E-760 |
| J8 | Note numbers carry a series. `E` = this notebook's own series, allocated on the laptop. Each team has a fixed code of 2-8 uppercase letters/digits, chosen once when the team is created (today's team: at upgrade), never changed; its post office allocates `<CODE>-n` for notes in its modules. Bare `760` / `#760` = `E-00760`. Two teams with the same code can't join one notebook | E-760/E-763: collisions impossible, not unlikely; habits unchanged |
| J9 | Overlaps at join (own notes in a module the team shares) are listed, held back by key 2, reminded in the sync bar; `collab module rename <old> <new>` keeps them apart; `collab share <module> --team <code>` adds them to the team after a confirmation (renumber + alias, J16-J18) | E-761: never auto-merge; aliases (option a) brought "add mine" into this piece |
| J10 | One courier, a list of connections `{ notebook, team }`, each with its own loop, retry timers, event stream and bookmarks; status per connection; one autostart entry | E-757 |
| J11 | Per-team sync settings: today's single set in `sync_state` (post office URL, fingerprint, device, key, bookmarks, shared list, backfilled list) moves into a per-team local table | Several teams per notebook |
| J12 | Migration 0009: `entries.series TEXT` via the 0008 CRR-alter path (`crsql_begin_alter`/`commit_alter` in one transaction), existing rows `'E'`; plus the local (non-CRR) tables of J6, J11 and J16 (`entry_aliases`); the existing `sync_state` values move into the team table as the first team | Same proven path as 0008 |
| J13 | `collab leave --team <code>`: stops and removes that connection, clears key 2 for its modules, keeps every note, and asks before telling the post office to retire the device | Included (approved in section C) |
| J14 | Move-over for existing setups: the post office asks for its team code once (`collab office set-team-code <CODE>`, refused if already set); each laptop's current courier config + `sync_state` become connection 1; key 2 is set for the modules that laptop already shares; no re-join | Section C |
| J15 | Three spikes before building anything else: S1 Claude Code starts a user-scope MCP server with cwd = the project folder (else use the project path Claude Code provides); S2 one notebook exchanging changes with two post offices through cr-sqlite with per-module filtering; S3 migration 0009 alter on a shared notebook replicates `series` | Each assumption is cheap to test and expensive to discover late |

## Components

### Core

- `core/src/sync/joincode.ts`: v2 format and parser (J1); `parseJoinCode` keeps v1.
- `core/src/sync/teams.ts`: the per-team local table (J11): `listTeams(db)`, `getTeam(db, code)`, `addTeam(db, team)`, `removeTeam(db, code)`; replaces the single-set getters used by the courier and allocator.
- `core/src/sync/consent.ts`: key 2 (J6/J7): `consentOf(db, module)`, `grant(db, module, team, how)`, `revoke(db, module)`, `overlaps(db, sharedModules)` (modules the team shares where this notebook has own notes and no consent).
- Series-aware numbering (J8):
  - Local allocator for `E`: next = max(id where series = 'E') + 1, inside the write transaction.
  - The post office allocator returns `{ series, id }`; a note's series is the series of the team its primary module belongs to, else `E`.
  - `parseEntryRef` returns `{ series, id }` (bare = `E`); `formatEntryRef(series, id)`. Every caller that takes a note number (MCP tools, REST routes, `/merge/:id`, refs, ownerOf) resolves by `(series, id)`. The plan inventories every call site first; this is the widest change in the piece.
- `core/src/join.ts`: `joinTeam(code, opts, onStep)` implementing J3 with undo; `leaveTeam` (J13). Used by the CLI and the web server.

### Post office

- Team code + name in `po_meta`; `collab office init --team-code <CODE> --team-name "<name>"`; `collab office set-team-code` for existing offices (J14).
- `/v1/allocate` returns `{ series, id }`.
- `collab office invite "<member>"` prints a v2 code (`add-member` stays as an alias).

### Courier

- Config becomes `{ connections: [{ notebook, dbPath, team }] }` in the existing courier folder; the old single config is read as one connection (J14).
- One loop per connection; push filter = own changes whose primary module is bound to this connection's team with key 2; pull = only that team's modules; auto-grant key 2 on first arrival of a module with no own notes (J6).
- Status file per connection; `collab sync status` prints the table (notebook, team, post office, state, unsent, held back).

### CLI

- `collab join`, `collab leave`, `collab share <module> --team <code>`, `collab unshare <module>`, `collab module rename <old> <new>` (renames the slug on own notes; refused for a module bound to a team, since that would change what teammates see; that case is a team-level rename, out of scope).
- `collab office invite`, `collab office set-team-code`.

### Web UI

- Setup mode + welcome page + join checklist (J5).
- Module list: per module "private" / "shared with <TEAM>" / "the team shares this; N of your notes held back" with share/unshare toggles (key 2).
- Sync bar: one line per connection when there's more than one; held-back reminders (J9).

### Doctor (extends piece 1)

- Sync group per connection; a check for overlaps waiting on a decision (!); a check that every shared module has exactly one team (✗ if not); team code clash (✗).

## Failure behaviour

| Situation | What happens |
|---|---|
| Code damaged, expired or already used | Stop at step 1 with the reason; nothing created |
| Certificate doesn't match the code | Stop: "This isn't the real <team> post office. Don't continue; ask your admin." Nothing created |
| Post office unreachable during join | Stop with the address tried; nothing created; the code stays valid |
| Team code already used in this notebook | Stop; suggest `--new-notebook` |
| `claude` CLI missing | Print the JSON to add by hand; join continues |
| Courier fails to start after the key was redeemed | Connection stays configured; doctor ✗ with `collab sync start`; the join reports "joined, but sync isn't running yet" (the key is spent, so this is not undone) |
| A module is shared by the team but bound to another team here | Not mixed; warning with a rename suggestion |
| Admin unshares a module | Sending stops; local notes stay; sync bar says so |
| One post office down | Only its connection goes offline; others unaffected |
| A note links to a private note | The link travels; teammates see "not shared with you" instead of a broken reference |
| Post office upgraded to J8 before a laptop | Schema guard (part 2) pauses that laptop's connection with "update this laptop" |

## Testing ("done" = all pass)

- Spikes S1-S3 first, each with a written verdict.
- Unit: join code v1/v2 parse + damage; every J3 step's failure undoes the earlier ones; key 2 rules (auto-grant only with no own notes; overlap listing; one team per module); series allocation (local `E`, post office codes; no collision across two teams in one notebook); `parseEntryRef`/`formatEntryRef` round trips including bare numbers.
- Two-post-office test: one notebook, teams A and B, modules bound to each; A's notes never reach B and the reverse; A down doesn't delay B.
- Aliases: sharing a module with own `E-` notes renumbers them into the team; `E-729` still opens the same note on the author's laptop; a teammate holding their own private `E-729` sees no clash; links point at the same notes after renumbering; the upgrade converts today's two shared `E-` notes on the post office and on both laptops.
- The E-758 regression: an admin sharing a slug that matches a member's private module sends nothing.
- Move-over: a 0008 notebook with today's `sync_state` and courier config upgrades to one connection with the same bookmarks and no re-join; `portfolio` stays shared.
- Web: setup mode starts without a notebook; the join checklist reflects each step; module toggles turn key 2.
- By hand on NAVEEN + RINKU: upgrade (post office first), set the team code, confirm portfolio still syncs; create a second post office on NAVEEN (a test team), join it from RINKU into a new notebook, then into the existing notebook, and check isolation.

## Not in this piece

- Renaming a team-bound module across a team.
- `collab update` and laptops-follow-the-office (piece 3). Until then, upgrades follow the manual order with the schema guard as the safety net.
- Admin web page, post office on a server, invite web page (piece 4).

## Aliases: how an `E-` note enters a team (user chose option a, 2026-10-05)

Found while writing this spec: an `E-` number means "this notebook's own" and would collide with a teammate's own `E-` numbers if an `E-` note entered a team. Three paths do that: today's team already holds `E-00729`/`E-00730`; `collab share` on a module that already has own notes; starting a team from an existing notebook (`--upload-existing`).

| # | Decision |
|---|---|
| J16 | A note only ever enters a team carrying that team's number. When an `E-` note enters a team (sharing a module that has own notes, starting a team from a notebook, or the upgrade of today's team), it gets the next team number and its old `E-` number is kept as an **alias** in a per-laptop, never-synced table `entry_aliases (series, id, ulid)`. Looking up `E-729` checks live numbers first, then aliases, so every old reference on that laptop keeps working. Teammates only ever see the team number. |
| J17 | Links between notes resolve by the target's ULID, never by its number. Numbers are display only, so links survive renumbering and mean the same thing on every laptop. Free-text mentions inside a note body ("see E-729") are not rewritten; on the author's laptop they still resolve through the alias. |
| J18 | With J16, "add my old notes to the team" (E-761's later item) moves into piece 2: `collab share <module> --team <code>` on a module with own notes lists them, asks for confirmation, then renumbers them into the team with aliases and sends them. Starting a team from a notebook (`--upload-existing`) uses the same path. |
| J19 | Upgrade of today's team: the notes already shared under `E-` (portfolio: E-00729, E-00730) are renumbered into today's team code with aliases, on the post office first, then on every laptop as the change arrives, so no member can ever hold two notes called `E-729`. |

## Risks and open items

- Series-aware note numbers touch every place that takes an E-number (MCP tools, REST, UI routes, refs, hub links, golden tests). The plan must inventory call sites before changing `parseEntryRef`'s shape, and keep bare numbers working everywhere.
- Private notes numbered by the post office in the `E` series before the upgrade keep those numbers. From the upgrade on, each laptop's local `E` counter starts above the highest `E` number it holds (including aliases), so no new local number can repeat one.
- J17 assumes links are stored by ULID. The plan must check how refs are stored today (0005/0006 resolved entry refs) and convert any number-based link before renumbering touches anything.
- S2 (two post offices through cr-sqlite) is untested; if per-module filtering can't keep a team's changes out of another team's exchange, the fallback is one notebook per team (piece 1's model) and this spec's umbrella style is revisited with the user before building.
- The team code for today's team must be chosen by the user at upgrade (suggested: `NV`).
