import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { autoAdvanceTaskForEntry, type TaskStatus } from "./task.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
import {
  type EntryType,
  type Agent,
  type RefType,
  type Category,
  KIND_BY_TYPE,
  CATEGORY_BY_TYPE,
} from "../constants.js";

export type { EntryType, Agent, RefType, Category };

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

// ------------------------------------------------------------
// Double-encoding guard
// ------------------------------------------------------------
// 14 entries (E-159..166, E-198, E-202..206) were stored with their newlines as
// the two-character sequence backslash-n instead of real newlines: a caller had
// JSON-encoded the description one time too many. It rendered as one wall of
// text and went unnoticed for two months, because the old plain-text renderer
// made every entry look equally flat. See collab E-502 / E-503.
//
// Normalising is preferred over rejecting: a hard error would break a dispatched
// agent mid-run over something we can unambiguously repair.
//
// The test is deliberately conservative -- TWO OR MORE occurrences AND no real
// newline at all. A description that legitimately discusses newline escaping
// (E-35 talks about CSV quoting; E-383 about stacking "10\n15" in a cell) always
// has real newlines around that prose, so it is never touched. A single stray
// occurrence is far more likely to be content than damage, so it is left alone.
const BACKSLASH = String.fromCharCode(92);
const LITERAL_NEWLINE = BACKSLASH + "n";

export function looksDoubleEncoded(s: string): boolean {
  if (s.includes("\n")) return false;
  return s.split(LITERAL_NEWLINE).length - 1 >= 2;
}

/** Single-pass unescape; unknown escapes (e.g. `\d` in a regex) are left as-is. */
function decodeOnce(s: string): string {
  const map: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    '"': '"',
    "'": "'",
    [BACKSLASH]: BACKSLASH,
  };
  return s.replace(new RegExp(BACKSLASH + BACKSLASH + "(.)", "g"), (m, c: string) =>
    c in map ? map[c] : m,
  );
}

// ------------------------------------------------------------
// addEntry
// ------------------------------------------------------------
export function addEntry(
  db: DB,
  args: AddEntryArgs,
): {
  id: number;
  taskTransition?: { id: string; from: TaskStatus; to: TaskStatus };
  normalizedDescription?: boolean;
} {
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

  // Repair a double-encoded description before anything downstream sees it --
  // including estimateTokens, which would otherwise count the escape sequences.
  const normalizedDescription =
    args.description !== undefined && looksDoubleEncoded(args.description);
  if (normalizedDescription) {
    args = { ...args, description: decodeOnce(args.description as string) };
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

  return {
    id,
    ...(taskTransition ? { taskTransition } : {}),
    // Surfaced so the caller can report the repair rather than silently
    // rewriting what the author submitted.
    ...(normalizedDescription ? { normalizedDescription: true } : {}),
  };
}
