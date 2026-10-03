Dispatch a task to Codex (quiet) and save the resulting handoff automatically.

Task description: $ARGUMENTS

## Resolving paths

This file lives at `<collab-mcp>/mcp/claude/commands/collab-dispatch.md`, so the
dispatch script is three directories up, at `<collab-mcp>/scripts/codex-dispatch-quiet.sh`.
Resolve `<collab-mcp>` from the path you opened this file through (a redirect in
`.claude/commands/` names it), or from `$COLLAB_MCP_DIR` if it is set. If neither
resolves, ask the user for the install path rather than guessing — a wrong path
writes into another project's knowledge base.

## Instructions

1. Run bash: `bash "<collab-mcp>/scripts/codex-dispatch-quiet.sh" "$ARGUMENTS" --db "<db>"`,
   where `<db>` is this project's collab database. Use `$COLLAB_DB_PATH` if set;
   otherwise it is the `COLLAB_DB_PATH` value in this project's `.mcp.json`.
2. That script saves a `handoff` entry via `parse-codex-output.ts --save`. `--db` pins
   which database it lands in; without it the entry follows `$COLLAB_DB_PATH`, then
   `./collab.db` in the current directory.
3. Parse stdout for `{ "id": "...", "confidence": ... }` and report `E-00000`.
   The script also prints the absolute DB path it wrote to — check it is the one you meant.
4. If a `T-NNN` is mentioned in refs, suggest running `/collab-pickup T-NNN`.

The dispatch defaults to model `gpt-5.6-terra`; override with `--model` or `$CODEX_MODEL`.
