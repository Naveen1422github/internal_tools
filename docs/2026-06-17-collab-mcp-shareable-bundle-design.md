# Collab MCP — Shareable + Agent-Leveraged Bundle — Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)
**Module:** `workspace-redesign`
**Builds on:** `docs/2026-06-15-internal-tools-industry-grade-design.md` (Phases 0–3: hexagonal `@emp1st/core`, thin MCP + REST adapters)

## Goal

Reach a version of the Collab MCP that the author can drop into **any workspace** and
**share with friends** — and that **leverages what Codex and Antigravity (agy) already
offer** (MCP clients, skills, hooks, shared context files) so any agent arrives
pre-onboarded to the knowledge system. The web UI is **not** required; the shareable
unit is the **MCP server** (`mcp`) + its domain core (`core`), plus a small set of
cross-agent onboarding assets.

## Approach: Option B — single source of truth + export script

`internal-tools` stays the one place development happens. A `bundle` script produces a
clean, friend-ready copy on demand. No fork, no second codebase to keep in sync.

Rejected: (A) separate repo = divergence risk; (C) `git subtree split` = premature.

## Verified agent landscape (first-party + docs)

The bundle targets three MCP-capable agents; setup verified against the installed tools
and official docs:

- **Claude Code** — project `.mcp.json`, `mcpServers.collab` → `node <path>/mcp/dist/server.js`. (Confirmed working in this repo.)
- **Codex** (CLI v0.137.0) — `codex mcp add collab --env COLLAB_DB_PATH=<db> -- node <abs>/mcp/dist/server.js` (writes `~/.codex/config.toml`). `codex mcp-server` is the official "Codex as MCP server" command.
- **agy** (Antigravity CLI) — `mcpServers` in `~/.gemini/antigravity-cli/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace); managed in-CLI via `/mcp`. Schema example:
  ```json
  { "mcpServers": { "collab": { "command": "node", "args": ["<abs>/mcp/dist/server.js"], "env": { "COLLAB_DB_PATH": "<db>" } } } }
  ```

The MCP server itself stays **agent-agnostic** (standard MCP — any MCP client works).
All agent-specific setup lives in the README/onboarding assets, not in code.

### Prerequisite fixes (author's machine config, outside the repo)
1. **Codex stale path:** `~/.codex/config.toml` points `collab` at a non-existent
   `internal-tools/collab-mcp/dist/server.js`; correct to `internal-tools/mcp/dist/server.js`.
2. **agy not wired:** agy's `mcp_config.json` is empty; add the `collab` server entry.

Both are needed to *test* that Codex/agy can actually reach collab before shipping
setup docs that claim they can.

## Scope (v1)

### Part 1 — Package rename (single source)

| Current | New |
|---|---|
| `@emp1st/core` | `@collab-mcp/core` |
| `@emp1st/collab-mcp` | `collab-mcp` (`bin: collab-mcp`) |
| `@emp1st/server` | `@collab-mcp/server` |
| `@emp1st/gemini-mcp` | `@collab-mcp/gemini-mcp` |

Pure mechanical find-replace across ~15 code files → dispatched to agy, reviewed by
Claude. Goes **first** (riskiest: import paths). **Verify (user runs):** `npm install`
→ `npm run build` → `npm test` all green; golden snapshots byte-identical.

### Part 2 — Bundle script (`npm run bundle`)

`scripts/bundle.mjs` → `dist-share/collab-mcp/` (+ `.zip`).

**Includes:** `core/` + `mcp/` (source, package.json, tsconfig, migrations); slim root
`package.json` (workspaces = `core`, `mcp`); `tsconfig.base.json`, `.nvmrc`, `.gitignore`,
`.env.example`; `README.md`, `LICENSE`; the onboarding assets (Parts 3–6).

**Excludes (never ship):** `server/`, `ui/`, `gemini-mcp/`; private `docs/`; **every
`collab.db*`**; `.env`; `node_modules`.

Re-runnable: re-run to publish an updated clean copy.

### Part 3 — Onboarding starter entries (`npm run seed:starter`)

Seeds a small set of **genuinely useful** entries (not throwaway data) into a friend's
fresh DB — self-documenting, surfaced by their first `collab_search`:

1. **`start-here`** — what the tool is + the core loop: *search before you add; capture
   decisions, gotchas, patterns so your AI stops re-deriving them.*
2. **`using-with-agents`** — how to point Claude Code, Codex, and agy at the MCP (the
   verified setups above). Tool stays agent-agnostic; specifics live here.
3. **Three example entries** — one `decision`, one `gotcha`, one `pattern` — whose
   content is real advice about using the tool itself (example + tip in one).

### Part 4 — Portable `collab-workflow` skill (cross-agent leverage)

A single `SKILL.md` (the format works in Claude Code, Codex `.codex/skills/`, and agy
`~/.gemini/antigravity-cli/skills/`) teaching the workflow once: search-before-add,
entry types/categories, logging discipline, when to use each `collab_*` tool. Shipped in
the bundle with a one-command install per agent. Payoff: **every agent — ours and a
friend's — is onboarded identically from one source.**

### Part 5 — `AGENTS.md` conventions (free shared context)

Both Codex (`AGENTS.md`) and agy (`GEMINI.md`/`.agents/`) auto-load repo context. Ship a
short `AGENTS.md` in the bundle stating the collab conventions so any agent inherits them
with zero setup.

### Part 6 — README + LICENSE

- **README.md:** what it is; requirements (Node ≥ 20.9); `npm install && npm run build`;
  the three verified agent setups; DB location (`COLLAB_DB_PATH`) + per-workspace use;
  `npm run seed:starter`; how to install the skill; the tools the MCP exposes.
- **LICENSE:** MIT, author's name.

## A friend's experience

```
unzip collab-mcp.zip && cd collab-mcp
npm install && npm run build
# wire your agent (pick one, from README):
#   Claude Code: paste .mcp.json snippet
#   Codex:       codex mcp add collab -- node $PWD/mcp/dist/server.js
#   agy:         add collab to ~/.gemini/antigravity-cli/mcp_config.json
npm run seed:starter        # optional: onboarding entries + demo
# (optional) install the collab-workflow skill into your agent
```

MCP auto-migrates an empty DB on boot (`mcp/src/server.ts` → `getDb()` then `migrate()`).

## Phase 2 — deeper leverage (deferred, not in v1)

Bounded follow-ups, valuable but not blockers for a shareable v1:

- **Auto-log hook (agy `/hooks`):** post-action hook that writes a collab session-note/
  changelog automatically — enforces the "always log" rule at the tool level instead of
  relying on the agent. (Highest-leverage workflow win; agy-specific.)
- **Structured Codex dispatch:** drive Codex via `codex exec --json --output-schema` for
  machine-readable results. **Caveat (verified, GitHub #15451):** `--json`/
  `--output-schema` are silently ignored when MCP servers are active — run such dispatch
  with Codex's MCP servers off.
- **agy plugin packaging:** bundle MCP + skill + hook as one `agy plugin install collab`.

## Out of scope (YAGNI)

npm-registry publish; the web UI; multi-user/cloud; auth.

## Verification

1. **Prereq fixes:** after correcting Codex path + adding agy config, confirm each agent
   can call `collab_search` (resolves two open empirical questions: agy's exact active
   `mcp_config.json` path, and whether `agy -p` print-mode loads MCP servers).
2. **Rename:** `npm install && npm run build && npm test` green; golden byte-identical.
3. **Bundle:** clean-room smoke test — unzip to a throwaway dir, install, build, point a
   scratch agent config at it, confirm `collab_search` + `seed:starter` work.
4. **Bundle hygiene:** contains no `collab.db*`, no `.env`, no `docs/`, no
   `server/`/`ui/`/`gemini-mcp/`.

## Rough effort: ~7–9 hours (v1)

Prereq fixes + verify ~0.5h · rename ~1.5h · bundle script ~2h · onboarding seed ~1h ·
portable skill ~1h · AGENTS.md ~0.5h · README + LICENSE ~1h. Phase 2 separate.

## Open questions for empirical verification (not guesses)

- agy active `mcp_config.json` path (`~/.gemini/antigravity-cli/` per docs vs the empty
  `~/.gemini/config/` found locally) — confirm via `/mcp` / a test run.
- Does `agy -p` (print/headless) load MCP servers, or only interactive mode?
- Codex #15451 status in v0.137.0 — does structured output survive with MCP active?
