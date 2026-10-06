import type { DB } from "../db.js";
import { hasSeries, liveEntry } from "../schema.js";
import type { Agent } from "./add.js";
import { ensureCrsqlite } from "../sync/extension.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export type TaskStatus = "pending" | "assigned" | "in-progress" | "review" | "done";
export type Priority = "critical" | "high" | "medium" | "low";

// State machine from DESIGN.md §5.
// Any task can be reset to 'pending' (Orchestrator escape hatch).
const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in-progress"],
  assigned: ["in-progress", "pending"],
  "in-progress": ["review", "pending"],
  review: ["in-progress", "done", "pending"],
  done: ["pending"],
};

export interface CreateTaskArgs {
  title: string;
  summary?: string;       // <= 200 chars
  description?: string;
  priority?: Priority;
  module?: string;
  assignee?: Agent;
}

export interface TaskRow {
  id: string;
  title: string;
  summary: string | null;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  priority: string | null;
  module: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEntrySummary {
  id: number;
  type: string;
  title: string;
  summary: string;
  created_at: string;
  series?: string; // present only for a project note (SH); absent = E (stage B1)
}

export interface TaskWithEntries {
  task: TaskRow | null;
  recent_entries: TaskEntrySummary[];
}

// ------------------------------------------------------------
// Task ID generator: T-NNN, zero-padded to 3.
// Gaps from deleted tasks are NOT recycled.
// ------------------------------------------------------------
function nextTaskId(db: DB): string {
  const row = db
    .prepare(
      `SELECT id FROM tasks WHERE id LIKE 'T-%' ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (!row) return "T-001";
  const n = parseInt(row.id.slice(2), 10);
  if (Number.isNaN(n)) return "T-001";
  return `T-${String(n + 1).padStart(3, "0")}`;
}

// ------------------------------------------------------------
// createTask
// ------------------------------------------------------------
export function createTask(db: DB, args: CreateTaskArgs): { id: string } {
  if (!args.title || args.title.trim().length === 0) {
    throw new Error("title is required");
  }
  if (args.summary && args.summary.length > 200) {
    throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
  }

  const id = nextTaskId(db);
  const status: TaskStatus = args.assignee ? "assigned" : "pending";

  db.prepare(
    `
    INSERT INTO tasks (id, title, summary, description, status, assignee, priority, module)
    VALUES (@id,@title,@summary,@description,@status,@assignee,@priority,@module)
  `
  ).run({
    id,
    title: args.title,
    summary: args.summary ?? null,
    description: args.description ?? null,
    status,
    assignee: args.assignee ?? null,
    priority: args.priority ?? null,
    module: args.module ?? null,
  });

  return { id };
}

// ------------------------------------------------------------
// transitionTask — enforces state machine; cascades to 'done'
// ------------------------------------------------------------
export function transitionTask(
  db: DB,
  id: string,
  to: TaskStatus
): { id: string; status: TaskStatus } {
  const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as
    | { status: TaskStatus }
    | undefined;
  if (!row) throw new Error(`task ${id} not found`);

  const legal = LEGAL_TRANSITIONS[row.status] ?? [];
  if (!legal.includes(to)) {
    throw new Error(`illegal transition ${row.status} -> ${to} for task ${id}`);
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(to, id);
    // Cascade: on done, active handoffs and reviews for this task become 'resolved'.
    if (to === "done") {
      db.prepare(
        `
        UPDATE entries
        SET status = 'resolved'
        WHERE task_id = ?
          AND status = 'active'
          AND type IN ('handoff', 'review')
      `
      ).run(id);
    }
  });
  tx();

  return { id, status: to };
}

// ------------------------------------------------------------
// autoAdvanceTaskForEntry — lifecycle automation
//
// When a completion-signal entry lands against a task, advance the task's
// status automatically so it never silently lags behind reality:
//   session-note ("I started")  => ensure at least 'in-progress'
//   changelog    ("I submitted") => advance to 'review'
//
// 'review' is the terminal auto-state on purpose: a filed changelog means work
// was *submitted*, not *approved*. The '-> done' flip stays manual and
// reviewer-owned. This is lenient — it only takes legal forward steps, never
// throws, and no-ops when the task is already at/past the target or off-spine
// (e.g. already 'done'). Adding the entry must never fail because of this.
// ------------------------------------------------------------
export function autoAdvanceTaskForEntry(
  db: DB,
  entryType: string,
  taskId: string | null | undefined,
): { id: string; from: TaskStatus; to: TaskStatus } | null {
  ensureCrsqlite(db);
  if (!taskId) return null;
  if (entryType !== "changelog" && entryType !== "session-note") return null;

  const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as
    | { status: TaskStatus }
    | undefined;
  if (!row) return null;
  const from = row.status;

  // Forward steps toward the entry's implied milestone. Both 'pending' and
  // 'assigned' advance directly to 'in-progress' (both legal); a changelog then
  // continues to 'review'.
  const steps: TaskStatus[] = [];
  if (from === "pending" || from === "assigned") {
    steps.push("in-progress");
  }
  if (entryType === "changelog" && from !== "review" && from !== "done") {
    steps.push("review");
  }
  if (!steps.length) return null;

  let status = from;
  const tx = db.transaction(() => {
    for (const next of steps) {
      const legal = LEGAL_TRANSITIONS[status] ?? [];
      if (!legal.includes(next)) break; // defensive; spine steps are always legal
      db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(next, taskId);
      status = next;
    }
  });
  tx();

  return status === from ? null : { id: taskId, from, to: status };
}

// ------------------------------------------------------------
// assignTask — sets assignee; if task was 'pending', moves to 'assigned'
// ------------------------------------------------------------
export function assignTask(
  db: DB,
  id: string,
  agent: Agent
): { id: string; assignee: Agent } {
  const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as
    | { status: TaskStatus }
    | undefined;
  if (!row) throw new Error(`task ${id} not found`);

  const nextStatus: TaskStatus = row.status === "pending" ? "assigned" : row.status;

  db.prepare(`UPDATE tasks SET assignee = ?, status = ? WHERE id = ?`).run(
    agent,
    nextStatus,
    id
  );

  return { id, assignee: agent };
}

// ------------------------------------------------------------
// getTask — task row + up to 10 most recent non-deprecated entries
// ------------------------------------------------------------
export function getTask(db: DB, id: string): TaskWithEntries {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
  if (!task) return { task: null, recent_entries: [] };

  const entries = (db
    .prepare(
      `
    SELECT id, type, title, summary, created_at, ${hasSeries(db) ? "series" : "'E' AS series"}
    FROM entries
    WHERE task_id = ? AND deprecated = 0 AND ${liveEntry(db, "entries")}
    ORDER BY created_at DESC
    LIMIT 10
  `
    )
    .all(id) as TaskEntrySummary[])
    .map(({ series, ...e }) => (series && series !== "E" ? { ...e, series } : e));

  return { task, recent_entries: entries };
}

// ------------------------------------------------------------
// searchTasks — keyword + filter over the tasks table
//
// Tasks live in their own table and are NOT in entries_fts, so a plain
// collab_search misses them. This gives tasks a findable path.
//
// Matching mirrors buildFtsMatch's shape (search.ts): the query is tokenized
// on non-alphanumeric boundaries, each token becomes a LIKE over
// title/summary/description, tokens are AND-joined (precise), with an OR
// fallback when AND yields nothing — so multi-word queries like
// "hook search tool" still recall instead of silently returning zero.
//
// LIKE-not-FTS is deliberate: the tasks table is tiny (tens of rows), so a
// dedicated tasks_fts virtual table + sync triggers would be pure ceremony.
// The tokenizer strips % and _ (both non-alphanumeric), so LIKE wildcard
// injection is impossible and no escaping is needed.
// ------------------------------------------------------------
export interface TaskSummary {
  id: string;
  title: string;
  summary: string | null;
  status: TaskStatus;
  assignee: string | null;
  priority: string | null;
  module: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchTasksArgs {
  query?: string;
  module?: string;
  status?: TaskStatus;
  assignee?: string;
  limit?: number; // default 20
}

export interface SearchTasksResult {
  results: TaskSummary[];
  filters_applied: Record<string, unknown>;
}

function tokenizeTaskQuery(q: string): string[] {
  return q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function searchTasks(db: DB, args: SearchTasksArgs): SearchTasksResult {
  const baseWhere: string[] = [];
  const baseParams: unknown[] = [];

  if (args.module) { baseWhere.push("module = ?"); baseParams.push(args.module); }
  if (args.status) { baseWhere.push("status = ?"); baseParams.push(args.status); }
  if (args.assignee) { baseWhere.push("assignee = ?"); baseParams.push(args.assignee); }

  const tokens = args.query ? tokenizeTaskQuery(args.query) : [];
  const limit = args.limit ?? 20;

  const runWith = (join: "AND" | "OR"): TaskSummary[] => {
    const where = [...baseWhere];
    const params = [...baseParams];
    if (tokens.length > 0) {
      const clauses = tokens.map(() => "(title LIKE ? OR summary LIKE ? OR description LIKE ?)");
      where.push("(" + clauses.join(join === "OR" ? " OR " : " AND ") + ")");
      for (const t of tokens) {
        const like = `%${t}%`;
        params.push(like, like, like);
      }
    }
    const sql = `
      SELECT id, title, summary, status, assignee, priority, module, created_at, updated_at
      FROM tasks
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    params.push(limit);
    return db.prepare(sql).all(...params) as TaskSummary[];
  };

  let rows = runWith("AND");
  // Recall fallback only helps multi-token queries (single-token AND==OR).
  if (rows.length === 0 && tokens.length > 1) {
    rows = runWith("OR");
  }

  return {
    results: rows,
    filters_applied: {
      query: args.query ?? "",
      module: args.module,
      status: args.status,
      assignee: args.assignee,
      limit,
    },
  };
}

// ------------------------------------------------------------
// updateTask — edit a task's CONTENT fields in place
//
// Mirrors updateEntry, with two deliberate differences:
//   - status is NOT editable here — that belongs to transitionTask, which
//     enforces the state machine. Editing it raw would bypass those rules.
//   - no tokens_estimate (tasks aren't token-budgeted and aren't in FTS).
// updated_at is refreshed automatically by trg_tasks_updated_at.
// ------------------------------------------------------------
export interface UpdateTaskArgs {
  id: string;
  title?: string;
  summary?: string; // <= 200 chars
  description?: string;
  priority?: Priority;
  module?: string;
}

export interface UpdateTaskResult {
  id: string;
  updated_fields: string[];
}

export function updateTask(db: DB, args: UpdateTaskArgs): UpdateTaskResult {
  const sets: string[] = [];
  const params: Record<string, string> = { id: args.id };
  const updated: string[] = [];

  if (args.title !== undefined) {
    if (args.title.trim().length === 0) throw new Error("title cannot be blank");
    sets.push("title = @title"); params.title = args.title; updated.push("title");
  }
  if (args.summary !== undefined) {
    if (args.summary.length > 200) {
      throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
    }
    sets.push("summary = @summary"); params.summary = args.summary; updated.push("summary");
  }
  if (args.description !== undefined) {
    sets.push("description = @description"); params.description = args.description; updated.push("description");
  }
  if (args.priority !== undefined) {
    sets.push("priority = @priority"); params.priority = args.priority; updated.push("priority");
  }
  if (args.module !== undefined) {
    sets.push("module = @module"); params.module = args.module; updated.push("module");
  }

  if (sets.length === 0) {
    throw new Error(
      "nothing to update: provide at least one of title/summary/description/priority/module"
    );
  }

  const info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
  if (info.changes === 0) throw new Error(`no task found with id ${args.id}`);

  return { id: args.id, updated_fields: updated };
}
