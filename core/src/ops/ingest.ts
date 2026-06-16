import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import type { EntryType, Agent, RefInput } from "./add.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export type IngestSource = "codex-dispatch" | "codex-review" | "manual" | "session-end";

export interface IngestContext {
  task_id?: string;
  module?: string;
  agent?: Agent;
  changed_files?: string[];     // repo-relative paths — become file refs
  type_hint?: EntryType;        // override the default type derived from source
}

export interface IngestArgs {
  source: IngestSource;
  raw_text: string;             // the content to summarize — usually Codex's agent_message
  context?: IngestContext;
}

export interface DraftEntry {
  type: EntryType;
  title: string;
  summary: string;              // <= 200 chars
  description: string;
  agent?: Agent;
  module?: string;
  task_id?: string;
  refs?: RefInput[];
  tokens_estimate: number;
}

export interface IngestResult {
  draft_entry: DraftEntry;
  confidence: "high" | "medium" | "low";
}

// ------------------------------------------------------------
// Source -> default type mapping
// ------------------------------------------------------------
const TYPE_BY_SOURCE: Record<IngestSource, EntryType> = {
  "codex-dispatch": "handoff",
  "codex-review": "review",
  manual: "handoff",
  "session-end": "handoff",
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…"; // ellipsis
}

// Summary = first sentence (by .!? boundary) or full first line, hard-capped at 200.
function extractSummary(text: string): string {
  const line = firstNonEmptyLine(text);
  if (!line) return "(empty)";
  const sentenceMatch = line.match(/^[^.!?]+[.!?]/);
  const candidate = sentenceMatch ? sentenceMatch[0].trim() : line;
  return truncate(candidate, 200);
}

function extractTitle(text: string): string {
  const line = firstNonEmptyLine(text);
  if (!line) return "(untitled)";
  return truncate(line, 80);
}

// ------------------------------------------------------------
// parseIntoDraft — pure, no DB writes
// ------------------------------------------------------------
export function parseIntoDraft(args: IngestArgs): IngestResult {
  const ctx = args.context ?? {};
  const type: EntryType = ctx.type_hint ?? TYPE_BY_SOURCE[args.source] ?? "handoff";

  const title = extractTitle(args.raw_text);
  const summary = extractSummary(args.raw_text);
  const description = args.raw_text.trim();

  const refs: RefInput[] | undefined =
    ctx.changed_files && ctx.changed_files.length > 0
      ? ctx.changed_files.map((f) => ({ ref_type: "file" as const, ref_value: f }))
      : undefined;

  // Confidence heuristic:
  //   high   — source is a known dispatch AND we have task_id AND at least one changed file
  //   medium — source is a known dispatch OR we have task_id
  //   low    — neither
  let confidence: IngestResult["confidence"] = "low";
  const knownSource = args.source === "codex-dispatch" || args.source === "codex-review";
  const hasTask = Boolean(ctx.task_id);
  const hasRefs = Boolean(refs && refs.length > 0);
  if (knownSource && hasTask && hasRefs) confidence = "high";
  else if (knownSource || hasTask) confidence = "medium";

  const draft_entry: DraftEntry = {
    type,
    title,
    summary,
    description,
    agent: ctx.agent,
    module: ctx.module,
    task_id: ctx.task_id,
    refs,
    tokens_estimate: estimateTokens(description),
  };

  return { draft_entry, confidence };
}

// DB param kept for signature consistency with other tools, even though
// this function doesn't read or write. Lets the server.ts handler use the
// same (db, args) pattern uniformly.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ingestDraft(_db: DB, args: IngestArgs): IngestResult {
  return parseIntoDraft(args);
}
