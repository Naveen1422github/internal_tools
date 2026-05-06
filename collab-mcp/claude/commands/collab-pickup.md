Pick up a task and move it to in-progress.

Task id: $ARGUMENTS

## Instructions

1. Call `mcp__collab__collab_task_get` with `{ "id": "$ARGUMENTS" }`. If task is null, stop with "Task not found."
2. Show task summary + `recent_entries`. Ask user to confirm pickup.
3. If `task.assignee` is null, call `mcp__collab__collab_task_assign` with `{ "id": "$ARGUMENTS", "assignee": "Claude" }`.
4. Call `mcp__collab__collab_task_transition` with `{ "id": "$ARGUMENTS", "status": "in-progress" }`.

