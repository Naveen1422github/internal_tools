# Installing collab (instructions for an AI assistant)

You are an AI assistant (Claude Code, Codex, Antigravity or any other MCP-capable agent) setting up **collab** for the person you work with. Collab is a local notebook for people and AI agents: notes, decisions, gotchas and hand-offs, searchable, kept on this computer. Team sharing is optional and comes later.

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
  npm install -g <full-path-to>/collab-mcp-collab-<version>.tgz
  ```
- **The repository link.** Clone the `collabv1` branch (the default branch is older), build the package, then install the file it prints:
  ```
  git clone -b collabv1 https://github.com/Naveen1422github/internal_tools.git collab-src
  cd collab-src
  npm ci
  npm run build
  npm run package
  npm install -g ./dist-package/collab-mcp-collab-<version>.tgz
  ```
  - `npm ci` takes a few minutes. On macOS or Linux it fails with `EBADPLATFORM` (one UI dependency is Windows-only); there, run `npm ci --force` instead.
  - Building needs Node 20.19+ or 22.13+ (a build tool warns `EBADENGINE` on older versions). Running the installed package only needs 20.9+.
  - Use the exact file name `npm run package` printed (`<version>` is a number such as `0.1.0`), and keep the leading `./`: without it npm treats the path as a GitHub repository and fails with `Permission denied (publickey)`.

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

## 4. Connect collab to your agent (you)

Collab is an MCP server that runs over stdio: command `collab`, arguments `["mcp"]`. Register it in the agent you are running in, so it is available in every folder:

| Agent | How |
|---|---|
| Claude Code | `claude mcp add --scope user collab -- collab mcp` |
| Codex | `codex mcp add collab -- collab mcp`, or add to `~/.codex/config.toml`:<br>`[mcp_servers.collab]`<br>`command = "collab"`<br>`args = ["mcp"]` |
| Antigravity | In the agent panel: **MCP Servers → Manage MCP Servers → View raw config**, and add `"collab": { "command": "collab", "args": ["mcp"] }` under `mcpServers` |
| Any other agent | Add a stdio MCP server named `collab`, command `collab`, args `["mcp"]`, in its MCP settings |

If you are unsure where your agent keeps its MCP settings, check its documentation rather than guessing. If an existing `collab` entry is already there, replace it.

On Windows, if the agent later reports collab failed to start, use command `cmd` with args `["/c", "collab", "mcp"]` instead.

## 5. Reload the agent (Person)

**Person**: make the agent pick up the new server. This is the only step you cannot do yourself.
- Claude Code: type `/mcp`, choose **collab**, then **Reconnect** (or restart Claude Code).
- Codex: start a new session.
- Antigravity: refresh the MCP servers list in the agent panel (or restart Antigravity).

After that, the `collab_*` tools are available to you.

## 6. Add standing instructions (you)

So that every future session uses collab without being told, add the section below to the person's instruction file. Ask the person: "Should collab apply in every folder, or only in one project folder?" Default to every folder.

| Agent | Every folder | One project folder |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` in that folder (the one they open Claude Code in) |
| Codex | `~/.codex/AGENTS.md` | `AGENTS.md` in that folder |
| Antigravity | its global rules file (`~/.gemini/GEMINI.md`) | a rule file in that folder's `.agent/rules/`, or `AGENTS.md` |
| Other agents | their global instruction file | `AGENTS.md` in that folder (most agents read it) |

Use the file your agent actually reads; if its documentation names a different place, follow that. If the person uses more than one agent, add the section for each.

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
- `collab isn't registered in Claude Code`: doctor only knows how to check Claude Code. If the person doesn't use Claude Code, ignore it. If they do, confirm with `claude mcp list`; if collab shows **Connected** there, ignore the warning, otherwise redo steps 4 and 5.
- For any agent, the real check is the next one: if the `collab_*` tools answer, the connection works.

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

1. Install the new version the same way as step 1: `npm install -g <full path to the new .tgz>`, or, if you cloned the repository, `git pull` in `collab-src`, then `npm ci` (with `--force` off Windows), `npm run build`, `npm run package` and `npm install -g ./dist-package/<new .tgz>`.
2. **Person**: reload the agent as in step 5. The notebook is upgraded automatically on first use, and a backup is saved next to it first.
3. If `collab web` or the sync courier were running, restart them.
4. Run `collab doctor`.

Never run an old collab against a notebook a newer version has upgraded. Always update, then restart everything.

## Joining a team later

Not needed for solo use. When the person joins a team, they get a join code from the team's post office admin. Their solo projects stay private and unchanged. A solo project can later be turned into a team project and its notes keep their numbers.
