# Collab easy setup, piece 1 of 4: One package, a home for notebooks, and `collab doctor`

Status: design approved in conversation 2026-10-05 (section A: package + notebook home + notebook choice + adopt; section B: doctor), awaiting spec review. Series (approved 2026-10-04, collab E-749..E-752): (1) this, (2) `collab join`, (3) `collab update`, (4) post office on a server + admin page. Hard rule from the user: no quick fixes; every choice is judged by what an outside team adopting collab would expect.

## In one paragraph (plain language)

Today collab is a repo you clone, build and run by file path, and your notes live inside the code folder. After this piece, collab installs like any developer tool (`npm install -g`), arrives already built, downloads the right sync add-on for the computer and checks it, and gives one command, `collab`, for everything. Notes live in their own folder in the user's profile, one folder per team, with a clear rule for which notebook each project uses. Your current notebook keeps working where it is. A new `collab doctor` checks the whole machine (install, notebook, versions, running programs, sync, Claude Code, notes), says in plain words what is wrong and gives the exact fix. Programs that can't work refuse to start with that same message instead of half-working.

## The target this series is measured against (E-749)

A developer who has never seen collab, on a fresh Windows laptop, on a different network from the post office, can see and search the team's notes in 10 minutes or less, with 3 commands or fewer, without reading code or asking anyone. Afterwards every update is 1 command per machine and the order of machines doesn't matter to them. Piece 1 delivers the install half of this and the diagnosis that makes the rest debuggable; pieces 2 to 4 finish it.

## Rules this piece must meet

1. Code and notes are separate: an install, update or uninstall never touches a notebook file.
2. Nothing resolves a notebook inside the install folder (E-550). A missing notebook is never created empty (E-689).
3. Every program can say which notebook it opened and why.
4. Everything that works today keeps working on day one: `COLLAB_DB_PATH`, the current `.mcp.json`, Codex runs, the courier's config, the existing `mcp/collab.db`.
5. Every problem collab detects is reported as a plain sentence plus the exact fix. Never an error code alone.
6. Automatic repairs never touch notebook data.
7. Mac and Linux follow the same layout with their usual folders, as the courier already does (`courier/src/paths.ts` pattern, now in `core/src/sync/courier-paths.ts`).

## Decisions

| # | Decision | Why |
|---|---|---|
| P1 | One installable package with one command `collab` and subcommands: `sync` (today's courier CLI, unchanged), `mcp`, `web`, `office` (today's `collab-post-office`), `notebook`, `doctor` | One thing to install and one name to remember. Claude Code runs `collab mcp`, not a file path inside a repo, so it works from any project and survives updates |
| P2 | Ships prebuilt, web UI included. The 6 workspaces stay as the source layout; the package is assembled from their `dist` | No `npm run build` on a user's machine: removes a step and the "forgot to rebuild" failure |
| P3 | The cr-sqlite add-on is downloaded at install for the machine's OS and CPU, from a version pinned in the package (today `v0.16.3`), and checked against a SHA-256 stored in the package before it is ever loaded | It can't ship in one cross-platform package. Pinning = always the tested version; the hash = a damaged or tampered file is refused |
| P4 | Install without internet does not fail the install. The add-on is marked missing; `collab doctor` reports it and `collab doctor --fix` fetches it | A partial install that explains itself beats a failed install with a stack trace |
| P5 | Each notebook has a folder in the user data folder, keyed by its NAME: `%LOCALAPPDATA%\collab\notebooks\<name>\` (Mac `~/Library/Application Support/collab/…`, Linux `$XDG_DATA_HOME` or `~/.local/share/collab/…`). New notebooks keep their `notebook.db` there. The folder also holds that notebook's runtime files (`running/` heartbeats, `backups/`) **wherever its `.db` file lives**, including an adopted file elsewhere (P8) | Notes separate from code (rule 1). Runtime files never land next to an adopted file inside a repo (where git would see them) |
| P6 | `config.json` in the collab data folder lists notebooks by name (name → path) and names a default | Several teams per laptop (E-752). A list of paths lets old notebooks stay where they are (P8) |
| P7 | Which notebook, first match wins: (1) `--notebook <name>`; (2) `COLLAB_DB_PATH`; (3) the NEAREST `.collab` file, in the working folder or else the closest parent, naming the notebook; (4) `./collab.db` only if it already exists; (5) the default in `config.json`; (6) none: stop and list the notebooks with how to choose. When (2) is set AND a `.collab` resolves to a different notebook, the program logs both on start and doctor reports ✗ | (1) explicit wins; (2) and (4) keep today's setups working; (3) is how a project picks its team, and nearest wins because projects nest (`ingxt-supportHub/` sits inside `frontend2/`); (5) means zero setup for one-team users; (6) keeps E-689. The env/`.collab` clash is E-550's failure shape (an env var in a user-scope MCP config silently overriding every project), so it is never silent |
| P8 | `collab notebook adopt <path> --name <name>` registers an existing file in place; it never moves it | The live notebook is open in the MCP, courier and web server; moving an open database risks corruption. A later, separate move command may stop everything, copy, verify and switch |
| P9 | Each long-running program (MCP, courier, web server) writes a heartbeat file in its notebook's data folder (P5): `running/<program>-<pid>.json` = `{ program, version, build, pid, startedAt, beatAt }`, refreshed every 30 s, deleted on clean exit. `build` is a build identity written into the package at assembly (build time + content hash of the built code); doctor compares `build`, not just `version` | Today nothing can tell from outside which code a running program has loaded. The real failure was rebuilds WITHOUT a version bump (every workspace is 0.1.0), so semver alone can't catch it; the build identity can |
| P10 | `collab doctor` = 7 check groups in dependency order (below). Output: ✓ fine, ! worth knowing, ✗ broken; every ! and ✗ carries a plain sentence and the exact fix. Exit code 0 fine, 1 warnings, 2 broken. `--json` gives the same report as data | One set of checks. The web UI Health page and the MCP `collab_doctor` tool render the same JSON, so the three never disagree |
| P11 | `--fix` only does repairs that can't lose data and can be undone: fetch the add-on, start the courier or web server, remove heartbeat files whose process is gone. Migrations, adopting, re-indexing: printed as commands, never run | A tool that rewrites notes because a check failed is the silent surprise this piece removes |
| P12 | Fail loudly at start: the MCP, courier and web server run the install + notebook checks when they start. The courier and web server refuse to start on a ✗, printing the doctor sentence. The MCP does NOT exit: it starts in a degraded mode where every tool call returns the doctor sentence and fix (and `collab_doctor` works), because Claude Code shows an exited server only as "failed" and its stderr is never read. Each program logs "opened <name> (from <rule>)" as its first line | Problems surface when they happen, in a place the person actually sees, not after hours of confusing behaviour |
| P14 | Settings and secrets for `collab web` (port, Groq key/model/URL, AI limits) move from the repo's `.env` to a user-data settings file: `%LOCALAPPDATA%\collab\settings.env` (same folder rule as P5), never package-relative. Environment variables still override it. The repo `.env` keeps working for a repo checkout | The package never ships `.env` (deny list), so an installed `collab web` would otherwise have no port and no AI key. Package-relative settings would repeat E-550 (shared by every project using that install) |
| P13 | The current `scripts/bundle.mjs` (source zip of core + mcp for a friend to build) is retired once the package works | Two ways to install = two ways to drift. The package is the one supported way |

## Components

### The package

- A new workspace `cli/` holds the `collab` entry point. It routes subcommands to the existing code: `sync` → courier CLI, `office` → post-office CLI, `mcp` → MCP server start, `web` → web server start (serving the built UI). `notebook` and `doctor` are new and live in `cli/` over core.
- An assembly script builds every workspace and writes one publishable package (prebuilt `dist` for core, courier, post-office, mcp, server; built `ui/dist`; migrations; the add-on manifest). It replaces `scripts/bundle.mjs` (P13). Its deny list carries over: never `collab.db*`, `.env`, `node_modules`, backups.
- Add-on manifest: `{ version, files: { "win32-x64": { url, sha256 }, "darwin-arm64": …, … } }`. A postinstall step downloads, checks the hash, unpacks into the package's own `vendor/crsqlite/`. `core/src/sync/extension.ts` keeps loading from there (package-relative is correct for code: "code belongs to the install; data belongs to the project", `core/src/db.ts`).
- The package name on npm is open (O1). Until the public-release scrub is done (E-752), the same package installs from a private GitHub release; nothing else changes.

### Notebook home and choice (core)

- `core/src/notebooks.ts`: data folder per OS; read/write `config.json` (atomic write: temp file + rename); `listNotebooks`, `addNotebook(name, path)`, `defaultNotebook`, `setDefault`. Names follow the module slug rule (lowercase, digits, hyphen).
- `resolveDbPath` grows from 3 rules to the 6 in P7 and returns `{ path, source, name? }`, with `source` one of `argument | COLLAB_DB_PATH | collab-file | cwd-existing | default`. The `.collab` file is one line `notebook = <name>` (comments with `#`). Walking up stops at the filesystem root. A `.collab` naming an unknown notebook is an error with the list of known names, never a fall-through to the default (a typo must not silently write to another team).
- `MissingDatabaseError` stays. Its message adds which rule chose the path and the `collab notebook` commands that fix it.

### `collab notebook`

- `list`: name, path, default marker, migration, size.
- `adopt <path> --name <name>`: file must exist and open as a collab notebook (has `schema_migrations`); refuses a duplicate name or path; never moves the file.
- `new <name>`: creates `notebooks/<name>/notebook.db`, migrates it (the one place a new empty notebook is created on purpose).
- `default <name>`.
- `which`: prints the notebook this folder resolves to and the rule that chose it.
- `reindex`: rebuilds the search index for the notebook (the fix doctor check 7 prints; never run automatically, P11).
- A notebook opened through `COLLAB_DB_PATH` or `./collab.db` without being in `config.json` has no name, so its runtime files go under a name derived from a hash of its absolute path (`notebooks/_path-<hash>/`), and doctor suggests `adopt` (!).

### Heartbeat files (core)

- `core/src/heartbeat.ts`: `startHeartbeat(notebookDataDir(name), program, version, build)` (the data folder from P5, never the folder of an adopted `.db`) writes on start, refreshes every 30 s, deletes on exit (normal exit, SIGINT/SIGTERM; on Windows also the Ctrl+C/console-close path). A crash leaves a file behind; doctor detects it (pid gone or `beatAt` older than 90 s) and `--fix` removes it.
- Used by the MCP server, the courier (`sync run`) and the web server.

### `collab doctor` checks

| # | Group | Checks | A ✗ looks like |
|---|---|---|---|
| 1 | Install | Node version within `engines`; the SQLite driver (better-sqlite3, a native module) loads; add-on present, hash matches the manifest, loads into SQLite | "Sync add-on missing. fix: `collab doctor --fix`" / "The database driver was built for a different Node version. fix: `npm rebuild -g <package>` or reinstall collab" |
| 2 | Notebook | Which notebook and which rule chose it; file exists and is writable; path not inside the install folder; `COLLAB_DB_PATH` and a `.collab` not pointing at different notebooks (P7) | "No notebook for this folder. You have: emp1st, supporthub. fix: `collab notebook default emp1st` or add a `.collab` file" |
| 3 | Version | Notebook migration vs the migrations in this install (behind = needs `collab update`'s migrate step; ahead = installed code is older than the notebook); with sharing on, vs the post office (equal, or behind and waiting; the rule from the series design: a laptop never migrates past the post office) | "This notebook is on 0009 but this install only knows up to 0008. fix: update collab" |
| 4 | Programs | From heartbeat files: MCP, courier, web server running or not, their build identity vs the installed one (P9), stale files | "The MCP is running older code than is installed (built 14:02, installed build 18:40). fix: type /mcp in Claude Code and reconnect collab" |
| 5 | Sync (sharing on only) | Post office reachable; certificate fingerprint equals the pinned one; courier state (connected / offline / needs-update / revoked) and unsent count, reusing `readSyncOverview` | "The post office's certificate changed. Do not continue: ask your admin before re-joining" |
| 6 | Claude Code | collab is registered (user or project MCP config) and the entry runs `collab mcp`; an entry pointing at a repo file path is a ! with the replacement line | "! Claude Code runs collab from a file path. fix: replace it with `collab mcp`" |
| 7 | Notes | The existing `doctor(db)` checks unchanged, plus: every live note is in the search index (E-643) | "12 notes are missing from search. fix: `collab notebook reindex`" |

A group whose prerequisite failed is shown as "skipped: needs <group>", never as a pass.

### Where the report shows

- Terminal: `collab doctor`.
- Web UI: the existing Health page (`ui/src/pages/Health.tsx`) renders `/api/doctor` (the same JSON). The part 2 sync bar gains a "check setup" link to it.
- MCP: `collab_doctor` returns the same report as text.

## Failure behaviour

| Situation | What happens |
|---|---|
| Install without internet | Install succeeds; add-on marked missing; the MCP starts degraded and every tool returns the fix sentence (P12); `doctor --fix` fetches it |
| No prebuilt SQLite driver for this Node version | npm falls back to compiling, which needs Python + C++ build tools that a fresh Windows laptop lacks. The README and the install output name the supported Node versions up front; the package's `engines` range only lists Node versions with prebuilt drivers, so npm warns before compiling |
| Node upgraded after install | The driver fails to load (wrong Node ABI); every program and doctor report check 1 ✗ with the rebuild/reinstall fix instead of a stack trace |
| Downloaded add-on hash mismatch | File deleted, not loaded; doctor ✗ "the download was damaged or altered"; `--fix` retries once from the pinned URL |
| Unsupported OS/CPU | Install succeeds; doctor ✗ names the platform; sync can't be used, a local notebook still works only if the add-on isn't required (no CRR tables) |
| `.collab` names an unknown notebook | Error listing known names; no fall-through |
| `config.json` unreadable or invalid | Commands that need it stop with the file path and the problem; never rewritten automatically; `COLLAB_DB_PATH` still works |
| Two names, same path | `adopt` refuses |
| Heartbeat folder not writable | The program still runs; doctor reports "can't see running programs" as a ! |
| Doctor itself throws in one check | That check is ✗ "doctor could not run this check: <message>"; the others still run |

## Testing ("done" = all pass)

- Unit: notebook choice, every rule and every tie (including `COLLAB_DB_PATH` + `.collab` pointing at different notebooks → logged + doctor ✗, nested `.collab` files → nearest wins, an unknown name, walking up to the root, `./collab.db` absent); an adopted notebook's heartbeats and backups land in the data folder, never next to the file; MCP degraded mode returns the fix sentence from every tool; settings file read with env override; config atomic write; adopt refusals; heartbeat stale detection; each doctor check with a pass and a failure fixture; `--json` shape; exit codes.
- Add-on: hash mismatch refused; missing add-on → MCP start refused with the fix sentence (bug #2, E-740, as a regression test).
- Package: the assembled package installs into an empty folder with no repo present, `collab --version` runs, `collab notebook new t` + `collab mcp` start against it, the UI is served by `collab web`. Run on Windows (the user's machines) and in CI on Linux.
- Back-compat: today's `.mcp.json` (`node internal-tools/mcp/dist/server.js` + `COLLAB_DB_PATH`) still works unchanged; doctor marks it ! with the replacement.
- By hand on NAVEEN: install the package from a local tarball, `collab notebook adopt` the live notebook as `emp1st`, switch `.mcp.json` to `collab mcp`, run `collab doctor`: all ✓ except expected !s.

## Not in this piece

- One courier carrying several notebooks, and `collab join` (piece 2).
- `collab update`, migrating only up to the post office's version (piece 3).
- Post office on a server, admin page (piece 4).
- Moving an adopted notebook into the data folder (a later command).
- A double-click installer for non-developers (later, after the commands are stable; E-751 option C).

## Risks and open items

- O1: npm package name. `collab` is almost certainly taken; pick before the first public publish. The command can stay `collab` regardless of the package name.
- O2: Claude Code registration scope. Piece 1 only reads and reports it (check 6); piece 2's `join` writes it, and must choose user scope vs project scope.
- Windows clean-exit handling for heartbeat files is unreliable on console close; the design tolerates leftovers (stale detection) instead of depending on clean exit.
- Moving the courier CLI under `collab sync` must keep the current `collab` bin working on NAVEEN and RINKU until both use the package (same subcommands, same config folder).
- Node version: RINKU runs 22.11; Vite (UI build) wants 22.12+. Only the build machine needs it once the UI ships prebuilt; doctor's Node check uses the runtime `engines` range, not the build tool's.
