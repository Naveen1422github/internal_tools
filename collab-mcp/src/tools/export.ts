import type { DB } from "../db.js";
import type { EntryType } from "./add.js";

export interface ExportArgs {
  format: "json" | "markdown";
  module?: string;
  task?: string;
  type?: EntryType;
  since?: string; // ISO date or "7d" / "2w" / "1m"
  include_deprecated?: boolean; // default false
}

export interface ExportResult {
  format: "json" | "markdown";
  entry_count: number;
  body: string; // the exported text; caller writes to disk if needed
}

interface ExportEntryRow {
  id: number;
  type: EntryType;
  kind: string;
  title: string;
  summary: string | null;
  description: string | null;
  status: string | null;
  agent: string | null;
  module: string | null;
  task_id: string | null;
  tokens_estimate: number | null;
  rollup_of_task: string | null;
  deprecated: number;
  created_at: string;
  updated_at: string;
}

interface RefRow {
  entry_id: number;
  ref_type: string;
  ref_value: string;
}

function parseSince(since: string): string {
  // ISO date like 2026-04-01 (optionally with time) — pass through.
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;
  const m = since.match(/^(\d+)([dwm])$/);
  if (!m) {
    throw new Error(
      `invalid 'since' value: ${since} \n(expected '7d', '2w', '1m', or ISO date)`,
    );
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const d = new Date();
  if (unit === "d") d.setUTCDate(d.getUTCDate() - n);
  else if (unit === "w") d.setUTCDate(d.getUTCDate() - n * 7);
  else if (unit === "m") d.setUTCMonth(d.getUTCMonth() - n);
  // SQLite 'YYYY-MM-DD HH:MM:SS' format matches entries.created_at
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function toEntryId(id: number): string {
  return `E-${String(id).padStart(5, "0")}`;
}

function nonEmptyFilters(args: ExportArgs): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (args.module) filters.module = args.module;
  if (args.task) filters.task = args.task;
  if (args.type) filters.type = args.type;
  if (args.since) filters.since = args.since;
  if (args.include_deprecated === true) filters.include_deprecated = true;
  return filters;
}

function renderMarkdown(
  exportedAt: string,
  filters: Record<string, unknown>,
  entries: Array<ExportEntryRow & { refs: Array<{ ref_type: string; ref_value: string }> }>,
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`exported_at: ${exportedAt}`);
  lines.push("filters:");
  const keys = Object.keys(filters);
  if (keys.length === 0) {
    lines.push("  {}");
  } else {
    for (const k of keys) {
      lines.push(`  ${k}: ${String(filters[k])}`);
    }
  }
  lines.push("---");
  lines.push("");

  for (const e of entries) {
    lines.push(`## [${toEntryId(e.id)}] ${e.type} — ${e.title}`);

    const metaBits: string[] = [];
    if (e.agent) metaBits.push(`agent: ${e.agent}`);
    if (e.module) metaBits.push(`module: ${e.module}`);
    if (e.task_id) metaBits.push(`task: ${e.task_id}`);
    if (e.status) metaBits.push(`status: ${e.status}`);
    lines.push(
      `- created: ${e.created_at}${metaBits.length > 0 ? " | " + metaBits.join(" | ") : ""}`,
    );

    if (e.refs.length > 0) {
      lines.push(`- refs: ${e.refs.map((r) => `${r.ref_type}:${r.ref_value}`).join(", ")}`);
    }

    lines.push("");
    lines.push(e.summary ?? "(no summary)");
    lines.push("");
    lines.push(e.description ?? "(no description)");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

export function exportEntries(db: DB, args: ExportArgs): ExportResult {
  const where: string[] = [];
  const params: unknown[] = [];

  if (args.include_deprecated !== true) {
    where.push("deprecated = 0");
  }
  if (args.module) {
    where.push("module = ?");
    params.push(args.module);
  }
  if (args.task) {
    where.push("task_id = ?");
    params.push(args.task);
  }
  if (args.type) {
    where.push("type = ?");
    params.push(args.type);
  }
  if (args.since) {
    where.push("created_at >= ?");
    params.push(parseSince(args.since));
  }

  const sql = `
    SELECT
      id, type, kind, title, summary, description, status, agent, module, task_id,
      tokens_estimate, rollup_of_task, deprecated, created_at, updated_at
    FROM entries
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at ASC, id ASC
  `;
  const rows = db.prepare(sql).all(...params) as ExportEntryRow[];

  const ids = rows.map((r) => r.id);
  const refsByEntryId = new Map<number, Array<{ ref_type: string; ref_value: string }>>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const refRows = db
      .prepare(
        `SELECT entry_id, ref_type, ref_value FROM refs WHERE entry_id IN (${placeholders}) ORDER BY entry_id ASC, ref_type ASC, ref_value ASC`,
      )
      .all(...ids) as RefRow[];

    for (const rr of refRows) {
      const list = refsByEntryId.get(rr.entry_id) ?? [];
      list.push({ ref_type: rr.ref_type, ref_value: rr.ref_value });
      refsByEntryId.set(rr.entry_id, list);
    }
  }

  const entries = rows.map((r) => ({
    ...r,
    refs: refsByEntryId.get(r.id) ?? [],
  }));

  const exported_at = new Date().toISOString();
  const filters = nonEmptyFilters(args);

  let body: string;
  if (args.format === "json") {
    body = JSON.stringify({ exported_at, filters, entries }, null, 2);
  } else {
    body = renderMarkdown(exported_at, filters, entries);
  }

  return {
    format: args.format,
    entry_count: entries.length,
    body,
  };
}

