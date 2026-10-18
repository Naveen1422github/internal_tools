// file: core/src/access/can.ts
// RnR S2 (R8, role layer): the laptop's permission check. Every core write op
// asks before writing, so the CLI, web and MCP refuse what the person's role in
// a team project doesn't allow, before any network call. UX and an AI guard
// only: the post office stays the real enforcer (R4/R7).
import type { DB } from "../db.js";
import { keysOf, labelOf } from "./catalog.js";

export type Actor = "human" | "ai";
export type CanResult = { ok: true } | { ok: false; reason: string };

/** A write the person's role doesn't allow (R8). Same wording as the office's 403. */
export class AccessDeniedError extends Error {
  constructor(message: string, readonly key: string, readonly projectUlid: string | null) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

// Process-wide default actor, like setAllocator. The MCP server sets "ai".
let defaultActor: Actor = "human";
export function setDefaultActor(a: Actor): void { defaultActor = a; }
export function getDefaultActor(): Actor { return defaultActor; }

const ACTIVE = new Set([...keysOf("project"), ...keysOf("office")]);

/** The office's refusal sentence (post-office/src/access.ts, classify.ts). */
export function refusalText(key: string, code: string): string {
  return `You need "${labelOf(key)}" (${key}) in ${code} to do this`;
}

// Prepared once per DB (like post-office's prep). No in-memory cache of the
// answers: access_cache is written by the courier, another process. A prepare
// that fails (an older migration: no projects / access_cache / clock table yet)
// is not remembered, so a later migrate on the same handle is picked up.
type Stmt = { get(...params: unknown[]): unknown };
const SQL = {
  team: `SELECT code FROM projects WHERE ulid = ? AND mode = 'team'`,
  keyHeld: `SELECT EXISTS (SELECT 1 FROM json_each(keys) WHERE value = ?) AS has FROM access_cache WHERE scope_key = ?`,
  noteProject: `SELECT project_ulid FROM entries WHERE ulid = ?`,
  createdSite: `SELECT c.site_id FROM entries__crsql_pks p
                  JOIN entries__crsql_clock c ON c.key = p.__crsql_key AND c.col_name = 'created_at'
                 WHERE p.ulid = ?`,
} as const;
const stmts = new WeakMap<DB, Partial<Record<keyof typeof SQL, Stmt>>>();
function prep(db: DB, name: keyof typeof SQL): Stmt | null {
  let m = stmts.get(db);
  if (!m) stmts.set(db, (m = {}));
  const hit = m[name];
  if (hit) return hit;
  try {
    return (m[name] = db.prepare(SQL[name]));
  } catch {
    return null;
  }
}

/** The code of a team project, or null (solo, unknown, or before 0009). */
function teamCode(db: DB, projectUlid: string): string | null {
  const r = prep(db, "team")?.get(projectUlid) as { code: string } | undefined;
  return r ? r.code : null;
}

/**
 * May the person do `key` in this project? Solo, no project or E => ok without
 * reading access_cache. A team project: one point read by scope_key; no row =>
 * ok (S2-4: not cached yet, the office decides); an inactive key => refused
 * (S2-2: it guards nothing yet). `actor` is accepted and ignored until S4.
 */
export function can(db: DB, projectUlid: string | null, key: string, actor: Actor = defaultActor): CanResult {
  void actor; // R9/R10 (AI settings) come later: role layer only
  if (!projectUlid) return { ok: true };
  const code = teamCode(db, projectUlid);
  if (code === null) return { ok: true };
  if (!ACTIVE.has(key)) return { ok: false, reason: refusalText(key, code) };
  const r = prep(db, "keyHeld")?.get(key, projectUlid) as { has: number } | undefined;
  if (!r || r.has === 1) return { ok: true };
  return { ok: false, reason: refusalText(key, code) };
}

/** can() or throw AccessDeniedError. */
export function assertCan(db: DB, projectUlid: string | null, key: string): void {
  const r = can(db, projectUlid, key);
  if (!r.ok) throw new AccessDeniedError(r.reason, key, projectUlid);
}

/** The project a note belongs to, or null (E, unknown, or before 0009). */
export function projectOfNote(db: DB, ulid: string | null | undefined): string | null {
  if (!ulid) return null;
  const r = prep(db, "noteProject")?.get(ulid) as { project_ulid: string | null } | undefined;
  return r?.project_ulid ?? null;
}

/**
 * S2-6: a note is "own" when its created_at cell was written on this laptop
 * (its clock row's site is local, ordinal 0). A UX guess only: the office's
 * po_note_owners decides. No clock (sync off) or no clock row => own: nothing
 * can have arrived from another device.
 */
export function isOwnNote(db: DB, ulid: string): boolean {
  const r = prep(db, "createdSite")?.get(ulid) as { site_id: number } | undefined;
  return !r || r.site_id === 0;
}

/** assertCan on the note's own project. */
export function assertCanNote(db: DB, ulid: string | null | undefined, key: string): void {
  assertCan(db, projectOfNote(db, ulid), key);
}

/** An edit: note.edit.own for an own note (S2-6), else note.edit.any. Ownership is read only in a team project. */
export function assertCanEdit(db: DB, ulid: string | null | undefined): void {
  const project = projectOfNote(db, ulid);
  if (!project || teamCode(db, project) === null) return;
  assertCan(db, project, isOwnNote(db, ulid as string) ? "note.edit.own" : "note.edit.any");
}
