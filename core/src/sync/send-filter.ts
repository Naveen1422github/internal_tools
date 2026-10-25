// file: core/src/sync/send-filter.ts
// THE send rule (stage C, spec rule 5 / P7), used by both the courier's push
// and the status count, so "what is sent" and "what is waiting" can never
// disagree. One office per notebook (E-820): a team project of this notebook's
// office has projects.team = that office's po_fingerprint (E-767).
import type { DB } from "../db.js";
import { hasSeries, hasProjectLeft } from "../schema.js";
import { getSyncValue } from "./state.js";
import { entryUlidOf, type WireChange } from "./changes.js";
import { SYNC_KEYS } from "./http-allocator.js";
import { isCopiedToValue } from "../entry-write.js";
import { isEAdopted, neverSend } from "../e-project.js";

// The courier's own sync_state keys (courier/src/keys.ts COURIER_KEYS; core cannot import the courier).
export const SHARED_KEY = "shared_modules";
export const SENT_KEY = "sent_db_version";
/** JSON list of team projects that clash with a local one (written by the courier, read by doctor). */
export const PROJECT_CLASH_KEY = "project_clash";

/** send = goes to the office now; skip = never goes; hold = not now, still waiting (counts as unsent). */
export type SendVerdict = "send" | "skip" | "hold";

export interface SendContext {
  /** The team's shared modules, as last heard from the office (the E path, D10). */
  shared: Set<string>;
  /** Ulids of the team projects of THIS notebook's office. */
  teamProjects: Set<string>;
  fingerprint: string | null;
  /** E has been adopted as the shared project "emp1st" (sync_state e_project). */
  eAdopted: boolean;
  /** Ulids that never leave this laptop, whatever else is true of them. */
  neverSend: Set<string>;
  /**
   * Slugs referenced by a note sent in THIS push (filled by the caller, see
   * moduleSlugsOf). Once E is adopted a modules row goes only with them.
   */
  sentModules: Set<string>;
}

/** Where a note lives, as the send rule sees it. */
export interface NotePlace {
  /** Its primary module; for a modules row, the slug. */
  module: string | null;
  /** Its project ulid (null = no project: an E note). */
  project: string | null;
  /** No number yet (id NULL). */
  pending: boolean;
  /** Its project is in this notebook's projects table (true when it has none). */
  knownProject: boolean;
  /** Tombstoned (deleted_at set). */
  deleted: boolean;
  /** The note's row exists here (false: hard-deleted, or a modules row). */
  exists: boolean;
  /** The office refused its creation (refused_changes kind 'new', R7, ruling R-23): never sent until recovered or discarded. */
  refused: boolean;
}

export function sendContext(db: DB): SendContext {
  let shared = new Set<string>();
  try { shared = new Set(JSON.parse(getSyncValue(db, SHARED_KEY) ?? "[]") as string[]); } catch { /* none */ }
  const fingerprint = getSyncValue(db, SYNC_KEYS.fingerprint);
  const teamProjects = new Set<string>();
  if (fingerprint && hasSeries(db)) {
    // A team project this laptop left (stage B2, P11) is never sent again.
    const notLeft = hasProjectLeft(db) ? " AND left_at IS NULL" : "";
    for (const r of db.prepare(`SELECT ulid FROM projects WHERE mode = 'team' AND team = ?${notLeft}`).all(fingerprint) as Array<{ ulid: string }>) {
      teamProjects.add(r.ulid);
    }
  }
  return { shared, teamProjects, fingerprint, eAdopted: isEAdopted(db), neverSend: neverSend(db), sentModules: new Set() };
}

const GONE: NotePlace = { module: null, project: null, pending: false, knownProject: true, deleted: false, exists: false, refused: false };

/** Migration 0013 has created refused_changes. Not cached, like hasSeries. */
function hasRefusedChanges(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'refused_changes'`).get();
}

function notePlace(db: DB, ulid: string): NotePlace {
  const series = hasSeries(db);
  const e = db.prepare(
    `SELECT e.module AS module,
            ${series ? "e.project_ulid" : "NULL"} AS project,
            e.id IS NULL AS pending,
            e.deleted_at IS NOT NULL AS deleted,
            ${series ? "(e.project_ulid IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.ulid = e.project_ulid))" : "1"} AS known,
            ${hasRefusedChanges(db) ? "EXISTS (SELECT 1 FROM refused_changes r WHERE r.note_ulid = e.ulid AND r.kind = 'new')" : "0"} AS refused
       FROM entries e WHERE e.ulid = ?`,
  ).get(ulid) as { module: string | null; project: string | null; pending: number; deleted: number; known: number; refused: number } | undefined;
  if (!e) return GONE;
  return {
    module: e.module, project: e.project, pending: e.pending === 1, knownProject: e.known === 1, deleted: e.deleted === 1, exists: true,
    refused: e.refused === 1,
  };
}

/**
 * The verdict for one own change. Rules, in order:
 * 0. a pending note that is tombstoned -> skip (it never left this laptop);
 * 0b. an original's copied_to link (stage B2) -> skip: it points at a copy the
 *    team never gets (a solo project's note, rule 5);
 * -1. a ulid in never_send -> skip, every row of that note, before all else;
 * 1. a modules row -> send iff its slug is shared (E adopted: iff a note sent
 *    in this push references it, ctx.sentModules);
 * 2. a change of no note here -> skip;
 * 2b. a note whose creation the office refused (refused_changes kind 'new', R7)
 *    -> skip: the person's to recover or discard, never resent, never counted as
 *    waiting. A refused EDIT blocks nothing: later edits are judged again (R-23);
 * 3. a note in a project: a team project of this office -> pending ? hold : send;
 *    a project not in this notebook yet -> hold (pull learns it, then the
 *    project backfill sends it whole); solo, or another office's team -> skip;
 * 4. no project: pending -> hold (the courier numbers it); E adopted -> send;
 *    else primary module shared -> send; else skip.
 * `memo` caches note places for one pass (a push or a count).
 */
export function sendVerdictOf(
  db: DB, w: WireChange, ctx: SendContext, memo: Map<string, NotePlace>,
): { ulid: string | null; verdict: SendVerdict; place: NotePlace } {
  const pk = Buffer.from(w.pk, "base64");
  if (w.table === "modules") {
    const r = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
    const module = r ? String(r.cell) : null;
    const place: NotePlace = { ...GONE, module };
    // Adopted: a modules row goes only with a sent note that references it (never-send notes are never sent).
    const ok = ctx.eAdopted ? !!module && ctx.sentModules.has(module) : !!module && ctx.shared.has(module);
    return { ulid: null, verdict: ok ? "send" : "skip", place };
  }
  const ulid = entryUlidOf(db, w.table, pk);
  if (!ulid) return { ulid: null, verdict: "skip", place: GONE };
  if (ctx.neverSend.has(ulid)) return { ulid, verdict: "skip", place: GONE }; // before every other rule, for every table
  if (w.table === "refs" && isCopiedToRef(db, pk)) return { ulid, verdict: "skip", place: GONE };
  let place = memo.get(ulid);
  if (!place) { place = notePlace(db, ulid); memo.set(ulid, place); }
  return { ulid, verdict: verdictOf(place, ctx), place };
}

/** refs pk = (entry_ulid, ref_type, ref_value): a copied_to link has the marker in ref_value. */
function isCopiedToRef(db: DB, pk: Buffer): boolean {
  const cells = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).all(pk) as Array<{ cell: unknown }>;
  return cells.length >= 3 && isCopiedToValue(String(cells[2].cell));
}

function verdictOf(p: NotePlace, ctx: SendContext): SendVerdict {
  if (!p.exists) return "skip";
  if (p.refused) return "skip"; // before pending: a refused pending note is not "waiting" (R7)
  if (p.pending && p.deleted) return "skip";
  if (p.project) {
    if (ctx.teamProjects.has(p.project)) return p.pending ? "hold" : "send";
    if (!p.knownProject) return "hold";
    return "skip";
  }
  if (p.pending) return "hold";
  if (ctx.eAdopted) return "send"; // E is the team project emp1st: every non-never-send note goes
  return p.module && ctx.shared.has(p.module) ? "send" : "skip";
}

/** The module slugs these notes reference (primary or not): the modules rows that must travel with them. */
export function moduleSlugsOf(db: DB, ulids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const q = db.prepare(`SELECT module FROM entry_modules WHERE entry_ulid = ? UNION SELECT module FROM entries WHERE ulid = ? AND module IS NOT NULL`);
  for (const u of ulids) for (const r of q.all(u, u) as Array<{ module: string }>) out.add(r.module);
  return out;
}
