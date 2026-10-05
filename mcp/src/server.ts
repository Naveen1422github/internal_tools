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
import {
  getDb,
  migrate,
  searchEntries,
  addEntry,
  addEntryAsync,
  updateEntry,
  updateEntryRefs,
  getEntry,
  listRecent,
  createTask,
  transitionTask,
  assignTask,
  getTask,
  searchTasks,
  updateTask,
  type TaskStatus,
  type Priority,
  initModule,
  getModule,
  getHubStatus,
  setModuleHub,
  ingestDraft,
  rollup,
  archive,
  supersede,
  exportEntries,
  doctor,
  savingsReport,
  formatSavingsReport,
  startupProblem,
  runSetupDoctor,
  formatSetupReport,
  startHeartbeat,
  runtimeDirFor,
  readBuildInfo,
  lastResolution,
  type DB,
  formatEntryRef,
  formatNoteRef,
  parseNoteRef,
  getEntryByRef,
  currentProject,
  type NoteRef,
} from "@collab-mcp/core";

// ------------------------------------------------------------
// Server boot (spec P12): a setup problem starts the server DEGRADED instead
// of exiting, because Claude Code shows an exited server only as "failed" and
// never shows its stderr. Every tool then answers with the doctor sentence.
// ------------------------------------------------------------
const problem = await startupProblem();
let db!: DB;
let degradedText: string | null = null;
if (problem) {
  degradedText = `collab can't work yet: ${problem.text}.${problem.fix ? ` Fix: ${problem.fix}` : ""} (Run collab_doctor for the full report.)`;
} else {
  try {
    db = getDb();
    const appliedMigrations = migrate(db);
    if (appliedMigrations.length > 0) {
      console.error(`[collab-mcp] applied migrations: ${appliedMigrations.join(", ")}`);
    }
  } catch (e) {
    degradedText = `collab can't open its notebook: ${(e as Error).message.replace(/^\[collab(-mcp)?\] /, "")}`;
  }
}

const server = new McpServer({
  name: "collab",
  version: "0.2.0",
});

if (degradedText) {
  console.error(`[collab-mcp] DEGRADED: ${degradedText}`);
  const register = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, _handler: unknown) =>
    register(name, config, async () =>
      name === "collab_doctor"
        ? { content: [{ type: "text" as const, text: formatSetupReport(await runSetupDoctor()) }] }
        : { content: [{ type: "text" as const, text: degradedText! }], isError: true });
} else {
  const r = lastResolution()!;
  const { version, build } = readBuildInfo();
  startHeartbeat(runtimeDirFor(r), { program: "mcp", version, build, dbPath: r.path, notebook: r.name });
}

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
// Note references and the current project (piece 2 stage B1)
// ------------------------------------------------------------
// A note number: an integer means the E series (E-00760); a string can name a
// project note ("SH-12") or any E form ("E-00760", "#760", "760").
const NOTE_REF = z.union([z.number().int().min(1), z.string()]);
const REF_FORMS = "760 (= E-00760), #760, E-760, E-00760, or a project note like SH-12";

/** A tool's note argument -> { series, id }; an unreadable string is a tool error naming the accepted forms. */
function resolveRefArg(v: number | string): NoteRef {
  if (typeof v === "number") return { series: "E", id: v };
  const r = parseNoteRef(v);
  if (!r) throw new Error(`"${v}" is not a note number. Accepted: ${REF_FORMS}.`);
  return r;
}

/** Spec rule 8: every write and search answer says which project it worked in. */
function statusLine(): string {
  const p = currentProject(db);
  return p ? `project: ${p.code} ${p.name} (${p.mode})` : "project: none (E series)";
}

const SCOPE = z
  .enum(["project", "all"])
  .optional()
  .describe("'project' (default when this folder's .collab names a project): only that project's notes. 'all': every note.");

/** The project filter for a read: the current project unless scope is 'all' (spec P4). No project = today's behaviour. */
function projectScope(scope: "project" | "all" | undefined): string | undefined {
  if (scope === "all") return undefined;
  return currentProject(db)?.ulid;
}

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
      scope: SCOPE,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const status = statusLine();
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
      project_ulid: projectScope(args.scope),
    });
    // Tasks live in their own table (not entries_fts), so a keyword search would
    // otherwise miss them. When there's a real query, surface matching tasks as a
    // side-array so "search collab for X" finds the task about X too. Only added
    // when non-empty, so the entries-only result shape is unchanged otherwise.
    const out: Record<string, unknown> = { ...result };
    let taskNote = "";
    if (args.query && args.query.trim().length > 0) {
      const t = searchTasks(db, { query: args.query, module: args.module, limit: 5 });
      if (t.results.length > 0) {
        out.tasks = t.results;
        taskNote = "\n\n" + formatTaskMatches(t.results);
      }
    }
    return {
      content: [{ type: "text", text: `${status}\n${formatSearchResult(result)}${taskNote}` }],
      structuredContent: structured(out),
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
      id: NOTE_REF.describe("Note number: an integer (the one inside E-NNNNN), or a reference like 'SH-12' / 'E-00760'"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const ref = resolveRefArg(args.id);
    const entry = getEntryByRef(db, ref);
    if (!entry) {
      return {
        content: [{ type: "text", text: `No entry found with id ${ref.series === "E" ? ref.id : formatNoteRef(ref)}.` }],
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
      scope: SCOPE,
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
      project_ulid: projectScope(args.scope),
    });
    return {
      content: [{ type: "text", text: `${statusLine()}\n${formatSearchResult(result)}` }],
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
      project: z
        .string()
        .optional()
        .describe("Project code (SH) or ULID to write into; 'none' = no project (E series). Omitted = this folder's .collab project."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = await addEntryAsync(db, {
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
      project: args.project,
    });
    const tt = result.taskTransition;
    const added = formatEntryRef(result.id, result.series);
    const status = result.project
      ? `project: ${result.project.code} ${result.project.name} (${result.project.mode})`
      : "project: none (E series)";
    let text = tt
      ? `${status}\nAdded ${added} (${args.type}). `
        + `Auto-advanced ${tt.id}: ${tt.from} -> ${tt.to}.`
      : `${status}\nAdded ${added} (${args.type}).`;
    // E-657 guardrail: tell the writing agent where its module's main note is,
    // only for important types (the hub must not become a dump).
    if (args.module && ["decision", "proposal", "gotcha"].includes(args.type)) {
      const hs = getHubStatus(db, args.module, 0);
      if (hs.state === "ok") {
        const h = hs.coverage!.hub;
        const hubRef = h.series ? formatEntryRef(h.id, h.series) : String(h.id);
        const newRef = result.series === "E" ? String(result.id) : added;
        text += ` Main note for '${args.module}' is ${formatEntryRef(h.id, h.series)}; `
          + `if this belongs in it, link it with collab_update_refs (id ${hubRef}, add entry '${newRef}').`;
      }
    }
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
      id: NOTE_REF.describe("Note number: an integer (the one inside E-NNNNN), or a reference like 'SH-12'"),
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
    const ref = resolveRefArg(args.id);
    const result = updateEntry(db, {
      id: ref.id,
      series: ref.series,
      title: args.title,
      summary: args.summary,
      description: args.description,
    });
    return {
      content: [
        {
          type: "text",
          text: `Updated ${formatEntryRef(result.id, ref.series)} (${result.updated_fields.join(", ")}).`,
        },
      ],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.update_refs
// ------------------------------------------------------------
server.registerTool(
  "collab_update_refs",
  {
    title: "Add / remove refs on an existing entry",
    description: [
      "Mutates the structured refs (links) of an existing entry — the one thing collab.add",
      "sets once and collab.update cannot touch. Use to wire a link AFTER creation, e.g. link",
      "a new decision into the roadmap/Index hub it extends, instead of a prose mention.",
      "",
      "Provide 'add' and/or 'remove' arrays of {ref_type, ref_value}. Idempotent: re-adding an",
      "existing ref or removing a missing one is a no-op. The response lists what ACTUALLY changed.",
      "Each ref is {ref_type: 'file'|'task'|'entry'|'url', ref_value: string}. For an entry link,",
      "ref_type='entry' and ref_value is the target note's number as a string (e.g. '304' for E-00304, or 'SH-12').",
    ].join("\n"),
    inputSchema: {
      id: NOTE_REF.describe("Note whose refs to mutate: an integer (the one inside E-NNNNN), or a reference like 'SH-12'."),
      add: z
        .array(z.object({ ref_type: REF_TYPE, ref_value: z.string().min(1) }))
        .optional()
        .describe("Refs to add (INSERT OR IGNORE)."),
      remove: z
        .array(z.object({ ref_type: REF_TYPE, ref_value: z.string().min(1) }))
        .optional()
        .describe("Refs to remove (DELETE)."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const ref = resolveRefArg(args.id);
    const result = updateEntryRefs(db, { id: ref.id, series: ref.series, add: args.add, remove: args.remove });
    const parts: string[] = [];
    if (result.added.length > 0) {
      parts.push(`+${result.added.map((r) => `${r.ref_type}:${r.ref_value}`).join(", ")}`);
    }
    if (result.removed.length > 0) {
      parts.push(`-${result.removed.map((r) => `${r.ref_type}:${r.ref_value}`).join(", ")}`);
    }
    const change = parts.length > 0 ? parts.join(" | ") : "no change (all no-ops)";
    return {
      content: [
        { type: "text", text: `${formatEntryRef(result.id, ref.series)} refs: ${change}.` },
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
                `  [${formatEntryRef(e.id, e.series)}] ${e.type} - ${e.title}`
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
// Tool: collab.task.list
// ------------------------------------------------------------
server.registerTool(
  "collab_task_list",
  {
    title: "List / search tasks",
    description: [
      "Lists tasks with optional keyword match + filters. Fills the gap where collab.search",
      "(which only covers entries) cannot find tasks: tasks live in their own table.",
      "",
      "'query' matches over task title/summary/description (tokenized; multi-word recalls).",
      "Omit 'query' to browse recent tasks. Filter by module/status/assignee. Ordered by",
      "most-recently-updated. Returns summaries; use collab.task.get for a task's full body + entries.",
    ].join("\n"),
    inputSchema: {
      query: z.string().optional().describe("Keyword match over title/summary/description. Omit to list all."),
      module: z.string().optional(),
      status: TASK_STATUS.optional(),
      assignee: AGENT.optional(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = searchTasks(db, {
      query: args.query,
      module: args.module,
      status: args.status as TaskStatus | undefined,
      assignee: args.assignee,
      limit: args.limit,
    });
    const text =
      result.results.length === 0
        ? "No tasks matched."
        : `Found ${result.results.length} task(s):\n` +
          result.results
            .map(
              (t) =>
                `  [${t.id}] ${t.status}${t.priority ? ` (${t.priority})` : ""}` +
                `${t.module ? ` {${t.module}}` : ""} - ${t.title}`
            )
            .join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.task.update
// ------------------------------------------------------------
server.registerTool(
  "collab_task_update",
  {
    title: "Edit a task's content fields",
    description: [
      "Edits a task's title/summary/description/priority/module in place (by id).",
      "",
      "Status is NOT editable here — use collab.task.transition, which enforces the state machine.",
      "Provide at least one field; omitted fields are left untouched. 'summary' must be <= 200 chars.",
      "updated_at is refreshed automatically.",
    ].join("\n"),
    inputSchema: {
      id: z.string().describe("Task id, e.g. 'T-001'"),
      title: z.string().min(1).optional(),
      summary: z.string().max(200).optional(),
      description: z.string().optional(),
      priority: PRIORITY.optional(),
      module: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = updateTask(db, {
      id: args.id,
      title: args.title,
      summary: args.summary,
      description: args.description,
      priority: args.priority as Priority | undefined,
      module: args.module,
    });
    return {
      content: [
        { type: "text", text: `Updated ${result.id} (${result.updated_fields.join(", ")}).` },
      ],
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
      "Returns: {module, active_tasks, indexes, recent_decisions, top_gotchas, recent_handoffs, hub}.",
      "If the slug is unknown, module is null and all other fields are empty arrays.",
      "Membership is multi-module aware (entry_modules): an entry surfaces here if it belongs to this module.",
      "Ordering: active_tasks by priority then recency; Index hubs first among knowledge sections, others by created_at DESC.",
    ].join("\n"),
    inputSchema: {
      slug: z.string().min(1),
      scope: SCOPE,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = getModule(db, args.slug, { project_ulid: projectScope(args.scope) });
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
    const cut = (s: string) => (s.length > 80 ? s.slice(0, 79) + "…" : s);
    if (result.hub.state === "unset") {
      lines.push("\nMain note: not set (collab_module_set_hub picks one).");
    } else if (result.hub.state === "retired") {
      lines.push("\nMain note: retired with no replacement (collab_module_set_hub picks a new one).");
    } else {
      const c = result.hub.coverage!;
      lines.push(`\nMain note: [${formatEntryRef(c.hub.id, c.hub.series)}] ${cut(c.hub.title)}${c.hub.followed ? " (replacement of the original)" : ""}`);
      if (c.unlinked_count === 0) {
        lines.push(`  reaches all ${c.linked_count} important notes.`);
      } else {
        lines.push(`  reaches ${c.linked_count} of ${c.linked_count + c.unlinked_count} important notes; ${c.unlinked_count} not linked yet${c.unlinked.length > 0 ? ":" : "."}`);
        for (const u of c.unlinked) lines.push(`    [${formatEntryRef(u.id, u.series)}] ${u.type} - ${cut(u.title)}`);
        const onCard = c.unlinked_on_card ?? [];
        if (onCard.length > 0) lines.push(`    also not linked (in the lists below): ${onCard.map((id) => formatEntryRef(id)).join(", ")}`);
        const shown = c.unlinked.length + onCard.length;
        if (c.unlinked_count > shown) lines.push(`    (+${c.unlinked_count - shown} more; collab_doctor lists all)`);
      }
      if (c.expired.length > 0) lines.push(`  ${c.expired.length} link(s) point at retired notes (ignored; collab_doctor lists them).`);
    }
    if (result.hub.state !== "ok") {
      if (result.indexes.length > 0) {
        lines.push("\nIndexes:");
        for (const ix of result.indexes) {
          lines.push(`  [${formatEntryRef(ix.id)}] ${ix.title}`);
        }
      }
    }
    if (result.top_gotchas.length > 0) {
      lines.push("\nTop gotchas:");
      for (const g of result.top_gotchas) {
        lines.push(`  [${formatEntryRef(g.id, g.series)}] ${g.summary}`);
      }
    }
    if (result.recent_decisions.length > 0) {
      lines.push("\nRecent decisions:");
      for (const d of result.recent_decisions) {
        lines.push(`  [${formatEntryRef(d.id, d.series)}] ${d.title}`);
      }
    }
    if (result.recent_handoffs.length > 0) {
      lines.push("\nRecent handoffs:");
      for (const h of result.recent_handoffs) {
        lines.push(`  [${formatEntryRef(h.id, h.series)}] ${h.agent ?? "?"} - ${h.title}`);
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured(result),
    };
  }
);

// ------------------------------------------------------------
// Tool: collab.module.set_hub
// ------------------------------------------------------------
server.registerTool(
  "collab_module_set_hub",
  {
    title: "Set (or clear) a module's main note",
    description: [
      "Names ONE entry as the module's main note (hub). collab_module_get then reports",
      "which decisions/proposals/gotchas the main note does not reach within 2 links.",
      "The entry must belong to the module and be live. Pass id=null to clear.",
    ].join("\n"),
    inputSchema: {
      slug: z.string().min(1),
      id: NOTE_REF.nullable().describe("Note number (integer inside E-NNNNN, or a reference like 'SH-12'), or null to clear."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const ref = args.id === null ? null : resolveRefArg(args.id);
    const result = setModuleHub(db, { slug: args.slug, id: ref ? ref.id : null, series: ref?.series });
    const text = result.hub
      ? `Main note for '${result.slug}' is now ${formatEntryRef(result.hub.id, result.hub.series)} (${result.hub.title}).`
      : `Main note for '${result.slug}' cleared.`;
    return { content: [{ type: "text", text }], structuredContent: structured(result) };
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
        .array(NOTE_REF)
        .min(1)
        .describe("Notes being replaced: integers (the ones inside E-NNNNN) or references like 'SH-12'."),
      by: NOTE_REF.describe("The note that replaces them (integer = E, or a reference like 'SH-12')."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const ids = args.ids.map(resolveRefArg);
    const by = resolveRefArg(args.by);
    const result = supersede(db, { ids, by });
    const supersededIds = [...new Map(ids.map((r) => [formatNoteRef(r), r])).keys()].join(", ");
    const byId = formatNoteRef(by);
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
      "Checks the whole setup (install, notebook, versions, running programs, sync, Claude Code) and the notes' schema + data integrity.",
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
    const setup = formatSetupReport(await runSetupDoctor());
    return {
      content: [{ type: "text", text: `${setup}\n\n${lines.join("\n")}` }],
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
    const head = `[${formatEntryRef(e.id, e.series)}] ${e.type} - ${e.title}`;
    const body = r.auto_expanded && e.description
      ? `  ${e.summary}\n  ---\n  ${e.description.slice(0, 800)}${e.description.length > 800 ? "..." : ""}`
      : `  ${e.summary}`;
    return `${head}\n${body}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

function formatTaskMatches(
  tasks: Array<{ id: string; title: string; status: string; priority: string | null; module: string | null }>
): string {
  const lines = tasks.map(
    (t) =>
      `  [${t.id}] ${t.status}${t.priority ? ` (${t.priority})` : ""}` +
      `${t.module ? ` {${t.module}}` : ""} - ${t.title}`
  );
  return `Also ${tasks.length} matching task(s) (collab.task.get for detail):\n${lines.join("\n")}`;
}

/**
 * "superseded by" follows superseded_by_ulid (J17): getEntry's superseded_target
 * carries the note's current number. Only files without the ULID column
 * (superseded_target undefined) fall back to the stored integer.
 */
function supersededBy(e: { superseded_by?: number | null; superseded_target?: { id: number | null; present: boolean; series?: string } | null }): string | null {
  if (e.superseded_target === undefined) return e.superseded_by != null ? `superseded by ${formatEntryRef(e.superseded_by)}` : null;
  if (e.superseded_target === null) return null;
  return e.superseded_target.present
    ? `superseded by ${formatEntryRef(e.superseded_target.id, e.superseded_target.series)}`
    : `superseded by ${formatEntryRef(null)} (not on this laptop)`;
}

function formatEntry(e: {
  id: number; type: string; title: string; summary: string;
  description: string | null; status: string; agent: string | null;
  module: string | null; modules?: string[]; category?: string;
  superseded_by?: number | null; task_id: string | null;
  superseded_target?: { id: number | null; present: boolean; series?: string } | null;
  series?: string;
  tokens_estimate: number; created_at: string;
  refs: Array<{ ref_type: string; ref_value: string }>;
}): string {
  const head = `[${formatEntryRef(e.id, e.series)}] ${e.type} - ${e.title}`;
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
    supersededBy(e),
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
