import type { DB } from "../db.js";

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
  recent_decisions: Array<{ id: number; title: string; summary: string }>;
  top_gotchas: Array<{ id: number; summary: string }>;
  recent_handoffs: Array<{
    id: number;
    title: string;
    summary: string;
    agent: string | null;
    created_at: string;
  }>;
}

// Slug rules match the schema CHECK in 0001_init.sql:
// lowercase alphanumeric + hyphens, 1-60 chars, no underscores, must start with alphanumeric.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;

// ------------------------------------------------------------
// initModule — idempotent via INSERT OR IGNORE
// ------------------------------------------------------------
export function initModule(db: DB, args: InitModuleArgs): { slug: string } {
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
export function getModule(db: DB, slug: string): ModuleCard {
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
      recent_handoffs: [],
    };
  }

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
  const indexes = db
    .prepare(
      `
    SELECT id, title, summary FROM entries
    WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)
      AND category = 'Index' AND deprecated = 0
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug) as ModuleCard["indexes"];

  const recent_decisions = db
    .prepare(
      `
    SELECT id, title, summary FROM entries
    WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)
      AND type = 'decision' AND deprecated = 0
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug) as ModuleCard["recent_decisions"];

  const top_gotchas = db
    .prepare(
      `
    SELECT id, summary FROM entries
    WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)
      AND type = 'gotcha' AND deprecated = 0
    ORDER BY created_at DESC LIMIT 5
  `
    )
    .all(slug) as ModuleCard["top_gotchas"];

  const recent_handoffs = db
    .prepare(
      `
    SELECT id, title, summary, agent, created_at FROM entries
    WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?)
      AND type = 'handoff' AND deprecated = 0
    ORDER BY created_at DESC LIMIT 3
  `
    )
    .all(slug) as ModuleCard["recent_handoffs"];

  return { module, active_tasks, indexes, recent_decisions, top_gotchas, recent_handoffs };
}
