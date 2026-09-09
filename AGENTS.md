# AGENTS.md

This repo has the **Collab MCP** — a small, local, SQLite-backed knowledge base that
your AI shares across sessions. Codex and agy auto-load this file; follow these
conventions when working here.

## Conventions

- **Search before you add.** Run `collab_search` (filter by `module`) before creating an
  entry — don't duplicate or re-derive what's already captured.
- **Capture as you work:**
  - a **decision** when you choose an approach (record the *why*),
  - a **gotcha** when something bites you,
  - a **changelog** when you finish a unit of work.
- **Summaries ≤ 200 characters** — one-line hook in `summary`, real detail in
  `description`. Longer summaries are rejected.
- Tag entries with `module` so a feature's history stays one filtered search away.

## More

See the **`collab-workflow`** skill (`skills/collab-workflow/SKILL.md`) for the full
workflow and the list of available `collab_*` tools.
