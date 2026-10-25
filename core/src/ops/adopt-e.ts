// file: core/src/ops/adopt-e.ts
// The laptop adopts E (local-first Task 7): once the post office has made E the
// shared project "emp1st", this laptop follows. Nothing that was private before
// becomes shared: every E note the team never had is written to never_send in
// the SAME transaction that sets e_project, so no push can ever see one without
// the other. E notes keep project_ulid NULL; nothing here touches entries.
import type { DB } from "../db.js";
import { cachedEAccess, isEAdopted, neverSend, E_ADOPTED_KEY, E_PROJECT_ULID, NEVER_SEND_KEY } from "../e-project.js";
import { getSyncValue, isSyncEnabled, setSyncValue } from "../sync/state.js";
import { SHARED_KEY } from "../sync/send-filter.js";
import { unsentSharedCount } from "../sync/overview.js";
import { postOfficeTargetFromDb } from "../sync/http-allocator.js";
import { requestJson } from "../sync/http.js";
import { hasProjectModules } from "../schema.js";
import { ensureDefaultProject, setDefaultProject } from "./default-project.js";

export interface AdoptReport {
  /** Live E notes kept on this laptop only (never sent); tombstones are kept too but not counted, like `collab sync status`. */
  neverSend: number;
  /** Modules now bound to E, sorted. */
  bound: string[];
  /** The code of the private project notes with no project now go to. */
  default: string;
  /** This device is a member of E at the office. */
  member: boolean;
}

export const NOT_ADOPTED_AT_OFFICE = "the post office hasn't adopted E yet: run collab office adopt-e there first";

function jsonList(db: DB, key: string): string[] {
  try {
    const v = JSON.parse(getSyncValue(db, key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface AdoptOptions {
  defaultProject?: string;
  extraModules?: string[];
  /** Member only, required: the E notes the office holds (GET /v1/e-held). */
  heldByOffice?: Set<string>;
}

/**
 * Adopt E on this laptop, in one transaction (all or nothing).
 * - Member of E at the office: bind every shared module not bound to another
 *   project here (and every `extraModules`) to E; never_send = this laptop's E
 *   notes, live or tombstoned, that the office does NOT hold (`heldByOffice`).
 *   Asking the office is the only exact answer: the courier's module lists are
 *   only the current shared list, never its history.
 * - Not a member: bind nothing; never_send = every E note.
 * - Either way: set the default project (`defaultProject`, else PS "Personal"),
 *   then e_project = 1.
 * Refuses: sharing off; the office hasn't adopted E; already adopted; changes
 * not yet sent (the before-adoption send rule must finish its work first).
 */
export function adoptELocal(db: DB, o: AdoptOptions = {}): AdoptReport {
  if (!isSyncEnabled(db)) throw new Error("[collab] this notebook is not sharing with a post office (collab sync setup <join code>)");
  if (isEAdopted(db)) throw new Error("[collab] E is already adopted on this laptop");
  const access = cachedEAccess(db);
  if (!access.adopted) throw new Error(`[collab] ${NOT_ADOPTED_AT_OFFICE}`);
  if (access.member && !o.heldByOffice) throw new Error("[collab] adopting E as a member needs the post office's list of the E notes it holds");
  if (!hasProjectModules(db)) throw new Error("[collab] adopting E needs migration 0011 (project_modules): restart the MCP server or run `collab web` once");

  // IMMEDIATE: the write lock is taken before the unsent count, so no other program
  // (the MCP server writes this DB too) can add an unsent change between check and write.
  return db.transaction((): AdoptReport => {
    const unsent = unsentSharedCount(db);
    if (unsent > 0) throw new Error(`[collab] sync first: ${unsent} change(s) not yet sent`);
    const shared = jsonList(db, SHARED_KEY);
    const held = o.heldByOffice ?? new Set<string>();
    const eNotes = db.prepare(`SELECT ulid, deleted_at IS NOT NULL AS gone FROM entries WHERE project_ulid IS NULL AND series = 'E'`).all() as Array<{ ulid: string; gone: number }>;
    const keep = access.member ? eNotes.filter((e) => !held.has(e.ulid)) : eNotes;

    const bound: string[] = [];
    if (access.member) {
      // Every shared slug, even one with no modules row here (a note can name a module that has none;
      // project_modules' module is a soft key) -- unless it is bound to another project here: a
      // private binding is the person's choice and adoption never makes it shared. An extra
      // module is named explicitly, so it must be known here and is bound to E whatever it was.
      const known = db.prepare(
        `SELECT 1 FROM modules WHERE slug = @m UNION ALL SELECT 1 FROM entries WHERE module = @m UNION ALL SELECT 1 FROM entry_modules WHERE module = @m LIMIT 1`,
      );
      const extras = (o.extraModules ?? []).map((m) => String(m ?? "").trim()).filter(Boolean);
      for (const m of extras) if (!known.get({ m })) throw new Error(`[collab] no module "${m}" in this notebook`);
      const boundTo = db.prepare(`SELECT project_ulid FROM project_modules WHERE module = ?`);
      const elsewhere = (m: string) => {
        const r = boundTo.get(m) as { project_ulid: string } | undefined;
        return !!r && r.project_ulid !== E_PROJECT_ULID;
      };
      const bind = db.prepare(
        `INSERT INTO project_modules (module, project_ulid) VALUES (?, ?)
           ON CONFLICT(module) DO UPDATE SET project_ulid = excluded.project_ulid, created_at = datetime('now')`,
      );
      const slugs = new Set([...shared.filter((m) => m && !elsewhere(m)), ...extras]);
      for (const m of [...slugs].sort()) { bind.run(m, E_PROJECT_ULID); bound.push(m); }
    }

    const def = o.defaultProject ? setDefaultProject(db, o.defaultProject) : ensureDefaultProject(db);
    const list = new Set([...neverSend(db), ...keep.map((e) => e.ulid)]);
    setSyncValue(db, NEVER_SEND_KEY, JSON.stringify([...list].sort()));
    setSyncValue(db, E_ADOPTED_KEY, "1");
    return { neverSend: keep.filter((e) => !e.gone).length, bound, default: def.code, member: access.member };
  }).immediate();
}

/** GET /v1/e-held: the E notes the office holds. Throws (never guesses) when it can't say. */
export async function fetchEHeld(db: DB): Promise<Set<string>> {
  const target = postOfficeTargetFromDb(db);
  if (!target) throw new Error("[collab] this notebook is not sharing with a post office (collab sync setup <join code>)");
  const r = await requestJson(target, "GET", "/v1/e-held");
  if (r.status !== 200 || !Array.isArray(r.body?.ulids)) {
    throw new Error(`[collab] the post office did not say which E notes it holds (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
  }
  return new Set((r.body.ulids as unknown[]).filter((x): x is string => typeof x === "string"));
}

/** adoptELocal, asking the office first which E notes it holds when this laptop is a member of E. */
export async function adoptEFromOffice(db: DB, o: Omit<AdoptOptions, "heldByOffice"> = {}): Promise<AdoptReport> {
  const access = cachedEAccess(db);
  const heldByOffice = access.adopted && access.member && !isEAdopted(db) ? await fetchEHeld(db) : undefined;
  return adoptELocal(db, { ...o, heldByOffice });
}

/** `collab project adopt-e`'s report, in plain words. */
export function adoptReportLines(r: AdoptReport): string[] {
  const out = ["emp1st (E) is now a shared project on this laptop."];
  if (r.member) {
    out.push(r.bound.length > 0
      ? `Modules whose new notes go to E: ${r.bound.join(", ")}.`
      : "No modules were bound to E: bind one with `collab project bind <module> E`.");
  } else {
    out.push("You are not a member of E at the post office, so no modules were bound to it and nothing of E is sent from here.");
  }
  out.push(`${r.neverSend} E note(s) the team never had stay on this laptop only.`);
  out.push(`New notes with no project go to ${r.default}.`);
  return out;
}
