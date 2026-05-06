Dispatch a task to Codex (quiet) and save the resulting handoff automatically.

Task description: $ARGUMENTS

## Instructions

1. Run bash: `bash .claude/scripts/codex-dispatch-quiet.sh "$ARGUMENTS"`.
2. That script saves a `handoff` entry via `mcp__collab__collab_add` (through `parse-codex-output.ts --save`).
3. Parse stdout for `{ "id": "...", "confidence": ... }` and report `E-00000`.
4. If a `T-NNN` is mentioned in refs, suggest running `/collab-pickup T-NNN`.

