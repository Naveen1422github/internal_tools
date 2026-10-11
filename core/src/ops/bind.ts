// file: core/src/ops/bind.ts
// Module -> project binding: a note's project follows its PRIMARY module, so
// nobody has to remember to pass `project`. LOCAL only (table project_modules,
// 0011): a binding is this laptop's own setting and is never sent anywhere.
import type { DB } from "../db.js";
import { hasProjectModules } from "../schema.js";
import { findProject, isLeftProject, leftProjectError, notFound, type Project } from "../projects.js";

export interface Binding {
  module: string;
  project_ulid: string;
  project_code: string;
  project_name: string;
}

/** What a bind/unbind changed: the project code before and after (null = none). */
export interface BindChange {
  module: string;
  from: string | null;
  to: string | null;
}

function needs0011(db: DB): void {
  if (!hasProjectModules(db)) {
    throw new Error("[collab] module binding needs migration 0011 (project_modules). Restart the MCP server (or run `collab web` once): it applies migrations on start.");
  }
}

const codeOf = (db: DB, ulid: string): string | null =>
  (db.prepare(`SELECT code FROM projects WHERE ulid = ?`).get(ulid) as { code: string } | undefined)?.code ?? null;

function boundUlid(db: DB, module: string): string | null {
  return (db.prepare(`SELECT project_ulid FROM project_modules WHERE module = ?`).get(module) as { project_ulid: string } | undefined)?.project_ulid ?? null;
}

/** Bind `module` to a project (code or ULID); a module has one binding, so re-binding replaces it. */
export function bindModule(db: DB, module: string, projectCodeOrUlid: string): BindChange {
  needs0011(db);
  const slug = String(module ?? "").trim();
  if (!db.prepare(`SELECT 1 FROM modules WHERE slug = ?`).get(slug)) {
    const known = (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
    throw new Error(`[collab] no module "${module}" in this notebook. Known: ${known.join(", ") || "none"}.`);
  }
  const p = findProject(db, projectCodeOrUlid);
  if (!p) throw notFound(db, projectCodeOrUlid);
  if (isLeftProject(p)) throw leftProjectError(p);
  const oldUlid = boundUlid(db, slug);
  db.prepare(
    `INSERT INTO project_modules (module, project_ulid) VALUES (?, ?)
       ON CONFLICT(module) DO UPDATE SET project_ulid = excluded.project_ulid, created_at = datetime('now')`,
  ).run(slug, p.ulid);
  return { module: slug, from: oldUlid ? codeOf(db, oldUlid) : null, to: p.code };
}

/** Remove a module's binding; unbinding a module that has none is a no-op (from = null). */
export function unbindModule(db: DB, module: string): BindChange {
  needs0011(db);
  const slug = String(module ?? "").trim();
  const oldUlid = boundUlid(db, slug);
  db.prepare(`DELETE FROM project_modules WHERE module = ?`).run(slug);
  return { module: slug, from: oldUlid ? codeOf(db, oldUlid) : null, to: null };
}

/** Every binding, by module. Before 0011 there are none. */
export function listBindings(db: DB): Binding[] {
  if (!hasProjectModules(db)) return [];
  return db.prepare(
    `SELECT b.module, b.project_ulid, p.code AS project_code, p.name AS project_name
       FROM project_modules b JOIN projects p ON p.ulid = b.project_ulid ORDER BY b.module`,
  ).all() as Binding[];
}

/** The project `module` is bound to, or null (unbound, or before 0011). A left project is returned as is: the caller refuses it. */
export function boundProjectFor(db: DB, module: string | undefined | null): Project | null {
  if (!module || !hasProjectModules(db)) return null;
  const ulid = boundUlid(db, module);
  return ulid ? findProject(db, ulid) : null;
}

/** `collab project bind/unbind`, in words (CLI and MCP print the same line). */
export function bindChangeLine(c: BindChange): string {
  if (c.to) return c.from && c.from !== c.to
    ? `Module ${c.module} was bound to ${c.from}; now bound to ${c.to}. Its new notes go to ${c.to}.`
    : `Module ${c.module} is bound to ${c.to}: its new notes go to ${c.to} (this beats the folder's .collab; an explicit project beats it). Local to this laptop, never shared.`;
  return c.from ? `Module ${c.module} is no longer bound to ${c.from}.` : `Module ${c.module} had no binding.`;
}
