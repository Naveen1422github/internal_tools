// file: core/src/ops/copy.ts
// Copy notes into a project (stage B2, spec P8, rule 7). Notes move between
// worlds only by copying, on purpose: old E notes of a module into a new
// project, or a team project's notes (all, or only mine) into a solo project.
//
// planCopy reads only (no write, no network) and returns the list to show.
// applyCopy writes it and returns exactly what changed. The CLI and the MCP
// tool print the SAME lines from copyPlanLines / copyResultLines, so both say
// the same thing for the same notebook.
import type { DB } from "../db.js";
import { hasProjectLeft } from "../schema.js";
import { insertEntryRow, insertEntryModules, insertRefs, COPIED_TO_PREFIX, type RefRowInput } from "../entry-write.js";
import { formatEntryRef } from "../entry-ref.js";
import { resolveAuthor } from "../author.js";
import { findProject, isLeftProject, isTeamProject, notFound, listProjects, type Project } from "../projects.js";
import { resolveAllocator, allocateWithRetry, SAVE_ATTEMPT } from "../sync/allocator.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { assertCan, can } from "../access/can.js";
import { newUlid, isUlid, parseNoteRef } from "../ulid.js";
import type { RefType } from "../constants.js";

export { COPIED_TO_PREFIX };

export interface CopyArgs {
  /**
   * A module slug (its E notes) or a project code/ULID; `module:` / `project:` remove any doubt.
   * `note:<SH-12 | E-00012 | ULID>` is one note (UI parity Task 10: "copy this note to another project").
   */
  from: string;
  /** The target project's code or ULID. */
  to: string;
  /** "me" (this machine's author) or an author name: only that author's notes. */
  author?: string;
  /** YYYY-MM-DD (or YYYY-MM-DD HH:MM[:SS]): only notes created then or later. */
  since?: string;
}

export interface CopyItem { ulid: string; ref: string; type: string; title: string; author: string | null; created_at: string }
export interface CopySkip { ulid: string; ref: string; title: string; reason: string }

export interface CopyPlan {
  args: CopyArgs;
  source: { kind: "module" | "project" | "note"; name: string; label: string; project_ulid?: string; note_ulid?: string };
  target: { ulid: string; code: string; name: string; mode: "solo" | "team" };
  filters: { author: string | null; since: string | null };
  items: CopyItem[];
  skipped: CopySkip[];
}

export interface CopyDone { from: string; from_ulid: string; to: string; to_ulid: string; pending: boolean }

export interface CopyResult {
  plan: CopyPlan;
  copied: CopyDone[];
  /** Links inside the copied set re-pointed at the copies (entry refs + superseded_by). */
  links_repointed: number;
  /** copied_to links added to the originals (one per original). */
  copied_to_added: number;
  /** Team target only: why some copies wait for their number. */
  pending_reason?: string;
}

const SINCE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

function moduleExists(db: DB, slug: string): boolean {
  return !!db.prepare(`SELECT 1 FROM modules WHERE slug = ?`).get(slug)
    || !!db.prepare(`SELECT 1 FROM entry_modules WHERE module = ? LIMIT 1`).get(slug);
}

function resolveSource(db: DB, raw: string): CopyPlan["source"] {
  const v = String(raw ?? "").trim();
  if (!v) throw new Error("[collab] copy needs --from <module | project | note:<SH-12>>");
  const asProject = (s: string): CopyPlan["source"] => {
    const p = findProject(db, s);
    if (!p) throw notFound(db, s);
    return { kind: "project", name: p.code, label: `project ${p.code} (${p.name})`, project_ulid: p.ulid };
  };
  const asModule = (s: string): CopyPlan["source"] => {
    if (!moduleExists(db, s)) throw new Error(`[collab] no module "${s}" in this notebook`);
    return { kind: "module", name: s, label: `module ${s} (E notes)` };
  };
  const asNote = (s: string): CopyPlan["source"] => {
    const ref = isUlid(s) ? null : parseNoteRef(s);
    const rows = (isUlid(s)
      ? db.prepare(`SELECT ulid, id, series, project_ulid FROM entries WHERE ulid = ? AND deleted_at IS NULL`).all(s)
      : ref ? db.prepare(`SELECT ulid, id, series, project_ulid FROM entries WHERE series = ? AND id = ? AND deleted_at IS NULL ORDER BY ulid`).all(ref.series, ref.id) : []
    ) as Array<{ ulid: string; id: number | null; series: string; project_ulid: string | null }>;
    if (rows.length === 0) throw new Error(`[collab] no note "${s}" in this notebook`);
    if (rows.length > 1) throw new Error(`[collab] ${s} names ${rows.length} notes; say which with note:<ULID>: ${rows.map((r) => r.ulid).join(", ")}`);
    const row = rows[0];
    const name = formatEntryRef(row.id, row.series);
    return { kind: "note", name, label: `note ${name}`, note_ulid: row.ulid, ...(row.project_ulid ? { project_ulid: row.project_ulid } : {}) };
  };
  const m = /^(project|module|note):(.+)$/i.exec(v);
  if (m) {
    const kind = m[1].toLowerCase();
    return kind === "project" ? asProject(m[2].trim()) : kind === "note" ? asNote(m[2].trim()) : asModule(m[2].trim());
  }
  const p = findProject(db, v);
  const isModule = moduleExists(db, v);
  if (p && isModule) {
    throw new Error(`[collab] "${v}" is both a project (${p.code}) and a module: say which, --from project:${p.code} or --from module:${v}`);
  }
  if (p) return asProject(v);
  if (isModule) return asModule(v);
  const known = listProjects(db).map((x) => x.code);
  throw new Error(`[collab] no project or module "${v}" in this notebook. Projects: ${known.join(", ") || "none"}.`);
}

function resolveTarget(db: DB, raw: string): Project {
  const v = String(raw ?? "").trim();
  if (!v) throw new Error("[collab] copy needs --to <project>");
  if (v.toLowerCase() === "none" || v.toUpperCase() === "E") {
    throw new Error("[collab] copies go into a project (its code numbers them); the E series is only for notes without a project");
  }
  const p = findProject(db, v);
  if (!p) throw notFound(db, v);
  if (isLeftProject(p)) {
    throw new Error(`[collab] ${p.code} (${p.name}) is a team you left: its notes are read-only, so nothing can be copied into it`);
  }
  return p;
}

/** The live copy of `ulid` in project `target`, found by the original's copied_to link, or null. */
function existingCopy(db: DB, ulid: string, target: string): { id: number | null; series: string } | null {
  return (db.prepare(
    `SELECT c.id, c.series FROM refs r JOIN entries c ON c.ulid = r.target_ulid
      WHERE r.entry_ulid = ? AND r.ref_type = 'entry' AND r.ref_value LIKE '${COPIED_TO_PREFIX}%'
        AND c.project_ulid = ? AND c.deleted_at IS NULL
      ORDER BY c.ulid LIMIT 1`,
  ).get(ulid, target) as { id: number | null; series: string } | undefined) ?? null;
}

/** What `copy` would do: reads only, never writes, never calls the network. */
export function planCopy(db: DB, args: CopyArgs): CopyPlan {
  if (!hasProjectLeft(db)) {
    throw new Error("[collab] copy needs migration 0010 (project_left). Restart the MCP server (or run `collab web` once): it applies migrations on start.");
  }
  const source = resolveSource(db, args.from);
  const target = resolveTarget(db, args.to);
  if (source.project_ulid === target.ulid) throw new Error(`[collab] --from and --to are the same project (${target.code})`);

  let author: string | null = null;
  if (args.author !== undefined && args.author !== null && String(args.author).trim() !== "") {
    const a = String(args.author).trim();
    if (a.toLowerCase() === "me") {
      author = resolveAuthor();
      if (!author) throw new Error("[collab] --author me: this machine's author is unknown; set COLLAB_AUTHOR");
    } else author = a;
  }
  let since: string | null = null;
  if (args.since !== undefined && args.since !== null && String(args.since).trim() !== "") {
    const s = String(args.since).trim();
    if (!SINCE_RE.test(s)) throw new Error(`[collab] --since "${s}" is not a date: use YYYY-MM-DD (or YYYY-MM-DD HH:MM)`);
    since = s.replace("T", " ");
  }

  const where = ["e.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (source.kind === "note") {
    where.push("e.ulid = ?");
    params.push(source.note_ulid);
  } else if (source.kind === "project") {
    where.push("e.project_ulid = ?");
    params.push(source.project_ulid);
  } else {
    // A module source means the E notes of that module (spec P8): notes in a
    // project are copied from their project.
    where.push("e.project_ulid IS NULL", "(e.module = ? OR EXISTS (SELECT 1 FROM entry_modules m WHERE m.entry_ulid = e.ulid AND m.module = ?))");
    params.push(source.name, source.name);
  }
  if (author !== null) { where.push("e.author = ?"); params.push(author); }
  if (since !== null) { where.push("e.created_at >= ?"); params.push(since); }
  const rows = db.prepare(
    `SELECT e.ulid, e.id, e.series, e.type, e.title, e.author, e.created_at FROM entries e
      WHERE ${where.join(" AND ")}
      ORDER BY e.series, e.id IS NULL, e.id, e.ulid`,
  ).all(...params) as Array<{ ulid: string; id: number | null; series: string; type: string; title: string; author: string | null; created_at: string }>;

  const items: CopyItem[] = [];
  const skipped: CopySkip[] = [];
  for (const r of rows) {
    const ref = formatEntryRef(r.id, r.series);
    const done = existingCopy(db, r.ulid, target.ulid);
    if (done) {
      skipped.push({ ulid: r.ulid, ref, title: r.title, reason: `already copied to ${formatEntryRef(done.id, done.series)}` });
      continue;
    }
    items.push({ ulid: r.ulid, ref, type: r.type, title: r.title, author: r.author, created_at: r.created_at });
  }
  return {
    args: { from: args.from, to: args.to, ...(args.author ? { author: args.author } : {}), ...(args.since ? { since: args.since } : {}) },
    source,
    target: { ulid: target.ulid, code: target.code, name: target.name, mode: target.mode },
    filters: { author, since },
    items,
    skipped,
  };
}

interface SourceRow {
  ulid: string; id: number | null; series: string; type: string; kind: string; title: string; summary: string;
  description: string | null; status: string; agent: string | null; module: string | null; task_id: string | null;
  tokens_estimate: number; rollup_of_task: string | null; deprecated: number; created_at: string; category: string;
  superseded_by: number | null; superseded_by_ulid: string | null; author: string | null;
}

/**
 * Perform a plan. The notes are listed again first: if they changed since the
 * plan was shown, nothing is copied. A solo target is numbered here and never
 * asks the office; a team target asks once per note (the stage C save rule)
 * and saves the rest pending after the first failure.
 */
export async function applyCopy(db: DB, plan: CopyPlan): Promise<CopyResult> {
  ensureCrsqlite(db);
  const now = planCopy(db, plan.args);
  const same = now.target.ulid === plan.target.ulid
    && now.items.length === plan.items.length
    && now.items.every((it, i) => it.ulid === plan.items[i].ulid);
  if (!same) throw new Error("[collab] the notes changed since the list was shown; nothing was copied. Run the copy again to see the new list.");
  if (now.items.length === 0) throw new Error("[collab] nothing to copy" + (now.skipped.length ? ` (${now.skipped.length} already copied)` : ""));

  const target = findProject(db, now.target.ulid)!;
  const code = target.code;
  // R8, before any number is asked: copying out of a team project needs
  // note.copy.out there (a module source holds E notes: no project); a team
  // target needs note.create. The copied-to breadcrumbs on the originals are
  // not gated here (an open Task 3 question).
  if (now.source.project_ulid) assertCan(db, now.source.project_ulid, "note.copy.out");
  assertCan(db, target.ulid, "note.create"); // the same checks as copyRefusal, which asks without throwing

  // Numbers for a team target, asked BEFORE the transaction (never inside it).
  // Solo: no allocator, no network, ever (rule 4).
  const plannedUlids = now.items.map(() => newUlid());
  const assigned = new Map<number, number>();
  let pendingReason: string | undefined;
  if (isTeamProject(target)) {
    const allocator = resolveAllocator(db);
    if (!allocator) pendingReason = "no post office connection is configured on this machine";
    else {
      for (let i = 0; i < plannedUlids.length; i++) {
        try {
          assigned.set(i, await allocateWithRetry(allocator, plannedUlids[i], code, SAVE_ATTEMPT));
        } catch (e) {
          const cause = (e as { cause?: unknown } | null)?.cause;
          pendingReason = cause instanceof Error ? cause.message : e instanceof Error ? e.message : String(e);
          break; // the rest wait too: the courier numbers them (same ulids, E-713)
        }
      }
    }
  }

  const getRow = db.prepare(`SELECT * FROM entries WHERE ulid = ?`);
  const getMods = db.prepare(`SELECT module, is_primary FROM entry_modules WHERE entry_ulid = ? ORDER BY is_primary DESC, module`);
  const getRefs = db.prepare(`SELECT ref_type, ref_value, target_ulid FROM refs WHERE entry_ulid = ? ORDER BY ref_type, ref_value`);

  const result = db.transaction(() => {
    const copyOf = new Map<string, { ulid: string; id: number | null }>();
    const sources: SourceRow[] = [];
    now.items.forEach((it, i) => {
      const s = getRow.get(it.ulid) as SourceRow;
      sources.push(s);
      const id = assigned.get(i);
      const owner = insertEntryRow(db, {
        type: s.type, kind: s.kind, title: s.title, summary: s.summary, description: s.description,
        status: s.status, agent: s.agent, module: s.module, task_id: s.task_id,
        tokens_estimate: s.tokens_estimate, category: s.category, rollup_of_task: s.rollup_of_task,
        series: code, project_ulid: target.ulid,
        ...(id !== undefined ? { assigned: { ulid: plannedUlids[i], id } } : {}),
        ...(isTeamProject(target) && id === undefined ? { pending: true, pendingUlid: plannedUlids[i] } : {}),
      });
      copyOf.set(s.ulid, { ulid: owner.ulid!, id: owner.id });
      // The words are still the original author's, written when they were (B2-4).
      db.prepare(`UPDATE entries SET author = ?, created_at = ?, deprecated = ? WHERE ulid = ?`)
        .run(s.author, s.created_at, s.deprecated, owner.ulid);
      const mods = getMods.all(s.ulid) as Array<{ module: string; is_primary: number }>;
      insertEntryModules(db, owner, mods.map((m) => m.module), mods.find((m) => m.is_primary === 1)?.module ?? null);
    });

    const label = (c: { ulid: string; id: number | null }) => (c.id === null ? c.ulid : formatEntryRef(c.id, code));
    let repointed = 0;
    let copiedTo = 0;
    for (const s of sources) {
      const copy = copyOf.get(s.ulid)!;
      const refs: RefRowInput[] = [];
      for (const r of getRefs.all(s.ulid) as Array<{ ref_type: string; ref_value: string; target_ulid: string | null }>) {
        if (r.ref_type === "entry" && r.ref_value.startsWith(COPIED_TO_PREFIX)) continue; // the original's own copies
        const inSet = r.ref_type === "entry" && r.target_ulid ? copyOf.get(r.target_ulid) : undefined;
        if (inSet) {
          refs.push({ ref_type: "entry", ref_value: label(inSet), target_ulid: inSet.ulid });
          repointed++;
        } else {
          refs.push({ ref_type: r.ref_type as RefType, ref_value: r.ref_value, target_ulid: r.target_ulid });
        }
      }
      insertRefs(db, { id: copy.id, ulid: copy.ulid }, refs);
      if (s.superseded_by_ulid) {
        const inSet = copyOf.get(s.superseded_by_ulid);
        if (inSet) {
          // A bare superseded_by number means E; copies are never E.
          db.prepare(`UPDATE entries SET superseded_by = NULL, superseded_by_ulid = ? WHERE ulid = ?`).run(inSet.ulid, copy.ulid);
          repointed++;
        } else {
          db.prepare(`UPDATE entries SET superseded_by = ?, superseded_by_ulid = ? WHERE ulid = ?`).run(s.superseded_by, s.superseded_by_ulid, copy.ulid);
        }
      }
      // The ONE change to the original (rule 7): a link to its copy. Never sent (send rule 0b).
      copiedTo += insertRefs(db, { id: s.id, ulid: s.ulid }, [
        { ref_type: "entry", ref_value: `${COPIED_TO_PREFIX}${copy.ulid}`, target_ulid: copy.ulid },
      ]);
    }
    const copied: CopyDone[] = sources.map((s) => {
      const c = copyOf.get(s.ulid)!;
      return { from: formatEntryRef(s.id, s.series), from_ulid: s.ulid, to: formatEntryRef(c.id, code), to_ulid: c.ulid, pending: c.id === null };
    });
    return { copied, repointed, copiedTo };
  })();

  return {
    plan: now,
    copied: result.copied,
    links_repointed: result.repointed,
    copied_to_added: result.copiedTo,
    ...(result.copied.some((c) => c.pending) ? { pending_reason: pendingReason ?? "the courier will number them" } : {}),
  };
}

const notes = (n: number) => `${n} note${n === 1 ? "" : "s"}`;
const into = (p: CopyPlan) => `${p.target.code} (${p.target.name}, ${p.target.mode})`;

/** The list shown before copying (CLI and MCP print exactly these lines). */
export function copyPlanLines(plan: CopyPlan): string[] {
  const out = [`Copy ${notes(plan.items.length)} from ${plan.source.label} into ${into(plan)}:`];
  const f = plan.filters;
  if (f.author !== null || f.since !== null) {
    out.push(`  only notes${f.author !== null ? ` by ${f.author}` : ""}${f.since !== null ? ` created on or after ${f.since}` : ""}`);
  }
  if (plan.items.length === 0) out.push("  (nothing to copy)");
  for (const it of plan.items) {
    out.push(`  ${it.ref.padEnd(10)} ${it.type.padEnd(13)} ${it.title}  (${it.author ?? "unknown author"}, ${it.created_at.slice(0, 10)})`);
  }
  if (plan.skipped.length) {
    out.push(`Skipped ${plan.skipped.length}:`);
    for (const s of plan.skipped) out.push(`  ${s.ref.padEnd(10)} ${s.title}: ${s.reason}`);
  }
  if (plan.items.length) {
    out.push(
      `Each copy is a new note numbered by ${plan.target.code}; the original is not changed, apart from a copied_to link to its copy. ` +
        "Mentions like E-729 inside the text are not rewritten.",
    );
  }
  return out;
}

/** What a copy changed (CLI and MCP print exactly these lines). */
export function copyResultLines(r: CopyResult): string[] {
  const out = [`Copied ${notes(r.copied.length)} from ${r.plan.source.label} into ${into(r.plan)}:`];
  for (const c of r.copied) out.push(`  ${c.from} -> ${c.to}${c.pending ? ` (${c.to_ulid}, waiting for its number)` : ""}`);
  out.push(`${r.links_repointed} link${r.links_repointed === 1 ? "" : "s"} inside the copied notes now point at the copies; each original got a copied_to link to its copy.`);
  const waiting = r.copied.filter((c) => c.pending).length;
  if (waiting) out.push(`${notes(waiting)} wait for their number from the post office: ${r.pending_reason}`);
  if (r.plan.skipped.length) out.push(`Skipped ${r.plan.skipped.length} already copied.`);
  return out;
}

/**
 * Why this plan would be refused (applyCopy's own R8 checks), or null: so a
 * page can say so before showing the list (UI parity Task 7a).
 */
export function copyRefusal(db: DB, plan: CopyPlan): string | null {
  for (const [ulid, key] of [[plan.source.project_ulid ?? null, "note.copy.out"], [plan.target.ulid, "note.create"]] as const) {
    if (key === "note.copy.out" && !ulid) continue;
    const c = can(db, ulid, key);
    if (!c.ok) return c.reason;
  }
  return null;
}
