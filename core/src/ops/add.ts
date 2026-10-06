import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { autoAdvanceTaskForEntry, type TaskStatus } from "./task.js";
import { insertEntryRow, insertEntryModules, insertRefs } from "../entry-write.js";
import { isSyncEnabled } from "../sync/state.js";
import { resolveAllocator, allocateWithRetry, PostOfficeUnreachableError } from "../sync/allocator.js";
import { newUlid } from "../ulid.js";
import { currentProject, findProject, notFound, type Project } from "../projects.js";

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
import { ensureCrsqlite } from "../sync/extension.js";

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
  assigned?: { ulid: string; id: number }; // internal: set only by addEntryAsync
  /**
   * The project to write into: its code or ULID (stage B1). "none" = no project
   * (series E). addEntryAsync defaults it to the folder's current project
   * (.collab, spec P3); addEntry treats omitted as no project.
   */
  project?: string;
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
export type AddEntryResult = {
  id: number;
  /** "E" for a note without a project, else the project's code (SH). */
  series: string;
  project: { code: string; name: string; mode: string } | null;
  taskTransition?: { id: string; from: TaskStatus; to: TaskStatus };
  normalizedDescription?: boolean;
};

const ENTRY_TYPES = Object.keys(KIND_BY_TYPE);
const CATEGORIES = ["Index", "Reference", "Activity"];
const AGENTS = ["Claude", "Codex", "Gemini", "User"];
const REF_TYPES = ["file", "task", "entry", "url"];

/**
 * Every check a new entry must pass, run BEFORE a number is requested (E-713):
 * a save refused for bad input must never consume a post office number. The
 * first four messages are addEntry's historical ones; the rest mirror the
 * schema's CHECK constraints so the database never has to be the one to refuse.
 */
export function validateAddEntryArgs(args: AddEntryArgs): void {
  if (!args.title || args.title.trim().length === 0) throw new Error("title is required");
  if (!args.summary || args.summary.trim().length === 0) throw new Error("summary is required");
  if (args.summary.length > 200) throw new Error(`summary exceeds 200 chars (got ${args.summary.length})`);
  if (args.type === "rollup") throw new Error("rollup entries are system-generated; use collab.rollup (not collab.add)");
  if (!ENTRY_TYPES.includes(args.type)) throw new Error(`invalid type: ${String(args.type)}`);
  if (args.category !== undefined && !CATEGORIES.includes(args.category)) throw new Error(`invalid category: ${String(args.category)}`);
  if (args.agent !== undefined && !AGENTS.includes(args.agent)) throw new Error(`invalid agent: ${String(args.agent)}`);
  if (args.status !== undefined && args.status !== "draft" && args.status !== "active") {
    throw new Error(`invalid status: ${String(args.status)} (a new note is draft or active)`);
  }
  if (args.description !== undefined && args.description !== null && typeof args.description !== "string") {
    throw new Error("description must be text");
  }
  for (const m of [args.module, ...(args.modules ?? [])]) {
    if (m !== undefined && typeof m !== "string") throw new Error(`invalid module: ${String(m)}`);
  }
  if (args.task_id !== undefined && typeof args.task_id !== "string") throw new Error("task_id must be text");
  for (const r of args.refs ?? []) {
    if (!r || !REF_TYPES.includes(r.ref_type)) throw new Error(`invalid ref_type: ${String(r?.ref_type)}`);
    if (typeof r.ref_value !== "string" || r.ref_value.length === 0) throw new Error("every ref needs a non-empty ref_value");
  }
}

/** The project `args.project` names, or null; an unknown one throws ProjectNotFoundError listing the known codes. */
function resolveProjectArg(db: DB, args: AddEntryArgs): Project | null {
  if (args.project === undefined || args.project === null || args.project === "") return null;
  if (args.project.trim().toLowerCase() === "none") return null;
  const p = findProject(db, args.project);
  if (!p) throw notFound(db, args.project);
  return p;
}

export function addEntry(
  db: DB,
  args: AddEntryArgs,
): AddEntryResult {
  ensureCrsqlite(db);
  validateAddEntryArgs(args);
  const project = resolveProjectArg(db, args);

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

  const tx = db.transaction((a: AddEntryArgs) => {
    const owner = insertEntryRow(db, {
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
      assigned: a.assigned,
      ...(project ? { series: project.code, project_ulid: project.ulid } : {}),
    });
    insertEntryModules(db, owner, orderedModules, primaryModule);
    insertRefs(db, owner, a.refs ?? []);
    return owner.id;
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
    series: project ? project.code : "E",
    project: project ? { code: project.code, name: project.name, mode: project.mode } : null,
    ...(taskTransition ? { taskTransition } : {}),
    // Surfaced so the caller can report the repair rather than silently
    // rewriting what the author submitted.
    ...(normalizedDescription ? { normalizedDescription: true } : {}),
  };
}

/**
 * The entry point for every async caller. Checks the input FIRST (E-713), then:
 * sharing off => identical to addEntry; sharing on => ask the post office for
 * the number with ONE ulid across bounded retries; if that fails, nothing is
 * written (E-708: refuse to save).
 */
export async function addEntryAsync(db: DB, args: AddEntryArgs): Promise<AddEntryResult> {
  ensureCrsqlite(db);
  validateAddEntryArgs(args);
  if (args.project === undefined) {
    const cur = currentProject(db);
    if (cur) args = { ...args, project: cur.ulid };
  }
  // A solo-project note is numbered on this laptop: never an allocator call,
  // whatever sharing says (spec rule 4; team projects arrive with stage C).
  if (resolveProjectArg(db, args)) return addEntry(db, args);
  if (!isSyncEnabled(db)) return addEntry(db, args);
  const allocator = resolveAllocator(db);
  if (!allocator) throw new PostOfficeUnreachableError("no post office connection is configured on this machine");
  const ulid = newUlid();
  const id = await allocateWithRetry(allocator, ulid);
  return addEntry(db, { ...args, assigned: { ulid, id } });
}
