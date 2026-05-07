import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import type { EntryType, Agent, RefInput } from "./add.js";

// ------------------------------------------------------------
// Public types
// ------------------------------------------------------------
export interface RollupArgs {
  task_id?: string;                       // rollup one task's entries
  since?: string;                         // OR: ISO date | '7d' | '2w' | '1m'
  group_by?: "module" | "task";           // required when 'since' is given
  agent?: Agent;                          // who initiated the rollup; stored on the new entry
  dry_run?: boolean;                      // if true, compute groups but do not persist
}

export interface RollupGroup {
  key: string;                            // module slug or task id this group represents
  kind: "module" | "task";                // how entries were grouped
  entry_ids: number[];
  type_counts: Partial<Record<EntryType, number>>;
  window_start: string;                   // earliest created_at in the group
  window_end: string;                     // latest created_at in the group
  entries: Array<{
    id: number;
    type: EntryType;
    title: string;
    summary: string;
    agent: Agent | null;
    module: string | null;
    task_id: string | null;
    created_at: string;
  }>;
}

export interface RollupResult {
  groups: RollupGroup[];
  created_entries: Array<{ id: number; group_key: string; group_kind: "module" | "task" }>;
  deprecated_count: number;
  dry_run: boolean;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function parseSince(since: string): string {
  // ISO date like 2026-04-01 (optionally with time) — pass through.
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;
  const m = since.match(/^(\d+)([dwm])$/);
  if (!m) throw new Error(`invalid 'since' value: ${since} (expected '7d', '2w', '1m', or ISO date)`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const d = new Date();
  if (unit === "d") d.setUTCDate(d.getUTCDate() - n);
  else if (unit === "w") d.setUTCDate(d.getUTCDate() - n * 7);
  else if (unit === "m") d.setUTCMonth(d.getUTCMonth() - n);
  // SQLite 'YYYY-MM-DD HH:MM:SS' format matches entries.created_at
  return d.toISOString().slice(0, 19).replace("T", " ");
}

interface RawEntryRow {
  id: number;
  type: EntryType;
  title: string;
  summary: string;
  agent: Agent | null;
  module: string | null;
  task_id: string | null;
  created_at: string;
}

function selectEntries(db: DB, args: RollupArgs): RawEntryRow[] {
  // Exclude rollup entries (don't roll up rollups) and already-deprecated rows.
  if (args.task_id) {
    return db
      .prepare(
        `SELECT id, type, title, summary, agent, module, task_id, created_at
         FROM entries
         WHERE task_id = ?
           AND deprecated = 0
           AND type != 'rollup'
         ORDER BY created_at ASC`,
      )
      .all(args.task_id) as RawEntryRow[];
  }
  const sinceIso = parseSince(args.since ?? "7d");
  return db
    .prepare(
      `SELECT id, type, title, summary, agent, module, task_id, created_at
       FROM entries
       WHERE created_at >= ?
         AND deprecated = 0
         AND type != 'rollup'
       ORDER BY created_at ASC`,
    )
    .all(sinceIso) as RawEntryRow[];
}

function groupEntries(
  rows: RawEntryRow[],
  mode: "task" | "module" | "single-task",
  explicitTaskId?: string,
): RollupGroup[] {
  const buckets = new Map<string, RawEntryRow[]>();

  for (const r of rows) {
    let key: string | null;
    if (mode === "single-task") key = explicitTaskId!;
    else if (mode === "task") key = r.task_id;
    else key = r.module;
    if (!key) continue; // skip entries missing the group key (e.g. no module set)
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }

  const kind: "module" | "task" = mode === "module" ? "module" : "task";
  const groups: RollupGroup[] = [];
  for (const [key, entries] of buckets) {
    const type_counts: Partial<Record<EntryType, number>> = {};
    for (const e of entries) type_counts[e.type] = (type_counts[e.type] ?? 0) + 1;
    groups.push({
      key,
      kind,
      entry_ids: entries.map((e) => e.id),
      type_counts,
      window_start: entries[0].created_at,
      window_end: entries[entries.length - 1].created_at,
      entries,
    });
  }
  return groups;
}

// ------------------------------------------------------------
// formatRollupBody
//
// Build the summary + description body stored on the new rollup entry.
//   - summary:     <= 200 chars, one line, used in the search list view
//   - description: full body, stored on the entry and searchable via FTS5
// ------------------------------------------------------------
function formatRollupBody(group: RollupGroup): { summary: string; description: string } {
  const counts = Object.entries(group.type_counts)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([t, n]) => `${n} ${t}${(n ?? 0) > 1 ? "s" : ""}`)
    .join(", ");
  const window = `${group.window_start.slice(0, 10)}→${group.window_end.slice(0, 10)}`;
  const summary = `[${group.kind}=${group.key}] ${group.entry_ids.length} entries (${counts}) ${window}`.slice(0, 200);

  const byType = new Map<EntryType, RollupGroup["entries"]>();
  for (const e of group.entries) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }
  const sections = Array.from(byType.entries()).map(([t, es]) => {
    const lines = es.map((e) => {
      const id = `[E-${String(e.id).padStart(5, "0")}]`;
      const date = e.created_at.slice(0, 10);
      const agent = e.agent ? `${e.agent}: ` : "";
      return `- ${id} ${date} | ${agent}${e.title} — ${e.summary}`;
    });
    return `## ${t} (${es.length})\n${lines.join("\n")}`;
  });
  const header = `Rollup for ${group.kind}=${group.key} | ${group.window_start} → ${group.window_end}`;
  return { summary, description: `${header}\n\n${sections.join("\n\n")}` };
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------
export function rollup(db: DB, args: RollupArgs): RollupResult {
  // Validate: exactly one of {task_id} or {since} must be present.
  const hasTask = !!args.task_id;
  const hasSince = !!args.since;
  if (hasTask === hasSince) {
    throw new Error("rollup requires exactly one of 'task_id' or 'since'");
  }
  if (hasSince && !args.group_by) {
    throw new Error("when 'since' is provided, 'group_by' ('module' | 'task') is required");
  }

  const rows = selectEntries(db, args);
  if (rows.length === 0) {
    return { groups: [], created_entries: [], deprecated_count: 0, dry_run: !!args.dry_run };
  }

  const mode: "single-task" | "task" | "module" = hasTask
    ? "single-task"
    : (args.group_by as "task" | "module");
  const groups = groupEntries(rows, mode, args.task_id);

  const created: RollupResult["created_entries"] = [];
  let deprecated_count = 0;

  if (args.dry_run) {
    return { groups, created_entries: [], deprecated_count: 0, dry_run: true };
  }

  // rollup.ts owns its own insert path because addEntry() rejects type='rollup'
  // (that guard exists to prevent callers creating rollups via the public API).
  const insertRollup = db.prepare(`
    INSERT INTO entries (
      type, kind, title, summary, description,
      status, agent, module, task_id, rollup_of_task, tokens_estimate
    ) VALUES (
      'rollup', 'signal', @title, @summary, @description,
      'active', @agent, @module, @task_id, @rollup_of_task, @tokens_estimate
    )
  `);
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)`,
  );
  const deprecateStmt = db.prepare("UPDATE entries SET deprecated = 1 WHERE id = ?");

  // Wrap each group's (insert rollup + refs + deprecate originals) in a transaction
  // so a mid-write failure can't leave originals deprecated without a rollup entry.
  const runGroup = db.transaction((group: RollupGroup): number => {
    const { summary, description } = formatRollupBody(group);
    if (!summary || summary.trim().length === 0) {
      throw new Error("formatRollupBody returned empty summary");
    }
    if (summary.length > 200) {
      throw new Error(`formatRollupBody summary exceeds 200 chars (got ${summary.length})`);
    }
    const result = insertRollup.run({
      title: `Rollup: ${group.kind}=${group.key} (${group.entry_ids.length} entries)`,
      summary,
      description: description ?? null,
      agent: args.agent ?? null,
      module: group.kind === "module" ? group.key : null,
      task_id: group.kind === "task" ? group.key : null,
      rollup_of_task: group.kind === "task" ? group.key : null,
      tokens_estimate: estimateTokens(description),
    });
    const newId = Number(result.lastInsertRowid);
    const refs: RefInput[] = group.entry_ids.map((id) => ({
      ref_type: "entry",
      ref_value: String(id),
    }));
    for (const r of refs) insertRef.run(newId, r.ref_type, r.ref_value);
    for (const id of group.entry_ids) deprecateStmt.run(id);
    return newId;
  });

  for (const group of groups) {
    const newId = runGroup(group);
    created.push({ id: newId, group_key: group.key, group_kind: group.kind });
    deprecated_count += group.entry_ids.length;
  }

  return { groups, created_entries: created, deprecated_count, dry_run: false };
}
