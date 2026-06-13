#!/usr/bin/env node
/**
 * Quick manual exercise of collab.search without starting the MCP server.
 * Seeds a few rows if the DB is empty, then runs three illustrative queries.
 *
 *   npm run test:search
 *
 * Safe to re-run — idempotent seed (uses INSERT OR IGNORE on titles).
 */
import { getDb, migrate, estimateTokens, closeDb } from "../db.js";
import { searchEntries } from "../tools/search.js";

const db = getDb();
migrate(db);

// ------------------------------------------------------------
// Seed (only if empty)
// ------------------------------------------------------------
const { n } = db.prepare("SELECT count(*) AS n FROM entries").get() as { n: number };
if (n === 0) {
  console.log("[seed] inserting 4 example entries...");
  const insert = db.prepare(`
    INSERT INTO entries (type, kind, title, summary, description, status, agent, module, task_id, tokens_estimate)
    VALUES (@type, @kind, @title, @summary, @description, @status, @agent, @module, @task_id, @tokens_estimate)
  `);

  const rows = [
    {
      type: "gotcha",
      kind: "signal",
      title: "Attendance join key is STRING not ObjectId",
      summary: "attendances.employeeId is a STRING (employee.employeeId), unlike all other collections.",
      description:
        "When joining attendances to employees you must match on the string employee code, not the Mongo ObjectId. " +
        "Easy mistake when replicating patterns from leaverequests/travelrequests.",
      status: "active",
      agent: "Claude",
      module: "custom-reports",
      task_id: null,
    },
    {
      type: "handoff",
      kind: "signal",
      title: "Timesheet approval date arrows wired",
      summary: "Prev/next arrows drive rangeMode; refresh resets to weekly. No backend changes.",
      description:
        "Updated <app-action-bar> in time-sheet-approval to emit onDatePrev/onDateNext. " +
        "Added rangeMode state, custom date path marks range as 'custom'. Reused existing getTimesheets() call.",
      status: "active",
      agent: "Codex",
      module: "timesheet",
      task_id: "T-007",
    },
    {
      type: "decision",
      kind: "signal",
      title: "Query strategy: hybrid $lookup + application join",
      summary: "Use $lookup for employee→related collection; app-level join for cross-collection filters.",
      description:
        "Avoids blowing out pipeline on 7 data domains while keeping decrypt step in application code.",
      status: "active",
      agent: "User",
      module: "custom-reports",
      task_id: null,
    },
    {
      type: "session-note",
      kind: "log",
      title: "2026-04-15 action-bar polish",
      summary: "Refined arrow alignment, fixed safari flex gap.",
      description: "No behavioral changes. CSS only.",
      status: "active",
      agent: "Claude",
      module: "action-bar",
      task_id: null,
    },
  ];

  for (const r of rows) {
    insert.run({ ...r, tokens_estimate: estimateTokens(r.description) });
  }
}

// ------------------------------------------------------------
// Three illustrative queries
// ------------------------------------------------------------
function show(label: string, result: ReturnType<typeof searchEntries>) {
  console.log(`\n=== ${label} ===`);
  console.log(`auto_expanded=${result.auto_expanded} total_tokens=${result.total_tokens} count=${result.results.length}`);
  for (const r of result.results) {
    console.log(`  [E-${String(r.id).padStart(5, "0")}] ${r.type} · ${r.title}`);
    console.log(`    summary: ${r.summary}`);
    if (r.description) console.log(`    body: ${r.description.slice(0, 120)}…`);
  }
}

// 1. Broad FTS — should return summaries only (count will be small here, but kind=signal hides session-notes).
show(
  "search 'employee' kind=signal",
  searchEntries(db, {
    query: "employee",
    kind: "signal",
    include_deprecated: false,
    limit: 10,
  })
);

// 2. Filter-only (empty query) scoped to a module — recent first.
show(
  "filter module=custom-reports since=30d",
  searchEntries(db, {
    query: "",
    module: "custom-reports",
    kind: "any",
    since: "30d",
    include_deprecated: false,
    limit: 10,
  })
);

// 3. Narrow FTS that should trigger auto-expand (few results, small bodies).
show(
  "search 'arrows timesheet' (auto-expand expected)",
  searchEntries(db, {
    query: "arrows timesheet",
    kind: "signal",
    include_deprecated: false,
    limit: 10,
  })
);

closeDb();
