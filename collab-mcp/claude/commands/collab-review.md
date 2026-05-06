Run a Codex review and save it to collab automatically.

Target (PR or branch): $ARGUMENTS

## Instructions

1. Run bash: `bash .claude/scripts/codex-review.sh "$ARGUMENTS"`.
2. That script already saves a `review` entry via `mcp__collab__collab_add` (through `parse-codex-output.ts --save`).
3. Parse stdout for the final saved `{ "id": "...", "confidence": ... }` JSON line and report `E-00000`.
4. If exit non-zero, surface stderr and stop (do not manually re-add).

