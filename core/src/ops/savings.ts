import type { DB } from "../db.js";

// ------------------------------------------------------------
// collab_savings_report — aggregates dispatches table
//
// Headline metric (B-net):
//     net_tokens = SUM(output_tokens) - SUM(prompt_tokens_est)
//   "Tokens displaced from Claude's window after paying the dispatch prompt cost."
//
// Also visible (A-output): SUM(output_tokens) alone — overstates but quotable.
// ------------------------------------------------------------

export interface SavingsArgs {
  since?: string;                                       // ISO or '7d'/'2w'/'1m'
  group_by?: "day" | "module" | "agent" | "none";
  agent?: "Codex" | "Gemini";
}

export interface SavingsBucket {
  key: string;                  // e.g. '2026-05-02', 'custom-reports', 'Codex', 'all'
  dispatches: number;
  prompt_tokens_est: number;    // Claude side — what we paid to dispatch
  output_tokens: number;        // A: subagent output (overstates)
  input_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;         // subagent total (input + output + reasoning)
  net_tokens: number;           // B headline: output - prompt_est
  wall_clock_ms: number;
  failed: number;               // exit_code != 0
}

export interface SavingsReport {
  metric_definition: {
    headline: "net = output_tokens - prompt_tokens_est (B)";
    also_visible: "output_tokens alone (A)";
    note: string;
  };
  filters: { since: string | null; agent: string | null; group_by: string };
  totals: SavingsBucket;
  buckets: SavingsBucket[];
}

function resolveSince(since?: string): string | null {
  if (!since) return null;
  const m = since.match(/^(\d+)([dwm])$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = unit === "d" ? n : unit === "w" ? n * 7 : n * 30;
    const ms = days * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
  }
  return since;
}

function emptyBucket(key: string): SavingsBucket {
  return {
    key,
    dispatches: 0,
    prompt_tokens_est: 0,
    output_tokens: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    net_tokens: 0,
    wall_clock_ms: 0,
    failed: 0,
  };
}

export function savingsReport(db: DB, args: SavingsArgs = {}): SavingsReport {
  const groupBy = args.group_by ?? "none";
  const sinceTs = resolveSince(args.since);

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (sinceTs) {
    where.push("created_at >= @since");
    params.since = sinceTs;
  }
  if (args.agent) {
    where.push("agent = @agent");
    params.agent = args.agent;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let groupExpr: string;
  switch (groupBy) {
    case "day":
      groupExpr = "substr(created_at, 1, 10)";
      break;
    case "module":
      groupExpr = "COALESCE(module, '(none)')";
      break;
    case "agent":
      groupExpr = "agent";
      break;
    default:
      groupExpr = "'all'";
  }

  const sql = `
    SELECT
      ${groupExpr}                                  AS key,
      COUNT(*)                                      AS dispatches,
      COALESCE(SUM(prompt_tokens_est), 0)           AS prompt_tokens_est,
      COALESCE(SUM(output_tokens), 0)               AS output_tokens,
      COALESCE(SUM(input_tokens), 0)                AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0)         AS cached_input_tokens,
      COALESCE(SUM(reasoning_tokens), 0)            AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0)                AS total_tokens,
      COALESCE(SUM(wall_clock_ms), 0)               AS wall_clock_ms,
      SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) AS failed
    FROM dispatches
    ${whereSql}
    GROUP BY key
    ORDER BY key DESC
  `;

  const rows = db.prepare(sql).all(params) as any[];

  const buckets: SavingsBucket[] = rows.map((r) => ({
    key: String(r.key),
    dispatches: Number(r.dispatches),
    prompt_tokens_est: Number(r.prompt_tokens_est),
    output_tokens: Number(r.output_tokens),
    input_tokens: Number(r.input_tokens),
    cached_input_tokens: Number(r.cached_input_tokens),
    reasoning_tokens: Number(r.reasoning_tokens),
    total_tokens: Number(r.total_tokens),
    net_tokens: Number(r.output_tokens) - Number(r.prompt_tokens_est),
    wall_clock_ms: Number(r.wall_clock_ms),
    failed: Number(r.failed ?? 0),
  }));

  const totals = buckets.reduce<SavingsBucket>((acc, b) => {
    acc.dispatches += b.dispatches;
    acc.prompt_tokens_est += b.prompt_tokens_est;
    acc.output_tokens += b.output_tokens;
    acc.input_tokens += b.input_tokens;
    acc.cached_input_tokens += b.cached_input_tokens;
    acc.reasoning_tokens += b.reasoning_tokens;
    acc.total_tokens += b.total_tokens;
    acc.wall_clock_ms += b.wall_clock_ms;
    acc.failed += b.failed;
    return acc;
  }, emptyBucket("totals"));
  totals.net_tokens = totals.output_tokens - totals.prompt_tokens_est;

  return {
    metric_definition: {
      headline: "net = output_tokens - prompt_tokens_est (B)",
      also_visible: "output_tokens alone (A)",
      note: "prompt_tokens_est is chars/4 ceiling — heuristic, not exact tokenizer count.",
    },
    filters: {
      since: sinceTs,
      agent: args.agent ?? null,
      group_by: groupBy,
    },
    totals,
    buckets,
  };
}

export function formatSavingsReport(r: SavingsReport): string {
  const lines: string[] = [];
  lines.push("=== Collab dispatch savings ===");
  lines.push(`  metric: ${r.metric_definition.headline}`);
  lines.push(
    `  filters: since=${r.filters.since ?? "all"} agent=${r.filters.agent ?? "all"} group_by=${r.filters.group_by}`,
  );
  lines.push("");
  lines.push(
    `Totals: ${r.totals.dispatches} dispatch(es)` +
      (r.totals.failed > 0 ? ` (${r.totals.failed} failed)` : ""),
  );
  lines.push(`  prompt_tokens_est (paid):   ${r.totals.prompt_tokens_est.toLocaleString()}`);
  lines.push(`  output_tokens (A):          ${r.totals.output_tokens.toLocaleString()}`);
  lines.push(`  net (B headline):           ${r.totals.net_tokens.toLocaleString()}`);
  lines.push(`  cached_input_tokens:        ${r.totals.cached_input_tokens.toLocaleString()}`);
  lines.push(`  wall_clock:                 ${(r.totals.wall_clock_ms / 1000).toFixed(1)}s`);
  if (r.buckets.length > 1 || r.filters.group_by !== "none") {
    lines.push("");
    lines.push(`Per-${r.filters.group_by}:`);
    for (const b of r.buckets) {
      lines.push(
        `  ${b.key.padEnd(20)} n=${b.dispatches.toString().padStart(3)} ` +
          `out=${b.output_tokens.toString().padStart(7)} ` +
          `prompt=${b.prompt_tokens_est.toString().padStart(6)} ` +
          `net=${b.net_tokens.toString().padStart(7)}`,
      );
    }
  }
  return lines.join("\n");
}
