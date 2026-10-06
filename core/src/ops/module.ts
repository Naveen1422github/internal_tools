import type { DB } from "../db.js";
import { hasSeries, liveEntry } from "../schema.js";
import { getHubStatus, type HubState, type HubCoverage } from "./hub.js";
import { ensureCrsqlite } from "../sync/extension.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface InitModuleArgs {
  slug: string;
  name?: string;
  summary?: string;
  description?: string;
  current_goal?: string;
}

export interface ModuleRow {
  slug: string;
  name: string | null;
  summary: string | null;
  description: string | null;
  current_goal: string | null;
  status: string;
}

export interface ModuleCard {
  module: ModuleRow | null;
  active_tasks: Array<{ id: string; title: string; status: string; priority: string | null }>;
  indexes: Array<{ id: number; title: string; summary: string }>;
  // `series` is present only on a project note (SH); absent = E.
  recent_decisions: Array<{ id: number; title: string; summary: string; series?: string }>;
  top_gotchas: Array<{ id: number; summary: string; series?: string }>;
  needs_merge: Array<{ id: number; title: string }>;
  recent_handoffs: Array<{
    id: number;
    title: string;
    summary: string;
    agent: string | null;
    created_at: string;
    series?: string;
  }>;
  hub: { state: HubState; coverage: HubCoverage | null };
}

// Slug rules match the schema CHECK in 0001_init.sql:
// lowercase alphanumeric + hyphens, 1-60 chars, no underscores, must start with alphanumeric.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;

// ------------------------------------------------------------
// initModule — idempotent via INSERT OR IGNORE
// ------------------------------------------------------------
export function initModule(db: DB, args: InitModuleArgs): { slug: string } {
  ensureCrsqlite(db);
  if (!SLUG_REGEX.test(args.slug)) {
    throw new Error(
      `invalid slug '${args.slug}': must be lowercase alphanumeric or hyphens, 1-60 chars, no underscores, start with alphanumeric`
    );
  }

  db.prepare(
    `
    INSERT OR IGNORE INTO modules (slug, name, summary, description, current_goal)
    VALUES (@slug,@name,@summary,@description,@current_goal)
  `
  ).run({
    slug: args.slug,
    name: args.name ?? null,
    summary: args.summary ?? null,
    description: args.description ?? null,
    current_goal: args.current_goal ?? null,
  });

  return { slug: args.slug };
}

// ------------------------------------------------------------
// getModule — full module card per DESIGN.md §6
// ------------------------------------------------------------
/**
 * A project note carries its series (`SH`) on the card; E notes don't, so a
 * card without projects is unchanged (stage B1, Rule 1).
 */
function withSeries<T extends { series?: string | null }>(rows: T[]): T[] {
  return rows.map(({ series, ...r }) => (series && series !== "E" ? { ...r, series } : r) as T);
}

export interface GetModuleOptions {
  /** Only this project's notes in the recent decisions / gotchas / handoffs lists (stage B1, P4). */
  project_ulid?: string;
}

export function getModule(db: DB, slug: string, opts: GetModuleOptions = {}): ModuleCard {
  const module = db
    .prepare(
      `SELECT slug, name, summary, description, current_goal, status FROM modules WHERE slug = ?`
    )
    .get(slug) as ModuleRow | undefined;

  if (!module) {
    return {
      module: null,
      active_tasks: [],
      indexes: [],
      recent_decisions: [],
      top_gotchas: [],
      needs_merge: [],
      recent_handoffs: [],
      hub: { state: "unset", coverage: null },
    };
  }

  const live = liveEntry(db, "entries"); // tombstones never appear on the card
  const series = hasSeries(db);
  const seriesCol = series ? "series" : "'E' AS series";
  // Before 0009 no note has a project, so a project scope matches nothing.
  const scoped = opts.project_ulid === undefined ? "" : series ? "AND project_ulid = ?" : "AND 0 = 1";
  const scopeArgs = opts.project_ulid !== undefined && series ? [opts.project_ulid] : [];

  const active_tasks = db
    .prepare(
      `
    SELECT id, title, status, priority FROM tasks
    WHERE module = ? AND status != 'done'
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      updated_at DESC
  `
    )
    .all(slug) as ModuleCard["active_tasks"];

  // Membership is now many-to-many: match any entry that has an entry_modules
  // row for this slug (so multi-module entries surface in EVERY module they
  // belong to), not just entries whose primary entries.module = slug.
  // Claude reads the structured card, so the token budget is enforced here (collab E-704).
  const hubFull = getHubStatus(db, slug, Number.MAX_SAFE_INTEGER);
  const indexes: ModuleCard["indexes"] =
    hubFull.state === "ok"
      ? []
      : (db
    .prepare(
      `
    SELECT id, title, summary FROM entries
    WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
      AND category = 'Index' AND deprecated = 0
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug) as ModuleCard["indexes"]);

  const recent_decisions = withSeries(db
    .prepare(
      `
    SELECT id, title, summary, ${seriesCol} FROM entries
    WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
      AND type = 'decision' AND deprecated = 0 ${scoped}
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug, ...scopeArgs) as ModuleCard["recent_decisions"]);

  const top_gotchas = withSeries(db
    .prepare(
      `
    SELECT id, summary, ${seriesCol} FROM entries
    WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
      AND type = 'gotcha' AND deprecated = 0 ${scoped}
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug, ...scopeArgs) as ModuleCard["top_gotchas"]);

  const recent_handoffs = withSeries(db
    .prepare(
      `
    SELECT id, title, summary, agent, created_at, ${seriesCol} FROM entries
    WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
      AND type = 'handoff' AND deprecated = 0 ${scoped}
    ORDER BY created_at DESC LIMIT 3
  `
    )
    .all(slug, ...scopeArgs) as ModuleCard["recent_handoffs"]);

  // Keyed by series and number: E-1 and SH-1 are different notes.
  const cardKey = (e: { id: number; series?: string }) => `${e.series ?? "E"}:${e.id}`;
  const onCard = new Set([...top_gotchas, ...recent_decisions].map(cardKey));
  let hub: ModuleCard["hub"] = hubFull;
  if (hubFull.state === "ok" && hubFull.coverage) {
    const all = hubFull.coverage.unlinked;
    hub = {
      state: "ok",
      coverage: {
        ...hubFull.coverage,
        unlinked: all.filter((u) => !onCard.has(cardKey(u))).slice(0, 3),
        unlinked_on_card: all.filter((u) => onCard.has(cardKey(u))).map((u) => u.id),
      },
    };
  }
  // Spec D8: forks the post office could not merge wait here for a person.
  const hasNeedsMerge = !!db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get();
  const needs_merge = hasNeedsMerge
    ? (db.prepare(
        `SELECT id, title FROM entries
          WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${live}
            AND needs_merge = 1 AND deprecated = 0
          ORDER BY created_at DESC LIMIT 5`,
      ).all(slug) as ModuleCard["needs_merge"])
    : [];

  return { module, active_tasks, indexes, recent_decisions, top_gotchas, needs_merge, recent_handoffs, hub };
}

// ------------------------------------------------------------
// upsertModule / deleteModule — the REST server's module writes, moved here
// unchanged (collab E-720): every write to a synced table goes through core.
// ------------------------------------------------------------
export interface UpsertModuleArgs {
  slug: string;
  name?: string | null;
  summary?: string | null;
  description?: string | null;
  current_goal?: string | null;
  status?: string;
}

/** Insert a module, or overwrite every field of an existing one (missing fields become NULL, status 'active'). */
export function upsertModule(db: DB, args: UpsertModuleArgs): { slug: string } {
  ensureCrsqlite(db);
  if (!args.slug || !SLUG_REGEX.test(args.slug)) {
    throw new Error(
      `invalid slug '${args.slug}': must be lowercase alphanumeric or hyphens, 1-60 chars, no underscores, start with alphanumeric`
    );
  }
  db.prepare(`
    INSERT INTO modules (slug, name, summary, description, current_goal, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name,
      summary=excluded.summary,
      description=excluded.description,
      current_goal=excluded.current_goal,
      status=excluded.status
  `).run(args.slug, args.name ?? null, args.summary ?? null, args.description ?? null, args.current_goal ?? null, args.status || "active");
  return { slug: args.slug };
}

/** Delete a module, unless entries or tasks still point at it (better to surface than orphan). */
export function deleteModule(
  db: DB, slug: string,
): { deleted: true } | { deleted: false; entry_count: number; task_count: number } {
  ensureCrsqlite(db);
  const refs = db.prepare(`
    SELECT (SELECT COUNT(*) FROM entries WHERE module=?) AS entry_count,
           (SELECT COUNT(*) FROM tasks WHERE module=?) AS task_count
  `).get(slug, slug) as { entry_count: number; task_count: number };
  if (refs.entry_count > 0 || refs.task_count > 0) {
    return { deleted: false, entry_count: refs.entry_count, task_count: refs.task_count };
  }
  db.prepare("DELETE FROM modules WHERE slug=?").run(slug);
  return { deleted: true };
}
