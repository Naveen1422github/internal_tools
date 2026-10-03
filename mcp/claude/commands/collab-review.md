Run a Codex review and save it to collab automatically.

Target (PR or branch): $ARGUMENTS

## Resolving paths

This file lives at `<collab-mcp>/mcp/claude/commands/collab-review.md`, so the dispatch
script is three directories up, at `<collab-mcp>/scripts/codex-dispatch.sh`. Resolve
`<collab-mcp>` from the path you opened this file through (a redirect in `.claude/commands/`
names it), or from `$COLLAB_MCP_DIR` if it is set. If neither resolves, ask the user rather
than guessing.

## Instructions

1. Run bash: `bash "<collab-mcp>/scripts/codex-dispatch.sh" "Review: $ARGUMENTS" --review --db "<db>"`,
   where `<db>` is this project's collab database (`$COLLAB_DB_PATH`, or the value in
   this project's `.mcp.json`).
2. `--review` makes the parser persist the entry as `type=review`; `--db` pins which
   database it lands in. Omitting `--db` falls back to `$COLLAB_DB_PATH`, then to
   `./collab.db` in the current directory.
3. Parse stdout for the final saved `{ "id": "...", "confidence": ... }` JSON line and
   report `E-00000`. The script prints the absolute DB path it wrote to — verify it.
4. If exit non-zero, surface stderr and stop (do not manually re-add).

Note: there is no separate `codex-review.sh`. Review is a `--review` flag on the dispatch
script. The old reference to `codex-review.sh` was dead for months — see collab E-550.
