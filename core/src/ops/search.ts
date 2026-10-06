import type { DB } from "../db.js";
import { liveEntry, ftsJoin, hasSeries, hasUlidPrimaryKey } from "../schema.js";

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
  /** Only this project's notes (stage B1, spec P4). Omitted = every note, as today. */
  project_ulid?: string;
}

export interface EntrySummary {
  id: number;
  type: string;
  title: string;
  summary: string;
  score: number | null;
  tokens_estimate: number;
  created_at: string;
  series: string;                 // "E", or the project's code (0009+; always "E" before)
  project_ulid: string | null;    // null = no project
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
  const ulidPk = hasUlidPrimaryKey(db); // 0006+: FTS keyed by ulid, E-numbers non-unique

  // Build the WHERE clause dynamically. Parameters passed positionally.
  const where: string[] = [];
  const params: unknown[] = [];

  if (!args.include_deprecated) {
    where.push("e.deprecated = 0");
  }
  where.push(liveEntry(db, "e")); // tombstones never appear in search or list_recent

  if (args.kind !== "any") {
    where.push("e.kind = ?");
    params.push(args.kind);
  }
  // Module filter is many-to-many: match via entry_modules so multi-module
  // entries appear for every module they belong to (subquery-IN keeps the
  // positional param order and avoids row duplication).
  if (args.module)   { where.push("e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)"); params.push(args.module); }
  if (args.task)     { where.push("e.task_id = ?");  params.push(args.task); }
  if (args.type)     { where.push("e.type = ?");     params.push(args.type); }
  if (args.category) { where.push("e.category = ?"); params.push(args.category); }
  if (args.status)   { where.push("e.status = ?");   params.push(args.status); }
  if (sinceIso)      { where.push("e.created_at >= ?"); params.push(sinceIso); }
  const series = hasSeries(db);
  if (args.project_ulid !== undefined) {
    // Before 0009 no note has a project, so a project scope matches nothing.
    if (series) { where.push("e.project_ulid = ?"); params.push(args.project_ulid); }
    else where.push("0 = 1");
  }

  // FTS path only when there's a query that yields usable tokens (all-punctuation
  // input -> null -> fall through to the recency listing instead of a broken MATCH).
  const ftsAnd = hasQuery ? buildFtsMatch(args.query, "AND") : null;

  // At 0006 entries_fts has an INDEXED ulid column (column 0, so the edit
  // triggers can find rows by MATCH). Scope every user MATCH to the text
  // columns so ulid tokens are never matched or ranked. buildFtsMatch quotes
  // every token, so user input can never break out of this scope.
  const scopeMatch = (expr: string): string =>
    ulidPk ? `{title summary description} : (${expr})` : expr;

  // Internal key used only for auto-expand below; stripped before returning.
  const keyCol = ulidPk ? "e.ulid" : "e.id";
  const seriesCols = series ? "e.series, e.project_ulid" : "'E' AS series, NULL AS project_ulid";
  const cols = `e.id, e.type, e.title, e.summary, e.tokens_estimate, e.created_at, ${seriesCols}, ${keyCol} AS _key`;

  let sql: string;
  let finalParams: unknown[];
  let matchParamIndex = -1;
  if (ftsAnd && ulidPk) {
    // 0006 shape (E-674 perf budget, < 100 ms at 10k rows): take the FTS top-N
    // by rank first, then join entries and filter. N = 2x the page size so the
    // over-fetch absorbs tombstoned/deprecated/filtered hits. Accepted
    // trade-off: when more than N - limit of the top N hits are filtered out,
    // the page returns fewer than `limit` rows. Joining first and ranking after
    // measured 224-295 ms at 10k rows; this shape 32-38 ms (task-2 report).
    sql = `
      SELECT ${cols}, f.rank AS score
      FROM (SELECT ulid, rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?) f
      JOIN entries e ON e.ulid = f.ulid
      WHERE ${where.join(" AND ")}
      ORDER BY f.rank
      LIMIT ?
    `;
    matchParamIndex = 0;
    finalParams = [scopeMatch(ftsAnd), args.limit * 2, ...params, args.limit];
  } else if (ftsAnd) {
    // 0005: unchanged join-first shape over the external-content FTS.
    sql = `
      SELECT ${cols}, bm25(entries_fts) AS score
      FROM entries_fts
      ${ftsJoin(db, "e")}
      WHERE ${where.join(" AND ")} AND entries_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `;
    matchParamIndex = params.length;
    finalParams = [...params, scopeMatch(ftsAnd), args.limit];
  } else {
    sql = `
      SELECT ${cols}, NULL AS score
      FROM entries e
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY e.created_at DESC
      LIMIT ?
    `;
    finalParams = [...params, args.limit];
  }

  const stmt = db.prepare(sql);
  let rows = stmt.all(...finalParams) as Array<EntrySummary & { _key?: number | string }>;

  // Recall fallback: a precise AND-of-prefixes can return nothing for odd phrasings
  // (e.g. "customizable reports"). Retry the same filters with tokens OR-joined so the
  // closest entries still surface, bm25-ranked. Single-token queries are unchanged
  // (AND and OR produce the same expression), so this only fires for multi-word input.
  if (rows.length === 0 && ftsAnd) {
    const ftsOr = buildFtsMatch(args.query, "OR");
    if (ftsOr && ftsOr !== ftsAnd) {
      finalParams[matchParamIndex] = scopeMatch(ftsOr);
      rows = stmt.all(...finalParams) as Array<EntrySummary & { _key?: number | string }>;
    }
  }

  // Auto-expand rule: count + total tokens both under caps.
  const totalTokens = rows.reduce((s, r) => s + (r.tokens_estimate ?? 0), 0);
  const shouldExpand =
    rows.length > 0 &&
    rows.length <= AUTO_EXPAND_MAX_COUNT &&
    totalTokens <= AUTO_EXPAND_MAX_TOKENS;

  if (shouldExpand) {
    // Keyed by ulid at 0006 (E-numbers are non-unique there, so an id lookup
    // could attach a tombstoned twin's body), by id at 0005.
    const keys = rows.map((r) => r._key);
    const placeholders = keys.map(() => "?").join(",");
    const keyName = ulidPk ? "ulid" : "id";
    const bodies = db
      .prepare(`SELECT ${keyName} AS k, description FROM entries WHERE ${keyName} IN (${placeholders})`)
      .all(...keys) as Array<{ k: number | string; description: string | null }>;
    const map = new Map(bodies.map((b) => [b.k, b.description]));
    for (const r of rows) {
      r.description = map.get(r._key!) ?? undefined;
    }
  }
  for (const r of rows) delete r._key; // internal only: result shape unchanged

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
      project_ulid: args.project_ulid,
    },
  };
}
