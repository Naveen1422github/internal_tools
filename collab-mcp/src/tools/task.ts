import type { DB } from "../db.js";
import type { Agent } from "./add.js";

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

  const entries = db
    .prepare(
      `
    SELECT id, type, title, summary, created_at
    FROM entries
    WHERE task_id = ? AND deprecated = 0
    ORDER BY created_at DESC
    LIMIT 10
  `
    )
    .all(id) as TaskEntrySummary[];

  return { task, recent_entries: entries };
}
