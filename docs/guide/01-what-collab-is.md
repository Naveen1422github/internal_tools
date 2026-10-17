# 1. What collab is

## The problem

AI coding agents forget everything between sessions. Each new session re-reads code and re-discovers the same decisions, gotchas and history, which costs tokens and time and leads to mistakes. Collab is a **memory the agent keeps across sessions**. Decisions, gotchas, handoffs and plans are saved as notes. The next session searches them instead of re-deriving everything.

It started (June 2026) as shared Markdown files. It became a real database because files couldn't be searched well, got out of sync between agents, and had no structure.

## The one-sentence design

> A local SQLite file you own, with full-text search, reached by the AI through MCP and by you through a CLI and a web UI. Optional sync lets a small team share chosen projects.

Two principles came later and now shape everything:

- **Local-first** (COLLAB-121): a solo user never needs, sees, or waits for any server. Sync is an add-on.
- **The AI can do anything you can** (COLLAB-122): every action available in the CLI should also exist as an MCP tool, so the AI never gets stuck.

## The parts

```
          you                         the AI (Claude, Codex…)
           │                                   │
   ┌───────┴────────┐                  ┌───────┴───────┐
   │ CLI  `collab`  │   web UI :7473   │  MCP server   │
   └───────┬────────┘   (React page)   └───────┬───────┘
           │                │                  │
           └────────────────┼──────────────────┘
                            ▼
                    core  (all the rules)
                            │
                  your notebook: collab.db  (SQLite + search)
                            │
                  courier  (background, only for team projects)
                            │  HTTPS
                            ▼
                  post office :7443  (one per team)
                            │
                  other laptops' couriers
```

| Part | Folder | What it does |
|---|---|---|
| **core** | `core/` | The only code allowed to change the notebook. Every rule (numbering, projects, copy, permissions) lives here, so CLI, MCP and web behave identically. |
| **MCP server** | `mcp/` | How the AI talks to collab: tools like `collab_add`, `collab_search`, `collab_module_get`. |
| **CLI** | `cli/` | The `collab` command for you: `collab doctor`, `collab project list`, `collab team list`, `collab office serve`… |
| **web UI** | `ui/` (page) + `server/` (its backend) | Dashboard, Knowledge, ⌘K search, Modules, Tasks, AI assistant panel, sync status, conflict merge page. Runs on `127.0.0.1:7473`. |
| **courier** | `courier/` | A small background program on each laptop. Sends this laptop's team notes to the post office and brings others' notes back. |
| **post office** | `post-office/` | A small server one team member runs. Gives team notes their numbers, keeps the shared copy, merges simultaneous edits, decides who receives what. |
| **gemini-mcp** | `gemini-mcp/` | Old helper. Gemini was retired on 2026-07-07; the folder is archive only. |

## Where things live on your machine

| Thing | Location |
|---|---|
| Code (repo, branch `collabv1`) | `frontend2/internal-tools/` → GitHub `Naveen1422github/internal_tools` |
| Your notebook | `internal-tools/mcp/collab.db` (adopted older location) |
| Post office data | `%LOCALAPPDATA%\collab\post-office\` (`store.db`, certificate, config) |
| Courier log | `%LOCALAPPDATA%\collab\courier\courier.log` |
| Backups | `internal-tools/backups/` |
| Designs (specs) | `internal-tools/docs/superpowers/specs/` |
| Build plans | `internal-tools/docs/superpowers/plans/` |

## How the AI and the code are organised

- **Claude** does design, architecture and review. **Codex** or subagents do implementation (your collaboration policy in `CLAUDE.md`).
- Big pieces follow: brainstorm, then a written spec you approve, then a plan, then build by subagents with a review after every task, then a whole-branch review, then merge.
- Each upgrade to the notebook's structure is a numbered **migration** (`mcp/migrations/0001…0012`). They run in order, once, and back the file up first.
