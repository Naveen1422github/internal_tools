import type { DB } from "../db.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface SearchArgs {
  query: string;
  module?: string;
  task?: string;
  type?: string;
  category?: "Index" | "Reference" | "Activity";
  kind: "signal" | "log" | "any";
  status?: string;
  since?: string;                 // "7d" | "2w" | "1m" | ISO date
  include_deprecated: boolean;
  limit: number;
}

export interface EntrySummary {
  id: number;
  type: string;
  title: string;
  summary: string;
  score: number | null;
  tokens_estimate: number;
  created_at: string;
  description?: string;           // only populated when auto-expanded
}

export interface SearchResult {
  results: EntrySummary[];
  auto_expanded: boolean;
  total_tokens: number;
  filters_applied: Record<string, unknown>;
}

// Auto-expand rule from DESIGN.md §7.
// Override via env for testing.
const AUTO_EXPAND_MAX_COUNT = 3;
const AUTO_EXPAND_MAX_TOKENS = Number(process.env.COLLAB_AUTOEXPAND_MAX_TOKENS ?? 1500);

// ------------------------------------------------------------
// Date shorthand parser
// ------------------------------------------------------------
export function resolveSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  // Already ISO-ish (YYYY-MM-DD or full timestamp) — pass through.
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;

  const m = since.match(/^(\d+)\s*([dwmy])$/i);
  if (!m) {
    throw new Error(
      `invalid 'since' value: '${since}'. Expected ISO date or shorthand like '7d', '2w', '1m', '1y'.`
    );
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const now = new Date();
  switch (unit) {
    case "d": now.setUTCDate(now.getUTCDate() - n); break;
    case "w": now.setUTCDate(now.getUTCDate() - 7 * n); break;
    case "m": now.setUTCMonth(now.getUTCMonth() - n); break;
    case "y": now.setUTCFullYear(now.getUTCFullYear() - n); break;
  }
  // Use ISO without milliseconds for readable SQL comparison against
  // SQLite's datetime('now') format.
  return now.toISOString().slice(0, 19).replace("T", " ");
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
/**
 * Build a safe FTS5 MATCH expression from raw user input.
 * - tokenizes on non-alphanumeric, so "custom-reports" -> custom, reports
 * - escapes embedded quotes ("" ) and drops empty tokens
 * - prefix-matches each token ("cus" -> "cus"*) so as-you-type / partial words recall
 * - joins with AND (precise, the FTS default) or OR (recall fallback)
 * Returns null when the input has no usable tokens — callers must then skip MATCH
 * entirely rather than emit an empty/`*`-only expression (which FTS5 rejects).
 */
export function buildFtsMatch(query: string, join: "AND" | "OR" = "AND"): string | null {
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (tokens.length === 0) return null;
  return tokens.join(join === "OR" ? " OR " : " ");
}

export function searchEntries(db: DB, args: SearchArgs): SearchResult {
  const hasQuery = args.query.trim().length > 0;
  const sinceIso = resolveSince(args.since);

  // Build the WHERE clause dynamically. Parameters passed positionally.
  const where: string[] = [];
  const params: unknown[] = [];

  if (!args.include_deprecated) {
    where.push("e.deprecated = 0");
  }

  if (args.kind !== "any") {
    where.push("e.kind = ?");
    params.push(args.kind);
  }
  // Module filter is many-to-many: match via entry_modules so multi-module
  // entries appear for every module they belong to (subquery-IN keeps the
  // positional param order and avoids row duplication).
  if (args.module)   { where.push("e.id IN (SELECT entry_id FROM entry_modules WHERE module = ?)"); params.push(args.module); }
  if (args.task)     { where.push("e.task_id = ?");  params.push(args.task); }
  if (args.type)     { where.push("e.type = ?");     params.push(args.type); }
  if (args.category) { where.push("e.category = ?"); params.push(args.category); }
  if (args.status)   { where.push("e.status = ?");   params.push(args.status); }
  if (sinceIso)      { where.push("e.created_at >= ?"); params.push(sinceIso); }

  // FTS path only when there's a query that yields usable tokens (all-punctuation
  // input -> null -> fall through to the recency listing instead of a broken MATCH).
  const ftsAnd = hasQuery ? buildFtsMatch(args.query, "AND") : null;

  let sql: string;
  let matchParamIndex = -1;
  if (ftsAnd) {
    matchParamIndex = params.length;
    where.push("entries_fts MATCH ?");
    params.push(ftsAnd);

    sql = `
      SELECT
        e.id, e.type, e.title, e.summary, e.tokens_estimate, e.created_at,
        bm25(entries_fts) AS score
      FROM entries_fts
      JOIN entries e ON e.id = entries_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `;
  } else {
    sql = `
      SELECT
        e.id, e.type, e.title, e.summary, e.tokens_estimate, e.created_at,
        NULL AS score
      FROM entries e
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY e.created_at DESC
      LIMIT ?
    `;
  }
  params.push(args.limit);

  const stmt = db.prepare(sql);
  let rows = stmt.all(...params) as EntrySummary[];

  // Recall fallback: a precise AND-of-prefixes can return nothing for odd phrasings
  // (e.g. "customizable reports"). Retry the same filters with tokens OR-joined so the
  // closest entries still surface, bm25-ranked. Single-token queries are unchanged
  // (AND and OR produce the same expression), so this only fires for multi-word input.
  if (rows.length === 0 && ftsAnd) {
    const ftsOr = buildFtsMatch(args.query, "OR");
    if (ftsOr && ftsOr !== ftsAnd) {
      params[matchParamIndex] = ftsOr;
      rows = stmt.all(...params) as EntrySummary[];
    }
  }

  // Auto-expand rule: count + total tokens both under caps.
  const totalTokens = rows.reduce((s, r) => s + (r.tokens_estimate ?? 0), 0);
  const shouldExpand =
    rows.length > 0 &&
    rows.length <= AUTO_EXPAND_MAX_COUNT &&
    totalTokens <= AUTO_EXPAND_MAX_TOKENS;

  if (shouldExpand) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const bodies = db
      .prepare(`SELECT id, description FROM entries WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; description: string | null }>;
    const map = new Map(bodies.map((b) => [b.id, b.description]));
    for (const r of rows) {
      r.description = map.get(r.id) ?? undefined;
    }
  }

  return {
    results: rows,
    auto_expanded: shouldExpand,
    total_tokens: totalTokens,
    filters_applied: {
      query: args.query,
      module: args.module,
      task: args.task,
      type: args.type,
      category: args.category,
      kind: args.kind,
      status: args.status,
      since: sinceIso,
      include_deprecated: args.include_deprecated,
      limit: args.limit,
    },
  };
}
