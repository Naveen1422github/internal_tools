Mark a task done and optionally roll up older history.

Task id: $ARGUMENTS

## Instructions

1. Call `mcp__collab__collab_task_transition` with `{ "id": "$ARGUMENTS", "status": "done" }`.
2. Call `mcp__collab__collab_task_get` with `{ "id": "$ARGUMENTS" }` and inspect `recent_entries`.
3. If any `recent_entries[].created_at` is older than 14 days, suggest `mcp__collab__collab_rollup` with `{ "task_id": "$ARGUMENTS" }` and call it on confirm.

