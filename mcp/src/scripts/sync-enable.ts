// One-time: turn a notes DB into a shareable one (spec D2). NEVER run on the
// live DB before the Plan 3 go-live; it takes a backup first.
import { getDb, closeDb, enableSync } from "@collab-mcp/core";
const r = enableSync(getDb(), { backup: true });
console.log(r.alreadyEnabled ? "sharing was already enabled" : `sharing enabled on: ${r.tables.join(", ")}\nbackup: ${r.backup}`);
closeDb();
