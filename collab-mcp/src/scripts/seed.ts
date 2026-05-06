#!/usr/bin/env node
/**
 * Seed the collab DB with a few representative entries using addEntry().
 * Idempotent — skips if entries table already has rows.
 *
 * Run:
 *   npx tsx src/scripts/seed.ts
 */
import { getDb, migrate, closeDb } from "../db.js";
import { addEntry } from "../tools/add.js";

const db = getDb();
migrate(db);

const { n } = db.prepare("SELECT count(*) AS n FROM entries").get() as { n: number };
if (n > 0) {
  console.log(`[seed] entries table already has ${n} row(s); skipping.`);
  closeDb();
  process.exit(0);
}

const seeded: number[] = [];

seeded.push(
  addEntry(db, {
    type: "gotcha",
    title: "Attendance join key is STRING, not ObjectId",
    summary: "attendances.employeeId is employee.employeeId (string), not the Mongo ObjectId.",
    description:
      "When joining attendances to employees you must match on the string employee code. " +
      "Easy mistake when replicating the leaverequests/travelrequests pattern which use ObjectIds.",
    agent: "Claude",
    module: "custom-reports",
    refs: [
      { ref_type: "file", ref_value: "attendance-service/src/models/attendance.ts" },
    ],
  }).id
);

seeded.push(
  addEntry(db, {
    type: "decision",
    title: "Query strategy: hybrid $lookup + application join",
    summary: "Use $lookup for employee to related collection; app-level join for cross-collection filters.",
    description:
      "Avoids blowing out the aggregation pipeline across 7 data domains while keeping the " +
      "employee decrypt step in application code.",
    agent: "User",
    module: "custom-reports",
  }).id
);

seeded.push(
  addEntry(db, {
    type: "handoff",
    title: "Collab v2 step 3 complete - add/get/list_recent wired",
    summary: "collab.add / collab.get / collab.list_recent are live via MCP; seed script populates DB.",
    description:
      "Skipped the markdown importer (BOARD/HANDOFFS were already cleared). Next up: task.* and module.* write tools.",
    agent: "Claude",
    module: "collab-infra",
    refs: [
      { ref_type: "file", ref_value: "internal-tools/collab-mcp/src/tools/add.ts" },
      { ref_type: "file", ref_value: "internal-tools/collab-mcp/src/tools/get.ts" },
      { ref_type: "file", ref_value: "internal-tools/collab-mcp/src/tools/list-recent.ts" },
    ],
  }).id
);

console.log(
  `[seed] inserted ${seeded.length} entries: ${seeded
    .map((id) => `E-${String(id).padStart(5, "0")}`)
    .join(", ")}`
);
closeDb();
