Draft + save a handoff entry (from current git working tree).

Args: $ARGUMENTS (optional: `--task T-NNN`)

## Instructions

1. Run bash: `git diff --stat HEAD` and `git status --short`. Collect the changed file paths (tracked files only).
2. Build `raw_text` = (recent assistant actions) + (diff stat) + (status short).
3. Call `mcp__collab__collab_ingest` with:
   - `source="manual"`, `raw_text`, and `context={ task_id?, module?, agent:"Claude", changed_files:[...] }`.
4. Show `draft_entry` and ask user to confirm/edit `title/summary/description` (default type=`handoff`).
5. On confirm, call `mcp__collab__collab_add` with the finalized fields and echo the new `E-00000` id.

