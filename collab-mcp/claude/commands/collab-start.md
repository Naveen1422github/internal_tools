Start (or initialize) a collab module card.

Module slug: $ARGUMENTS

## Instructions

1. Call `mcp__collab__collab_module_get` with `{ "slug": "$ARGUMENTS" }`.
2. If `module` is null, ask: "Module not found. Initialize with current_goal=?"  
   - On confirm, call `mcp__collab__collab_module_init` with `{ "slug": "<slug>", "current_goal": "<user text>" }`.
   - Re-call `mcp__collab__collab_module_get`.
3. Display the returned module card sections: `active_tasks`, `top_gotchas`, `recent_decisions`, `recent_handoffs`.

