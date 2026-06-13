#!/usr/bin/env node
/**
 * Collab v2 MCP server — stdio transport.
 * Phase 3: collab.search + collab.get + collab.add + collab.list_recent
 * against the sqlite-backed entries/refs/tasks/modules schema.
 *
 * Run:
 *   npm install
 *   npm run migrate
 *   npm run dev         # stdio server; pair with a client via .mcp.json
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, migrate } from "./db.js";
import { searchEntries } from "./tools/search.js";
import { addEntry } from "./tools/add.js";
import { updateEntry } from "./tools/update.js";
import { getEntry } from "./tools/get.js";
import { listRecent } from "./tools/list-recent.js";
import {
  createTask,
  transitionTask,
  assignTask,
  getTask,
  type TaskStatus,
  type Priority,
} from "./tools/task.js";
import { initModule, getModule } from "./tools/module.js";
import { ingestDraft } from "./tools/ingest.js";
import { rollup, archive } from "./tools/rollup.js";
import { supersede } from "./tools/supersede.js";
import { exportEntries } from "./tools/export.js";
import { doctor } from "./tools/doctor.js";
import { savingsReport, formatSavingsReport } from "./tools/savings.js";

// ------------------------------------------------------------
// Server boot
// ------------------------------------------------------------
const db = getDb();
const appliedMigrations = migrate(db);
if (appliedMigrations.length > 0) {
  console.error(`[collab-mcp] applied migrations: ${appliedMigrations.join(", ")}`);
}

const server = new McpServer({
  name: "collab",
  version: "0.2.0",
});

// MCP requires structuredContent to satisfy { [k: string]: unknown }.
// Our domain types are sealed interfaces, so widen at the boundary.
const structured = <T>(v: T): Record<string, unknown> =>
  v as unknown as Record<string, unknown>;

// ------------------------------------------------------------
// Shared zod enums
// ------------------------------------------------------------
const ENTRY_TYPE = z.enum([
  "handoff",
  "review",
  "proposal",
  "counter",
  "decision",
  "gotcha",
  "rollup",
  "session-note",
  "changelog",
]);
const AGENT = z.enum(["Claude", "Codex", "Gemini", "User"]);
const REF_TYPE = z.enum(["file", "task", "entry", "url"]);
const CATEGORY = z.enum(["Index", "Reference", "Activity"]);
const TASK_STATUS = z.enum(["pending", "assigned", "in-progress", "review", "done"]);
const PRIORITY = z.enum(["critical", "high", "medium", "low"]);

// ------------------------------------------------------------
// Tool: collab.search
// ------------------------------------------------------------
server.registerTool(
  "collab_search",
  {
    title: "Search collab entries",
    description: [
      "Full-text search across collab entries (handoffs, reviews, proposals, decisions, gotchas, rollups).",
      "Filter-first, search-second: prefer filters (module, task, since) over broad queries.",
      "Returns summaries only. Auto-expands descriptions when count <= 3 AND total tokens_estimate <= 1500.",
      "To fetch a single full body deliberately, use collab.get.",
      "",
      "Defaults:",
      "  - kind='signal' (log entries like session-notes hidden; pass kind='log' or 'any' to include)",
      "  - include_deprecated=false (rolled-up originals hidden)",
      "  - limit=10",
      "",
      "The 'since' param accepts ISO date or shorthand: '7d', '2w', '1m'.",
    ].join("\n"),
    inputSchema: {
      query: z
        .string()
        .describe("FTS5 query. Empty string = filter-only mode (no text matching)."),
      module: z.string().optional().describe("Module slug, e.g. 'timesheet'. Matched via entry_modules (multi-module aware)."),
      task: z.string().optional().describe("Task id, e.g. 'T-001'"),
      type: ENTRY_TYPE.optional(),
      category: CATEGORY.optional().describe("Lifecycle bucket: Index | Reference | Activity"),
      kind: z.enum(["signal", "log", "any"]).optional().default("signal"),
      status: z.enum(["draft", "active", "resolved", "deprecated"]).optional(),
      since: z
        .string()
        .optional()
        .describe("ISO date (2026-04-10) or shorthand (7d, 2w, 1m)"),
      include_deprecated: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = searchEntries(db, {
      query: args.query,
      module: args.module,
      task: args.task,
      type: args.type,
      category: args.category,
      kind: args.kind ?? "signal",
      status: args.status,
      since: args.since,
      include_deprecated: args.include_deprecated ?? false,
      limit: args.limit ?? 10,
    });
    return {
      content: [{ type: "text", text: formatSearchResult(result) }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.get
// ------------------------------------------------------------
server.registerTool(
  "collab_get",
  {
    title: "Get a full entry by id",
    description: [
      "Fetches the full body + refs for a single entry. This is the one 'expensive' read in the API.",
      "Use after collab.search or collab.list_recent has surfaced an id you want to read deliberately.",
    ].join("\n"),
    inputSchema: {
      id: z.number().int().min(1).describe("Entry id (the integer inside E-NNNNN)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const entry = getEntry(db, args.id);
    if (!entry) {
      return {
        content: [{ type: "text", text: `No entry found with id ${args.id}.` }],
        structuredContent: null as any,
      };
    }
    return {
      content: [{ type: "text", text: formatEntry(entry) }],
      structuredContent: entry,
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.list_recent
// ------------------------------------------------------------
server.registerTool(
  "collab_list_recent",
  {
    title: "List recent collab entries",
    description: [
      "Lists recent entries (most recent first) with optional filters.",
      "Equivalent to collab.search with an empty query: filter-only mode.",
      "Same auto-expand rule applies (count <= 3 AND total <= 1500 tokens -> bodies included).",
      "",
      "Defaults:",
      "  - since='7d' (last week)",
      "  - kind='signal' (logs hidden; pass kind='log' or 'any')",
      "  - limit=10",
    ].join("\n"),
    inputSchema: {
      type: ENTRY_TYPE.optional(),
      module: z.string().optional(),
      task: z.string().optional(),
      category: CATEGORY.optional().describe("Lifecycle bucket: Index | Reference | Activity"),
      since: z.string().optional().default("7d"),
      limit: z.number().int().min(1).max(50).optional().default(10),
      kind: z.enum(["signal", "log", "any"]).optional().default("signal"),
      include_deprecated: z.boolean().optional().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = listRecent(db, {
      type: args.type,
      module: args.module,
      task: args.task,
      category: args.category,
      since: args.since,
      limit: args.limit,
      kind: args.kind,
      include_deprecated: args.include_deprecated,
    });
    return {
      content: [{ type: "text", text: formatSearchResult(result) }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.add
// ------------------------------------------------------------
server.registerTool(
  "collab_add",
  {
    title: "Add a collab entry",
    description: [
      "Append a new entry (handoff, review, proposal, counter, decision, gotcha, session-note, changelog).",
      "Rollup entries are system-generated - do not create them here.",
      "",
      "The 'kind' (signal vs log) is derived from 'type' - you never pass it.",
      "The 'tokens_estimate' is computed server-side from description length.",
      "The 'summary' must be <= 200 characters.",
      "",
      "'category' (Index|Reference|Activity) is the lifecycle/retrieval bucket. If omitted it is",
      "derived: decision/gotcha -> Reference; everything else -> Activity. Set 'Index' explicitly",
      "for navigation hubs. 'module' is the PRIMARY module; pass 'modules' for additional ones",
      "(many-to-many) — an entry then surfaces in every module it belongs to.",
      "",
      "Refs are optional. Each ref is {ref_type: 'file'|'task'|'entry'|'url', ref_value: string}.",
      "For files, ref_value is the repo-relative path.",
    ].join("\n"),
    inputSchema: {
      type: ENTRY_TYPE.describe("Entry type. 'rollup' is rejected - use collab.rollup instead."),
      title: z.string().min(1),
      summary: z.string().min(1).max(200),
      description: z.string().optional(),
      status: z.enum(["draft", "active"]).optional(),
      agent: AGENT.optional(),
      module: z.string().optional().describe("PRIMARY module slug (written to entries.module for back-compat)."),
      modules: z.array(z.string()).optional().describe("Additional module slugs; many-to-many via entry_modules."),
      category: CATEGORY.optional().describe("Index | Reference | Activity. Omitted -> derived from type."),
      task_id: z.string().optional(),
      refs: z
        .array(z.object({ ref_type: REF_TYPE, ref_value: z.string().min(1) }))
        .optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = addEntry(db, {
      type: args.type,
      title: args.title,
      summary: args.summary,
      description: args.description,
      status: args.status,
      agent: args.agent,
      module: args.module,
      modules: args.modules,
      category: args.category,
      task_id: args.task_id,
      refs: args.refs,
    });
    const tt = result.taskTransition;
    const text = tt
      ? `Added E-${String(result.id).padStart(5, "0")} (${args.type}). `
        + `Auto-advanced ${tt.id}: ${tt.from} -> ${tt.to}.`
      : `Added E-${String(result.id).padStart(5, "0")} (${args.type}).`;
    return {
      content: [{ type: "text", text }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.update
// ------------------------------------------------------------
server.registerTool(
  "collab_update",
  {
    title: "Edit an existing collab entry",
    description: [
      "Edits an existing entry's title/summary/description in place (by id).",
      "Use to CORRECT or CLARIFY durable entries (decisions, gotchas) — not to churn them.",
      "",
      "Provide at least one of title/summary/description. Omitted fields are left untouched.",
      "The 'summary' must be <= 200 characters. 'tokens_estimate' is recomputed when description changes.",
      "The FTS search index and updated_at are kept consistent automatically.",
      "",
      "Refs are NOT mutated here (future extension). To deprecate/roll up instead, use collab.rollup.",
    ].join("\n"),
    inputSchema: {
      id: z.number().int().min(1).describe("Entry id (the integer inside E-NNNNN)"),
      title: z.string().min(1).optional(),
      summary: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = updateEntry(db, {
      id: args.id,
      title: args.title,
      summary: args.summary,
      description: args.description,
    });
    return {
      content: [
        {
          type: "text",
          text: `Updated E-${String(result.id).padStart(5, "0")} (${result.updated_fields.join(", ")}).`,
        },
      ],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.task.create
// ------------------------------------------------------------
server.registerTool(
  "collab_task_create",
  {
    title: "Create a task",
    description: [
      "Creates a new task row with an auto-generated id (T-NNN).",
      "If assignee is provided, the task starts in 'assigned' state; otherwise 'pending'.",
      "Summary must be <= 200 characters.",
    ].join("\n"),
    inputSchema: {
      title: z.string().min(1),
      summary: z.string().max(200).optional(),
      description: z.string().optional(),
      priority: PRIORITY.optional(),
      module: z.string().optional(),
      assignee: AGENT.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = createTask(db, {
      title: args.title,
      summary: args.summary,
      description: args.description,
      priority: args.priority,
      module: args.module,
      assignee: args.assignee,
    });
    return {
      content: [{ type: "text", text: `Created ${result.id}.` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.task.transition
// ------------------------------------------------------------
server.registerTool(
  "collab_task_transition",
  {
    title: "Transition a task to a new status",
    description: [
      "Moves a task to a new status, enforcing the state machine from DESIGN.md §5.",
      "Legal transitions:",
      "  pending -> assigned | in-progress",
      "  assigned -> in-progress | pending",
      "  in-progress -> review | pending",
      "  review -> in-progress | done | pending",
      "  done -> pending (reset only)",
      "",
      "When a task transitions to 'done', the server cascades status='resolved'",
      "to all active handoffs and reviews linked to that task.",
    ].join("\n"),
    inputSchema: {
      id: z.string().describe("Task id, e.g. 'T-001'"),
      status: TASK_STATUS,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = transitionTask(db, args.id, args.status as TaskStatus);
    return {
      content: [{ type: "text", text: `${result.id} -> ${result.status}.` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.task.assign
// ------------------------------------------------------------
server.registerTool(
  "collab_task_assign",
  {
    title: "Assign a task to an agent",
    description: [
      "Sets the task's assignee. If the task is currently 'pending', also transitions it to 'assigned'.",
      "Does not enforce anything else about the state machine (use task.transition for that).",
    ].join("\n"),
    inputSchema: {
      id: z.string().describe("Task id, e.g. 'T-001'"),
      agent: AGENT,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = assignTask(db, args.id, args.agent);
    return {
      content: [{ type: "text", text: `${result.id} assigned to ${result.assignee}.` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.task.get
// ------------------------------------------------------------
server.registerTool(
  "collab_task_get",
  {
    title: "Get a task and its recent entries",
    description: [
      "Fetches a task row plus up to 10 most recent non-deprecated entries linked to it.",
      "Returns task=null if not found.",
    ].join("\n"),
    inputSchema: {
      id: z.string().describe("Task id, e.g. 'T-001'"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = getTask(db, args.id);
    if (!result.task) {
      return {
        content: [{ type: "text", text: `No task found with id ${args.id}.` }],
        structuredContent: structured(result),
      };
    }
    const header = `[${result.task.id}] ${result.task.title}`;
    const meta = [
      `status=${result.task.status}`,
      result.task.assignee ? `assignee=${result.task.assignee}` : null,
      result.task.priority ? `priority=${result.task.priority}` : null,
      result.task.module ? `module=${result.task.module}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const entries =
      result.recent_entries.length > 0
        ? "\n\nRecent entries:\n" +
          result.recent_entries
            .map(
              (e) =>
                `  [E-${String(e.id).padStart(5, "0")}] ${e.type} - ${e.title}`
            )
            .join("\n")
        : "";
    return {
      content: [{ type: "text", text: `${header}\n  ${meta}${entries}` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.module.init
// ------------------------------------------------------------
server.registerTool(
  "collab_module_init",
  {
    title: "Initialize (or upsert-ignore) a module row",
    description: [
      "Creates a module row. Idempotent: if the slug already exists, this is a no-op.",
      "Slug rules: lowercase alphanumeric + hyphens, 1-60 chars, no underscores,",
      "must start with an alphanumeric character.",
    ].join("\n"),
    inputSchema: {
      slug: z.string().min(1).max(60),
      name: z.string().optional(),
      summary: z.string().optional(),
      description: z.string().optional(),
      current_goal: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = initModule(db, {
      slug: args.slug,
      name: args.name,
      summary: args.summary,
      description: args.description,
      current_goal: args.current_goal,
    });
    return {
      content: [{ type: "text", text: `Module '${result.slug}' ready.` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.module.get
// ------------------------------------------------------------
server.registerTool(
  "collab_module_get",
  {
    title: "Get a module card (module row + tasks + recent signals)",
    description: [
      "Returns: {module, active_tasks, indexes, recent_decisions, top_gotchas, recent_handoffs}.",
      "If the slug is unknown, module is null and all other fields are empty arrays.",
      "Membership is multi-module aware (entry_modules): an entry surfaces here if it belongs to this module.",
      "Ordering: active_tasks by priority then recency; Index hubs first among knowledge sections, others by created_at DESC.",
    ].join("\n"),
    inputSchema: {
      slug: z.string().min(1),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = getModule(db, args.slug);
    if (!result.module) {
      return {
        content: [
          {
            type: "text",
            text: `Module '${args.slug}' not found. Create it with collab.module.init.`,
          },
        ],
        structuredContent: structured(result),
      };
    }
    const lines: string[] = [];
    lines.push(`[module] ${result.module.slug}${result.module.name ? ` (${result.module.name})` : ""}`);
    if (result.module.current_goal) lines.push(`  goal: ${result.module.current_goal}`);
    if (result.module.summary) lines.push(`  summary: ${result.module.summary}`);
    if (result.active_tasks.length > 0) {
      lines.push("\nActive tasks:");
      for (const t of result.active_tasks) {
        lines.push(`  [${t.id}] ${t.status}${t.priority ? ` (${t.priority})` : ""} - ${t.title}`);
      }
    }
    if (result.indexes.length > 0) {
      lines.push("\nIndexes:");
      for (const ix of result.indexes) {
        lines.push(`  [E-${String(ix.id).padStart(5, "0")}] ${ix.title}`);
      }
    }
    if (result.top_gotchas.length > 0) {
      lines.push("\nTop gotchas:");
      for (const g of result.top_gotchas) {
        lines.push(`  [E-${String(g.id).padStart(5, "0")}] ${g.summary}`);
      }
    }
    if (result.recent_decisions.length > 0) {
      lines.push("\nRecent decisions:");
      for (const d of result.recent_decisions) {
        lines.push(`  [E-${String(d.id).padStart(5, "0")}] ${d.title}`);
      }
    }
    if (result.recent_handoffs.length > 0) {
      lines.push("\nRecent handoffs:");
      for (const h of result.recent_handoffs) {
        lines.push(`  [E-${String(h.id).padStart(5, "0")}] ${h.agent ?? "?"} - ${h.title}`);
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.ingest
// ------------------------------------------------------------
server.registerTool(
  "collab_ingest",
  {
    title: "Shape a raw blob into a draft entry (does NOT save)",
    description: [
      "Takes raw_text (e.g. Codex agent output) plus optional context and returns a proposed",
      "draft_entry + confidence. The caller reviews/edits the draft, then calls collab.add",
      "to persist it. This is the seam the dispatch pipeline uses before auto-saving.",
      "",
      "source values: codex-dispatch | codex-review | manual | session-end",
    ].join("\n"),
    inputSchema: {
      source: z.enum(["codex-dispatch", "codex-review", "manual", "session-end"]),
      raw_text: z.string().min(1),
      context: z
        .object({
          task_id: z.string().optional(),
          module: z.string().optional(),
          agent: AGENT.optional(),
          changed_files: z.array(z.string()).optional(),
          type_hint: ENTRY_TYPE.optional(),
        })
        .optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = ingestDraft(db, {
      source: args.source,
      raw_text: args.raw_text,
      context: args.context,
    });
    const d = result.draft_entry;
    const lines: string[] = [];
    lines.push(`[draft] ${d.type} - ${d.title}`);
    lines.push(`  confidence: ${result.confidence} | tokens~${d.tokens_estimate}`);
    if (d.module) lines.push(`  module=${d.module}`);
    if (d.task_id) lines.push(`  task=${d.task_id}`);
    if (d.agent) lines.push(`  agent=${d.agent}`);
    lines.push("");
    lines.push(`  ${d.summary}`);
    if (d.refs && d.refs.length > 0) {
      lines.push("\nRefs:");
      for (const r of d.refs) lines.push(`  - ${r.ref_type}: ${r.ref_value}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.rollup
// ------------------------------------------------------------
server.registerTool(
  "collab_rollup",
  {
    title: "Create rollups for recent entries",
    description: [
      "Creates new 'rollup' entries that summarize multiple existing entries, and marks the originals as deprecated.",
      "Use task_id to roll up one task, OR since+group_by to roll up across modules/tasks over a time window.",
      "Set dry_run=true to preview groups without writing.",
      "",
      "The 'since' param accepts ISO date or shorthand: '7d', '2w', '1m'.",
    ].join("\n"),
    inputSchema: {
      task_id: z.string().optional(),
      since: z.string().optional().describe("ISO date or '7d'/'2w'/'1m'"),
      group_by: z
        .enum(["module", "task"])
        .optional()
        .describe("required when 'since' is set"),
      agent: AGENT.optional(),
      dry_run: z.boolean().optional().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = rollup(db, args);
    const text =
      result.groups.length === 0
        ? "No entries matched — nothing to roll up."
        : `Rollup created ${result.created_entries.length} entries across ${result.groups.length} groups, deprecated ${result.deprecated_count} originals (dry_run=${args.dry_run ?? false}).`;
    return {
      content: [{ type: "text", text }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.archive
// ------------------------------------------------------------
server.registerTool(
  "collab_archive",
  {
    title: "Archive stale ephemeral entries (handoffs/reviews)",
    description: [
      "Type-aware cleanup: deprecates STALE, point-in-time signal entries and leaves one rollup",
      "breadcrumb per module. Use this to keep search clean — handoffs/reviews pile up and age out.",
      "",
      "Selects: status='active' AND deprecated=0 AND category='Activity' AND created_at OLDER than 'older_than'.",
      "Lifecycle is governed by CATEGORY (Index/Reference/Activity): only the Activity work-trail is archivable;",
      "Index hubs and Reference (decisions/gotchas/canonical) are never in scope.",
      "Note the inverted age vs collab.rollup: rollup groups entries SINCE a cutoff; archive targets entries OLDER than it.",
      "",
      "SAFETY:",
      "  - dry_run defaults to TRUE — preview the groups before anything is deprecated. Pass dry_run=false to commit.",
      "  - Belt-and-suspenders: the protected types {decision, gotcha, rollup, proposal, counter} are excluded in SQL",
      "    too, so a mis-categorized canonical entry can never be archived through this tool.",
      "  - 'types' is an OPTIONAL narrowing within Activity (e.g. ['handoff']); omit it to archive all Activity types.",
      "  - Deprecated entries stay searchable with include_deprecated=true; nothing is hard-deleted.",
      "",
      "The 'older_than' param accepts ISO date or shorthand: '7d', '2w', '1m' (default '30d').",
    ].join("\n"),
    inputSchema: {
      older_than: z
        .string()
        .optional()
        .describe("Entries OLDER than this are archived. ISO date or '7d'/'2w'/'1m'. Default '30d'."),
      types: z
        .array(ENTRY_TYPE)
        .optional()
        .describe("Allowlist of types to archive. Default [handoff, review]. Protected types are always excluded."),
      module: z.string().optional().describe("Scope to a single module slug."),
      agent: AGENT.optional(),
      dry_run: z.boolean().optional().default(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = archive(db, {
      older_than: args.older_than,
      types: args.types,
      module: args.module,
      agent: args.agent,
      dry_run: args.dry_run,
    });
    const totalEntries = result.groups.reduce((n, g) => n + g.entry_ids.length, 0);
    const text = result.groups.length === 0
      ? "No stale entries matched — nothing to archive."
      : result.dry_run
        ? `DRY RUN: would archive ${totalEntries} entr(ies) across ${result.groups.length} module group(s): `
          + result.groups.map((g) => `${g.key}(${g.entry_ids.length})`).join(", ")
          + ". Re-run with dry_run=false to commit."
        : `Archived ${result.deprecated_count} entr(ies) into ${result.created_entries.length} rollup breadcrumb(s).`;
    return {
      content: [{ type: "text", text }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.supersede
// ------------------------------------------------------------
server.registerTool(
  "collab_supersede",
  {
    title: "Supersede entries with a replacement",
    description: [
      "Marks one or more entries as replaced by a newer entry.",
      "For each id: sets superseded_by = by AND deprecated = 1, so the originals drop out of",
      "default retrieval (include_deprecated=false hides them) but remain as history.",
      "",
      "Validation: 'by' must exist and must NOT appear in 'ids'; every id in 'ids' must exist.",
    ].join("\n"),
    inputSchema: {
      ids: z
        .array(z.number().int().min(1))
        .min(1)
        .describe("Entry ids being replaced (the integers inside E-NNNNN)."),
      by: z.number().int().min(1).describe("The entry id that replaces them."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = supersede(db, { ids: args.ids, by: args.by });
    const supersededIds = result.superseded
      .map((id) => `E-${String(id).padStart(5, "0")}`)
      .join(", ");
    const byId = `E-${String(result.by).padStart(5, "0")}`;
    return {
      content: [{ type: "text", text: `Superseded ${supersededIds} → replaced by ${byId}.` }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.export
// ------------------------------------------------------------
server.registerTool(
  "collab_export",
  {
    title: "Export entries + refs",
    description: [
      "Exports entries + refs to a single JSON or Markdown string.",
      "Returns exported text in the 'body' field; the caller writes it to disk if needed.",
      "",
      "The 'since' param accepts ISO date or shorthand: '7d', '2w', '1m'.",
    ].join("\n"),
    inputSchema: {
      format: z.enum(["json", "markdown"]),
      module: z.string().optional(),
      task: z.string().optional(),
      type: ENTRY_TYPE.optional(),
      since: z.string().optional(),
      include_deprecated: z.boolean().optional().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = exportEntries(db, args);
    return {
      content: [{ type: "text", text: result.body }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.doctor
// ------------------------------------------------------------
server.registerTool(
  "collab_doctor",
  {
    title: "Check schema + data integrity",
    description: [
      "Runs lightweight schema and data integrity checks against the collab sqlite database.",
      "Useful after migrations or when troubleshooting missing FTS rows / orphan refs.",
    ].join("\n"),
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const result = doctor(db);
    const lines: string[] = [];
    for (const c of result.checks) {
      lines.push(`[${c.severity}] ${c.name} — ${c.detail}`);
      if (c.items && c.items.length > 0) {
        const shown = c.items.slice(0, 10).map((x) => String(x));
        const more = c.items.length - shown.length;
        lines.push(`  ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
      }
    }
    lines.push(result.ok ? "Overall: ok" : "Overall: has errors");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.savings_report
// ------------------------------------------------------------
server.registerTool(
  "collab_savings_report",
  {
    title: "Report token savings from dispatches",
    description: [
      "Aggregates the dispatches table to show how many tokens were displaced from",
      "Claude's window by sending work to Codex/Gemini.",
      "",
      "Headline metric (B): net = SUM(output_tokens) - SUM(prompt_tokens_est).",
      "Also shown (A): output_tokens alone (overstates, but quotable).",
      "",
      "Defaults: since=all, group_by='none' (single 'totals' bucket).",
      "The 'since' param accepts ISO date or shorthand: '7d', '2w', '1m'.",
    ].join("\n"),
    inputSchema: {
      since: z.string().optional().describe("ISO date or '7d'/'2w'/'1m'"),
      group_by: z
        .enum(["day", "module", "agent", "none"])
        .optional()
        .default("none"),
      agent: z.enum(["Codex", "Gemini"]).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = savingsReport(db, args);
    return {
      content: [{ type: "text", text: formatSavingsReport(result) }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Formatters
// ------------------------------------------------------------
function formatSearchResult(r: { results: any[]; auto_expanded: boolean; total_tokens: number }): string {
  if (r.results.length === 0) return "No entries matched.";
  const header = r.auto_expanded
    ? `Found ${r.results.length} result(s) - auto-expanded (${r.total_tokens} tokens).`
    : `Found ${r.results.length} result(s) - summaries only. Call collab.get(id) for full bodies.`;
  const lines = r.results.map((e) => {
    const head = `[E-${String(e.id).padStart(5, "0")}] ${e.type} - ${e.title}`;
    const body = r.auto_expanded && e.description
      ? `  ${e.summary}\n  ---\n  ${e.description.slice(0, 800)}${e.description.length > 800 ? "..." : ""}`
      : `  ${e.summary}`;
    return `${head}\n${body}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

function formatEntry(e: {
  id: number; type: string; title: string; summary: string;
  description: string | null; status: string; agent: string | null;
  module: string | null; modules?: string[]; category?: string;
  superseded_by?: number | null; task_id: string | null;
  tokens_estimate: number; created_at: string;
  refs: Array<{ ref_type: string; ref_value: string }>;
}): string {
  const head = `[E-${String(e.id).padStart(5, "0")}] ${e.type} - ${e.title}`;
  const moduleBit =
    e.modules && e.modules.length > 0
      ? `modules=${e.modules.join(",")}`
      : e.module
        ? `module=${e.module}`
        : null;
  const metaBits = [
    e.category ? `category=${e.category}` : null,
    moduleBit,
    e.task_id ? `task=${e.task_id}` : null,
    e.agent ? `agent=${e.agent}` : null,
    `status=${e.status}`,
    e.superseded_by != null ? `superseded by E-${String(e.superseded_by).padStart(5, "0")}` : null,
    `tokens~${e.tokens_estimate}`,
    `created=${e.created_at}`,
  ].filter(Boolean);
  const meta = metaBits.join(" | ");
  const body = e.description ?? "(no description)";
  const refs = e.refs.length
    ? "\n\nRefs:\n" + e.refs.map((r) => `  - ${r.ref_type}: ${r.ref_value}`).join("\n")
    : "";
  return `${head}\n  ${meta}\n\n  ${e.summary}\n  ---\n${body}${refs}`;
}

// ------------------------------------------------------------
// Transport
// ------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[collab-mcp] ready on stdio");
