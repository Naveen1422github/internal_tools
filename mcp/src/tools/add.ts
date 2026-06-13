import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { autoAdvanceTaskForEntry, type TaskStatus } from "./task.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export type EntryType =
  | "handoff"
  | "review"
  | "proposal"
  | "counter"
  | "decision"
  | "gotcha"
  | "rollup"
  | "session-note"
  | "changelog";

export type Agent = "Claude" | "Codex" | "Gemini" | "User";
export type RefType = "file" | "task" | "entry" | "url";
export type Category = "Index" | "Reference" | "Activity";

export interface RefInput {
  ref_type: RefType;
  ref_value: string;
}

export interface AddEntryArgs {
  type: EntryType;
  title: string;
  summary: string;              // <= 200 chars; enforced here
  description?: string;
  status?: "draft" | "active";  // defaults to 'active'. resolved/deprecated set by other paths
  agent?: Agent;
  module?: string;              // PRIMARY module (back-compat: written to entries.module)
  modules?: string[];           // additional modules; many-to-many via entry_modules
  category?: Category;          // omitted -> derived from type (see CATEGORY_BY_TYPE)
  task_id?: string;
  refs?: RefInput[];
}

// kind is derived from type — callers never set it directly, which removes a class of mistakes.
const KIND_BY_TYPE: Record<EntryType, "signal" | "log"> = {
  handoff: "signal",
  review: "signal",
  proposal: "signal",
  counter: "signal",
  decision: "signal",
  gotcha: "signal",
  rollup: "signal",
  "session-note": "log",
  changelog: "log",
};

// category is the lifecycle/retrieval axis (0004 redesign, decision E-00163).
// Derived from type when the caller doesn't set it explicitly: decisions/gotchas
// are durable Reference truth; everything else is the archivable Activity trail.
// (There is no 'index' type — Index is only ever set explicitly via `category`.)
const CATEGORY_BY_TYPE: Record<EntryType, Category> = {
  handoff: "Activity",
  review: "Activity",
  proposal: "Activity",
  counter: "Activity",
  decision: "Reference",
  gotcha: "Reference",
  rollup: "Activity",
  "session-note": "Activity",
  changelog: "Activity",
};

// ------------------------------------------------------------
// addEntry
// ------------------------------------------------------------
export function addEntry(
  db: DB,
  args: AddEntryArgs,
): { id: number; taskTransition?: { id: string; from: TaskStatus; to: TaskStatus } } {
  if (!args.title || args.title.trim().length === 0) {
    throw new Error("title is required");
  }
  if (!args.summary || args.summary.trim().length === 0) {
    throw new Error("summary is required");
  }
  if (args.summary.length > 200) {
    throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
  }
  if (args.type === "rollup") {
    throw new Error("rollup entries are system-generated; use collab.rollup (not collab.add)");
  }

  const kind = KIND_BY_TYPE[args.type];
  const category = args.category ?? CATEGORY_BY_TYPE[args.type];
  const tokens = estimateTokens(args.description);

  // Build the ordered, de-duplicated module list. `module` (if given) is PRIMARY;
  // otherwise the first of `modules` is primary. entries.module keeps the primary
  // for back-compat; entry_modules is the new source of truth for multi-module reads.
  const moduleCandidates = [
    ...(args.module ? [args.module] : []),
    ...(args.modules ?? []),
  ];
  const orderedModules: string[] = [];
  for (const m of moduleCandidates) {
    if (m && !orderedModules.includes(m)) orderedModules.push(m);
  }
  const primaryModule = orderedModules.length > 0 ? orderedModules[0] : null;

  const insertEntry = db.prepare(`
    INSERT INTO entries (
      type, kind, title, summary, description,
      status, agent, module, task_id, tokens_estimate, category
    ) VALUES (
      @type, @kind, @title, @summary, @description,
      @status, @agent, @module, @task_id, @tokens_estimate, @category
    )
  `);

  const tx = db.transaction((a: AddEntryArgs) => {
    const result = insertEntry.run({
      type: a.type,
      kind,
      title: a.title,
      summary: a.summary,
      description: a.description ?? null,
      status: a.status ?? "active",
      agent: a.agent ?? null,
      module: primaryModule,
      task_id: a.task_id ?? null,
      tokens_estimate: tokens,
      category,
    });
    const id = Number(result.lastInsertRowid);

    // entry_modules rows: primary gets is_primary=1, the rest 0. Positional
    // (?, ?, ?) like the refs path; chunk to respect SQLite's 999-param limit.
    if (orderedModules.length > 0) {
      const MODULE_CHUNK_SIZE = 300; // each row uses 3 params
      for (let i = 0; i < orderedModules.length; i += MODULE_CHUNK_SIZE) {
        const chunk = orderedModules.slice(i, i + MODULE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const params = chunk.flatMap((m) => [id, m, m === primaryModule ? 1 : 0]);
        db.prepare(
          `INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES ${placeholders}`,
        ).run(...params);
      }
    }

    if (a.refs && a.refs.length > 0) {
      // Chunking to respect SQLite's parameter limit (default 999).
      // Each ref has 3 params (entry_id, ref_type, ref_value).
      const CHUNK_SIZE = 300;
      for (let i = 0; i < a.refs.length; i += CHUNK_SIZE) {
        const chunk = a.refs.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const params = chunk.flatMap((r) => [id, r.ref_type, r.ref_value]);
        db.prepare(
          `INSERT OR IGNORE INTO refs (entry_id, ref_type, ref_value) VALUES ${placeholders}`,
        ).run(...params);
      }
    }
    return id;
  });

  const id = tx(args);

  // Lifecycle automation: advance the linked task when a completion-signal
  // entry lands. Best-effort — a failure here must never fail the entry write.
  let taskTransition;
  if (args.task_id) {
    try {
      taskTransition = autoAdvanceTaskForEntry(db, args.type, args.task_id) ?? undefined;
    } catch {
      taskTransition = undefined;
    }
  }

  return taskTransition ? { id, taskTransition } : { id };
}
