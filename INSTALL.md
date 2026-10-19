# Installing collab (instructions for an AI assistant)

You are an AI assistant (Claude Code, Codex or similar) setting up **collab** for the person you work with. Collab is a local notebook for people and AI agents: notes, decisions, gotchas and hand-offs, searchable, kept on this computer. Team sharing is optional and comes later.

Follow the steps in order. Each step says what to run and what success looks like. Run the commands yourself; only the steps marked **Person** need the human. If a step fails, stop and show the person the exact error and the fix printed next to it.

## 0. Check the computer (you)

```
node --version
```

Success: `v20.9.0` or newer. If Node is missing or older, **Person**: install Node 20 LTS or newer from https://nodejs.org, then open a new terminal.

## 1. Get the package (Person gives it, you install it)

The person gives you one of these:

- **A package file** `collab-mcp-collab-<version>.tgz`. Install it:
  ```
  npm install -g <path-to>/collab-mcp-collab-<version>.tgz
  ```
- **Access to the source repository.** Build the package first, then install the file it prints:
  ```
  git clone <repo-url> collab-src
  cd collab-src
  npm ci --force
  npm run build
  npm run package
  npm install -g dist-package/collab-mcp-collab-<version>.tgz
  ```
  (`--force` is needed only off Windows: one UI dependency is Windows-only.)

Success: `collab --version` prints `collab <version> (build ...)`.

The install also tries to download a small sync add-on. If that fails (no internet), the install still succeeds; it is only needed for team sharing, and `collab doctor --fix` fetches it later.

## 2. Create the person's notebook (you)

Ask the person for a short name (default: `personal`).

```
collab notebook new <name>
```

Success: `Created <name>: <path>` and `It is your default notebook.`

## 3. Create a first project (you)

Notes live in projects. A **solo** project stays on this computer and is never sent anywhere. Ask the person what to call it and pick a 2–5 letter code (notes are numbered `<CODE>-1`, `<CODE>-2`, ...).

```
collab project create "<Project name>" --code <CODE>
```

Success: `Created project <CODE> (<Project name>), solo: ...`

## 4. Connect collab to the AI tool (you)

**Claude Code:**
```
claude mcp add --scope user collab -- collab mcp
```
`--scope user` makes collab available in every folder. If Claude Code later shows collab as failed to connect on Windows, re-add it as `claude mcp add --scope user collab -- cmd /c collab mcp`.

**Other MCP clients:** add a stdio server named `collab` with command `collab` and arguments `["mcp"]`.

## 5. Reload the AI tool (Person)

**Person**: in Claude Code, type `/mcp`, choose **collab**, then **Reconnect** (or restart Claude Code). This is the only step you cannot do yourself.

After that, the `collab_*` tools are available to you.

## 6. Add standing instructions (you)

So that every future session uses collab without being told, add the section below to the person's instruction file. Ask the person: "Should collab apply in every folder, or only in one project folder?" Default to every folder.

| Agent | Every folder | One project folder |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` in that folder (the one they open Claude Code in) |
| Codex | `~/.codex/AGENTS.md` | `AGENTS.md` in that folder |
| Other agents | their global instruction file | `AGENTS.md` in that folder |

If the file exists, **append** the section (don't change anything else in it; if a "Collab" section is already there, replace only that section). If it doesn't exist, create it with just this section. Replace `<CODE>` with the project code from step 3.

```markdown
## Collab (shared notebook)

This computer has collab, a local notebook for people and AI agents, available as the `collab_*` MCP tools. Use it as long-term memory across sessions.

- **Before** analysing something non-trivial, search collab first (`collab_search`) so you don't repeat past work.
- **Record** what future sessions should know, with `collab_add`:
  - `decision`: a choice and why it was made
  - `gotcha`: a trap or surprising behaviour, and how to avoid it
  - `pattern`: a reusable way of doing something
  - `handoff`: at the end of a session, where things stand and what's next
- Keep the summary under 200 characters; put details in the description.
- Notes go to project `<CODE>` unless the person says otherwise: pass `project: "<CODE>"` to `collab_add` (search covers all projects). Always cite notes by their full reference (for example `<CODE>-12`).
- `collab_search` hides log-type notes (`session-note`, `changelog`) by default; pass `kind: "any"` to include them.
- Group related notes with a `module` (a short topic slug such as `billing` or `onboarding`).
- Never edit the notebook file directly; always go through the collab tools or the `collab` command.
- To check the setup, run `collab doctor`. To install or update collab, follow its INSTALL.md.
```

## 7. Check everything (you)

```
collab doctor
```

Success: `0 problem(s)`. Warnings are fine on a fresh install:
- `Web server not running` is expected until the person opens the UI.
- `collab isn't registered in Claude Code`: confirm with `claude mcp list`. If collab shows **Connected** there, ignore the warning; otherwise redo step 4 and 5.

Note: `collab doctor` exits with code 1 when there are warnings, so a non-zero exit is not a failure by itself. Read the `problem(s)` count.

Then prove it works end to end with the collab tools:

1. `collab_add` with `{ "type": "session-note", "project": "<CODE>", "title": "collab installed", "summary": "collab was installed and connected today." }` (`type`, `title` and `summary` are required). It answers `Added <CODE>-1 (session-note).`
2. `collab_search` with `{ "query": "installed", "kind": "any" }`. `kind: "any"` is needed because session notes are hidden from search by default.

Tell the person the reference it got (for example `<CODE>-1`).

## 8. The web UI (optional, Person or you)

```
collab web
```

It prints `collab web: http://127.0.0.1:7473/`. Open that address in a browser. The page works only on this computer.

## Updating later (you)

1. Install the new package the same way as step 1 (`npm install -g <new .tgz>`).
2. **Person**: `/mcp` → collab → Reconnect. The notebook is upgraded automatically on first use, and a backup is saved next to it first.
3. If `collab web` or the sync courier were running, restart them.
4. Run `collab doctor`.

Never run an old collab against a notebook a newer version has upgraded. Always update, then restart everything.

## Joining a team later

Not needed for solo use. When the person joins a team, they get a join code from the team's post office admin. Their solo projects stay private and unchanged. A solo project can later be turned into a team project and its notes keep their numbers.
