---
name: collab-workflow
description: Use when working in a repo that has the Collab MCP — search before adding, capture decisions/gotchas/changelogs as you work, and keep summaries under 200 characters.
---

# Collab Workflow

Collab MCP is a small, local, AI-shared knowledge base. Use it so you (and the next
session) start with context instead of re-deriving it.

## The loop: search → act → capture

1. **Search first.** Before adding anything, run `collab_search` (filter by `module`
   when you can). Avoid duplicates; reuse what's already known.
2. **Act** on the task.
3. **Capture** what's worth keeping — see the entry types below.

## Entry types — when to use each

- **decision** — you chose an approach over alternatives. Record the choice *and the
  why*, so it isn't re-litigated later.
- **gotcha** — a sharp edge that cost you time. Highest-value entry to capture; it saves
  the most time when re-hit.
- **changelog** — you finished a unit of work. An activity log of what shipped and why.
- **session-note** — running context/notes for ongoing work.
- **handoff** — passing work to another agent or session, with the state they need.

## Categories (the retrieval bucket)

- **Index** — navigation hubs / start-here entries.
- **Reference** — durable knowledge: decisions, gotchas. (Default for decision/gotcha.)
- **Activity** — time-ordered logs: changelogs, session-notes, handoffs.

If you omit `category`, it's derived from the type. Set `Index` explicitly for hubs.

## Rules

- **Summaries ≤ 200 characters.** The summary is a one-line hook; put real content in
  `description`. `collab_add` rejects longer summaries.
- Pass `module` (and `modules` for many-to-many) so an entire feature's history is one
  filtered search away.

## Install this skill into your agent

- **Claude Code** — copy this folder to `.claude/skills/collab-workflow/`
- **Codex** — copy to `.codex/skills/collab-workflow/`
- **agy (Antigravity)** — copy to `~/.gemini/antigravity-cli/skills/collab-workflow/`
