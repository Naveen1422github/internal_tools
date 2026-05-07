import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";

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
  module?: string;
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

// ------------------------------------------------------------
// addEntry
// ------------------------------------------------------------
export function addEntry(db: DB, args: AddEntryArgs): { id: number } {
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
  const tokens = estimateTokens(args.description);

  const insertEntry = db.prepare(`
    INSERT INTO entries (
      type, kind, title, summary, description,
      status, agent, module, task_id, tokens_estimate
    ) VALUES (
      @type, @kind, @title, @summary, @description,
      @status, @agent, @module, @task_id, @tokens_estimate
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
      module: a.module ?? null,
      task_id: a.task_id ?? null,
      tokens_estimate: tokens,
    });
    const id = Number(result.lastInsertRowid);
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

  return { id: tx(args) };
}
