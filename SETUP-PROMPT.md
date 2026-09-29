# Connect Collab MCP — setup prompt

**The easiest way to set this up: let your AI do it.**

> You only need **one** MCP-capable coding agent — **not** all of them. This works with
> Claude Code, Codex, agy (Antigravity), and any other MCP client (Cursor, Cline,
> Windsurf, Zed, VS Code Copilot, …). The server speaks standard MCP; the only
> requirement is that your agent supports MCP servers.

1. Find the absolute path to this `collab-mcp` folder (e.g. `~/tools/collab-mcp`).
2. Open your coding agent (Claude Code, Codex, or agy) **in the project where you want
   the knowledge base active**.
3. Paste the prompt below, with the path filled in.

The agent will build the server (if needed), register it, merge the conventions into your
existing `AGENTS.md`/`CLAUDE.md` (or create one), install the workflow skill, and verify
the connection — telling you exactly what it changed.

---

## Paste this into your agent

````text
Set up the "Collab MCP" knowledge server for me in THIS workspace. It is installed at:

  COLLAB_MCP_DIR = <ABSOLUTE PATH TO THE collab-mcp FOLDER>

Work carefully and idempotently. At the end, report exactly which files you created or
edited. If you are unsure which host you are (Claude Code / Codex / agy), ask me.

1. BUILD (once)
   If "${COLLAB_MCP_DIR}/mcp/dist/server.js" does NOT exist, run `npm install` then
   `npm run build` inside ${COLLAB_MCP_DIR}. If it already exists, skip this.

2. PICK A DATABASE PATH
   Use this workspace's own DB: COLLAB_DB_PATH = "<absolute path of this workspace>/collab.db".
   (This keeps each project's knowledge separate. The servers never create one on their own.)

3. CREATE THE DATABASE (once)
   Create the database once (the servers never create one on their own):
   COLLAB_DB_PATH="<dbpath>" npm --prefix ${COLLAB_MCP_DIR}/mcp run migrate

4. CONNECT THE MCP SERVER for whichever host you are — create config files if missing,
   and NEVER remove existing servers/entries:
   - Claude Code → merge into this project's `.mcp.json` under `mcpServers`:
       "collab": { "command": "node",
                   "args": ["${COLLAB_MCP_DIR}/mcp/dist/server.js"],
                   "env": { "COLLAB_DB_PATH": "<dbpath>" }, "type": "stdio" }
   - Codex → run:
       codex mcp remove collab   # ignore error if none
       codex mcp add collab --env COLLAB_DB_PATH=<dbpath> -- node ${COLLAB_MCP_DIR}/mcp/dist/server.js
   - agy (Antigravity) → merge a `mcpServers.collab` entry (same shape as Claude Code's)
     into `~/.gemini/antigravity-cli/mcp_config.json` (create the file/dir if missing).
   - ANY OTHER MCP-capable agent (Cursor, Cline, Windsurf, Zed, VS Code Copilot, …) →
     add a standard **stdio** MCP server named `collab` to your own MCP config. Most use a
     JSON `mcpServers` block identical to Claude Code's above (command `node`, args the
     server path, env `COLLAB_DB_PATH`). If you know your config file's location, edit it;
     if you're unsure where it lives, ask me and I'll point you to it — do not guess.

5. ADD THE CONVENTIONS — without clobbering anything
   Find this workspace's agent context file: `CLAUDE.md` (Claude Code) or `AGENTS.md`
   (Codex/agy). If neither exists, create `AGENTS.md`. If the markers below are already
   present, do nothing. Otherwise APPEND this block (keep all existing content):

   <!-- collab-mcp:start -->
   ## Collab MCP
   This workspace has the Collab MCP knowledge base (shared across AI sessions).
   - Search first (`collab_search`, filter by `module`) before adding — don't duplicate.
   - Capture as you work: `decision` (a choice + the why), `gotcha` (a sharp edge),
     `changelog` (a finished unit of work).
   - Keep summaries <= 200 chars; put detail in the description. Tag entries with `module`.
   <!-- collab-mcp:end -->

6. INSTALL THE WORKFLOW SKILL (recommended)
   Copy "${COLLAB_MCP_DIR}/skills/collab-workflow/" into this host's skills directory:
   - Claude Code → `.claude/skills/collab-workflow/`
   - Codex → `.codex/skills/collab-workflow/`
   - agy → `~/.gemini/antigravity-cli/skills/collab-workflow/`

7. VERIFY
   The MCP server loads when the host starts, so I may need to restart you. After a
   reload, call `collab_search` with query "start" and show me the first result's title.
   If you cannot see a `collab_search` tool yet, tell me to restart you and then retry.
````

---

If anything is ambiguous, the agent should ask you rather than guess. You can re-paste
this any time — every step is safe to run again.
