// file: post-office/src/classify.ts
import { labelOf, COPIED_TO_PREFIX, type RawChange } from "@collab-mcp/core";
import type { Store } from "./store.js";
import { projectKeys, officeKeys } from "./access.js";
import { firstTextCell, textCells, prep, batchHints, revisionEntries, type Hints } from "./deliveries.js";

// RnR S2: the change classifier. A pure judge: it reads, it never writes.
//
// R4: "The office maps each incoming cell to one catalog key: insert of a new
// `entries` row = note.create. superseded_by set = note.supersede.
// deleted_at/deprecated set = note.archive. needs_merge 1->0 = merge.resolve.
// Any other entries/refs/entry_modules/entry_revisions cell on an existing note
// = note.edit.own if po_note_owners says the sender created it, else
// note.edit.any. Ownership comes only from po_note_owners, never from the
// incoming `author` cell."
//
// R5: "Refusal unit = one laptop transaction (same site_id + db_version). If
// any cell in a group is refused, the whole group is refused."
//
// R7: a new note is judged as a whole: a later group of a note whose creation
// was refused is refused too (po_refused_notes across batches, here within one).
//
// The spike's op->cells table (§3) decides the side cells: supersede carries
// superseded_by(_ulid), deprecated and updated_at; archive deprecated, deleted_at and
// updated_at; any other cell of the note is an edit. merge.resolve carries the rest
// (resolveWithText writes text). Structural refusals (key null) need no role: a hard
// delete, a project move, a number change, a revision moved to another note, a cell
// sent twice with two values, an unreadable pk.

export interface Refusal { site_id: string /* hex */; db_version: number; ulid: string | null; key: string | null; reason: string }
/** groups: every group of the batch, null = accepted. groupOf: each raw's group. creations: new note -> its creating group. */
/** noteProjects: each note -> its project as judged (null = none); R6 stamps write-backs with it. */
/** keys/ulids: each raw's first pk cell and note (as resolve() finds them); hints: the batch's own cells; held: the office's project per held note (R-29: the stamp guess reuses them). */
export interface Verdict {
  groups: Map<string, Refusal | null>; groupOf: string[]; creations: Map<string, string>; noteProjects: Map<string, string | null>;
  keys: Array<string | null>; ulids: Array<string | null>; hints: Hints; held: Map<string, HeldProject>;
}
/** A held note's project as R3 reads it: hp = its project cell arrived, hs = its series cell did; owner = po_note_owners'. */
export interface HeldProject { project_ulid: string | null; hp: number; hs: number; owner: string | null }

export function groupKey(r: RawChange): string {
  return r.site_id.toString("hex") + ":" + r.db_version;
}

export const REFUSED_BEFORE = "this note was refused when it was created";
const MOVED = "A note can't move between projects: copy it instead"; // S2-1
const REV_MOVED = "A note's history can't move to another note";
const HARD = "Notes are never hard-deleted: archive it instead";
const TWICE = "This change was sent twice with different values: sync again";
const NUMBER = "A note's number is given by the post office";
const UNREADABLE = "This change's key can't be read: sync again";
const NOTE_TABLES = new Set(["entries", "refs", "entry_modules", "entry_revisions"]);

// One lookup for every note of the batch: the office's row (if any), its owner,
// and whether its creation was refused (R7; that note is never held here).
const NOTE_FACTS = `
SELECT j.value AS ulid, e.ulid IS NOT NULL AS held, p.ulid IS NOT NULL AS known,
       e.id, e.series, e.project_ulid, e.deprecated, e.deleted_at, e.needs_merge,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'project_ulid') AS hp,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'series') AS hs,
       o.device_id AS owner, r.ulid IS NOT NULL AS refused
  FROM json_each(?) j
  LEFT JOIN entries e ON e.ulid = j.value
  LEFT JOIN entries__crsql_pks p ON p.ulid = j.value
  LEFT JOIN po_note_owners o ON o.ulid = j.value
  LEFT JOIN po_refused_notes r ON r.ulid = j.value`;
// R-28: the numbers the office handed out, for the notes whose id cell the batch sets.
const ALLOCS = `
WITH j AS (SELECT value FROM json_each(?))
SELECT ulid, 'E' AS series, id FROM po_allocations WHERE ulid IN j
UNION ALL
SELECT ulid, series, id FROM po_series_allocations WHERE ulid IN j`;
interface Facts {
  ulid: string; held: number; known: number; id: number | null; series: string | null; project_ulid: string | null; deprecated: number | null; deleted_at: string | null;
  needs_merge: number | null; hp: number; hs: number; owner: string | null; refused: number;
}

/** One (table, pk) of the batch: its runs of cells as [start, end) pairs; check = seen twice. */
interface Row { pk: Buffer; runs: number[]; check: boolean }

/** How one note of the batch is judged. */
interface Note {
  refused: boolean;          // in po_refused_notes
  held: boolean;             // the office has its row
  project: string | null;    // judged in this team project; null = not judged (rule 2)
  existing: Facts | null;    // the office's row, for an existing note
  movable: boolean;          // S2-1 applies: the office knows its project (NULL included)
  created: string | null;    // the group creating it in this batch
  owner: string | null;
}

const norm = (v: unknown): unknown => (v === "" || v === undefined ? null : typeof v === "bigint" ? Number(v) : v);
const same = (a: unknown, b: unknown): boolean => {
  const x = norm(a), y = norm(b);
  return Buffer.isBuffer(x) && Buffer.isBuffer(y) ? x.equals(y) : x === y;
};

/**
 * R4/R5: judge one batch from `origin`. Every raw gets a group (site_id +
 * db_version); a group is refused when any of its cells is (reason = the first
 * refused cell's). Four IN queries at most (revisions, notes, numbers, module slugs),
 * plus one role lookup per distinct project.
 */
export function classify(db: Store, origin: string, raws: RawChange[]): Verdict {
  const groupOf: string[] = new Array(raws.length);
  const groups = new Map<string, Refusal | null>();
  const creations = new Map<string, string>();
  const noteProjects = new Map<string, string | null>();
  const hints = batchHints(raws);

  // Each raw's group and first pk cell, decoded once per run of equal values.
  let lastSite: Buffer | null = null, lastDbv = -1, g = "", lastPk: Buffer | null = null, lastKey: string | null = null, lastTable = "";
  const keys: Array<string | null> = new Array(raws.length);
  const revSet = new Set<string>();
  // Fix 2: one (table, pk, cid) sent twice with different values is refused, not
  // merged here (hints take the last cell; cr-sqlite keeps the highest version).
  // R-29: rows are found by (table, first pk cell), then pk bytes (refs and
  // entry_modules share a first cell per note); cells are compared only for a row
  // that comes back in a later run, or repeats a cid within its run.
  const rows = new Map<string, Row[]>();
  let row: Row | undefined, start = 0;
  const runCids = new Set<string>();
  const recheck: Row[] = [];
  const endRun = (end: number) => { if (row) row.runs.push(start, end); };
  raws.forEach((r, i) => {
    if (r.db_version !== lastDbv || !lastSite!.equals(r.site_id)) {
      lastSite = r.site_id; lastDbv = r.db_version; g = groupKey(r);
      if (!groups.has(g)) groups.set(g, null);
    }
    groupOf[i] = g;
    if (!lastPk || r.table !== lastTable || !lastPk.equals(r.pk)) {
      endRun(i);
      lastPk = r.pk; lastTable = r.table; lastKey = firstTextCell(r.pk);
      const id = lastKey === null ? r.table + "\u0001" + r.pk.toString("latin1") : r.table + "\0" + lastKey;
      const bucket = rows.get(id);
      row = bucket?.find((x) => x.pk.equals(r.pk));
      if (!row) {
        row = { pk: r.pk, runs: [], check: false };
        if (bucket) bucket.push(row); else rows.set(id, [row]);
      } else if (!row.check) { row.check = true; recheck.push(row); } // back in a later run
      start = i; runCids.clear();
    }
    keys[i] = lastKey;
    if (runCids.size === runCids.add(r.cid).size && !row!.check) { row!.check = true; recheck.push(row!); } // a cid twice in one run
    if (r.table === "entry_revisions" && lastKey) revSet.add(lastKey);
  });
  endRun(raws.length);
  // The rows seen more than once: every cell of a (table, pk, cid) with two values is refused (TWICE).
  const twice = new Set<number>();
  for (const x of recheck) {
    const first = new Map<string, number>(), bad = new Set<string>();
    for (let k = 0; k < x.runs.length; k += 2) for (let i = x.runs[k]; i < x.runs[k + 1]; i++) {
      const f = first.get(raws[i].cid);
      if (f === undefined) first.set(raws[i].cid, i);
      else if (!same(raws[f].val, raws[i].val)) bad.add(raws[i].cid);
    }
    if (bad.size) for (let k = 0; k < x.runs.length; k += 2) for (let i = x.runs[k]; i < x.runs[k + 1]; i++) if (bad.has(raws[i].cid)) twice.add(i);
  }
  // A held revision belongs to the office's note, never to the batch's entry_ulid
  // cell (a forgery like the author cell); the batch says only for new revisions.
  const officeRev = revisionEntries(db, [...revSet]);
  const revEntry = new Map(officeRev);
  for (const [r, u] of hints.rev) if (!officeRev.has(r)) revEntry.set(r, u);

  // Each raw's note, as resolve() finds it (R3).
  const ulids = raws.map((r, i) => {
    const k = keys[i];
    if (!k || !NOTE_TABLES.has(r.table)) return null;
    return r.table === "entry_revisions" ? revEntry.get(k) ?? null : k;
  });
  const firstEntriesGroup = new Map<string, string>();
  raws.forEach((r, i) => { const u = ulids[i]; if (u && r.table === "entries" && !firstEntriesGroup.has(u)) firstEntriesGroup.set(u, groupOf[i]); });

  const wanted = [...new Set(ulids.filter((u): u is string => u !== null))];
  const facts = new Map<string, Facts>();
  const heldProjects = new Map<string, HeldProject>();
  if (wanted.length) for (const f of prep(db, NOTE_FACTS).all(JSON.stringify(wanted)) as Facts[]) {
    facts.set(f.ulid, f);
    if (f.held) heldProjects.set(f.ulid, f);
  }

  // Team projects the office knows, with origin's keys in each (memoized).
  const projects = new Map<string, { code: string; keys: Set<string> } | null>();
  const team = (p: string) => {
    if (!projects.has(p)) {
      const row = prep(db, `SELECT code FROM po_projects WHERE ulid = ?`).get(p) as { code: string } | undefined;
      projects.set(p, row ? { code: row.code, keys: projectKeys(db, origin, p) } : null);
    }
    return projects.get(p)!;
  };

  const notes = new Map<string, Note>();
  for (const u of wanted) {
    const f = facts.get(u)!;
    const created = firstEntriesGroup.get(u) ?? null;
    let project: string | null = null, existing: Facts | null = null, isNew = false, movable = false;
    if (f.held && (f.hp || !f.hs)) {
      // Existing: its project is the office's, never the batch's (hp = 0, hs = 0: before 0009, no project).
      existing = f; movable = true;
      project = f.hp ? f.project_ulid : null;
    } else if (!f.held && f.known) {
      // Fix 1: tombstoned at the office (before S2). A re-insert is an edit of its recorded owner's note.
      project = hints.project.get(u) ?? null;
    } else if (created && hints.project.has(u)) {
      // New here, or held with its project cell still arriving: the batch says its project.
      isNew = true;
      project = hints.project.get(u) ?? null;
    } // else: S1 holds it as '?', not judged here
    noteProjects.set(u, project);
    if (project !== null && !team(project)) project = null; // solo or unknown project (rule 2)
    if (isNew) creations.set(u, created!);
    // The owner is po_note_owners' whenever the office has the note (fix 6); the sender's only for a note new here.
    const owner = isNew && !f.held ? origin : f.owner;
    notes.set(u, { refused: !!f.refused, held: !!f.held, project, existing, movable, created: isNew ? created : null, owner });
  }

  // Per (group, note): which cells ride on supersede/archive (only their side cells,
  // spike §3) and whether merge.resolve carries the rest (resolveWithText has text).
  // act[i]: the cell's key, null = judged per cell (edit), "" = not judged.
  const act: Array<string | null> = new Array(raws.length).fill("");
  const pairs = new Map<string, Map<string, number[]>>();
  raws.forEach((_, i) => {
    const u = ulids[i];
    if (!u || notes.get(u)!.project === null) return;
    let byNote = pairs.get(groupOf[i]);
    if (!byNote) pairs.set(groupOf[i], (byNote = new Map()));
    const list = byNote.get(u);
    if (list) list.push(i); else byNote.set(u, [i]);
  });
  for (const [g, byNote] of pairs) for (const [u, idx] of byNote) {
    const n = notes.get(u)!;
    if (n.created === g) { for (const i of idx) act[i] = "note.create"; continue; }
    const e = n.existing;
    const depChanged = (v: unknown) => !e || !same(v, e.deprecated);
    const delChanged = (v: unknown) => !e || !same(v, e.deleted_at);
    let sup = false, arch = false, res = false;
    for (const i of idx) {
      const r = raws[i];
      if (r.table !== "entries") continue;
      if (r.cid === "superseded_by" || r.cid === "superseded_by_ulid") { if (norm(r.val) !== null) sup = true; }
      else if (r.cid === "deprecated") { if (depChanged(r.val)) arch = true; }
      else if (r.cid === "deleted_at") { if (delChanged(r.val)) arch = true; }
      else if (r.cid === "needs_merge") { if (norm(r.val) === 0 && e?.needs_merge === 1) res = true; }
    }
    const base = res ? "merge.resolve" : null;
    for (const i of idx) {
      const r = raws[i];
      let a: string | null = base;
      if (r.table === "entries") {
        switch (r.cid) {
          case "superseded_by": case "superseded_by_ulid": if (sup && norm(r.val) !== null) a = "note.supersede"; break;
          case "deprecated": if (sup) a = "note.supersede"; else if (depChanged(r.val)) a = "note.archive"; break;
          case "deleted_at": if (delChanged(r.val)) a = "note.archive"; break;
          case "updated_at": if (sup) a = "note.supersede"; else if (arch) a = "note.archive"; break;
        }
      }
      act[i] = a;
    }
  }

  // Modules (S2-3): office keys; create = a slug the office lacks.
  let slugs: Set<string> | null = null, office: Set<string> | null = null;
  const moduleKey = (slug: string) => {
    if (!slugs) {
      const asked = [...new Set(raws.map((r, i) => (r.table === "modules" ? keys[i] : null)).filter((s): s is string => s !== null))];
      slugs = new Set((prep(db, `SELECT slug FROM modules WHERE slug IN (SELECT value FROM json_each(?))`).all(JSON.stringify(asked)) as Array<{ slug: string }>).map((r) => r.slug));
    }
    return slugs.has(slug) ? "module.edit" : "module.create";
  };

  // Origin's answer per (project or office, key): "" = holds it, else the refusal reason.
  const answers = new Map<string | null, Map<string, string>>();
  const answer = (key: string, project: string | null): string => {
    let m = answers.get(project);
    if (!m) answers.set(project, (m = new Map()));
    let x = m.get(key);
    if (x === undefined) {
      if (project === null) {
        office ??= officeKeys(db, origin);
        x = office.has(key) ? "" : `You need "${labelOf(key)}" (${key}) in this office to do this`;
      } else {
        const p = team(project)!;
        x = p.keys.has(key) ? "" : `You need "${labelOf(key)}" (${key}) in ${p.code} to do this`;
      }
      m.set(key, x);
    }
    return x;
  };

  // R-28: a number is the office's. One query for every note whose number is checked:
  // a held pending note (office id NULL) whose id cell the batch sets, and every creation
  // judged in a team project. R-35: a creation is checked on the batch's id/series cells
  // and on the office's stored values (a note held as '?' whose project cell comes in a
  // later POST): either may win the merge (col_version), so both must pass; no series at
  // all is a mismatch.
  const cellId = new Map<string, unknown>(), cellSeries = new Map<string, unknown>();
  raws.forEach((r, i) => {
    if (r.table !== "entries" || (r.cid !== "id" && r.cid !== "series")) return;
    const u = ulids[i];
    if (u) (r.cid === "id" ? cellId : cellSeries).set(u, norm(r.val));
  });
  const numbered = new Set<string>();
  const creating = new Map<string, { series: unknown[]; ids: unknown[] }>();
  for (const [u, n] of notes) {
    if (n.created !== null && n.project !== null) {
      const f = facts.get(u)!, series: unknown[] = [], ids: unknown[] = [];
      if (cellSeries.has(u)) series.push(cellSeries.get(u));
      if (f.held && f.hs) series.push(norm(f.series));
      if (cellId.has(u) && cellId.get(u) !== null) ids.push(cellId.get(u));
      if (f.held && f.id !== null) ids.push(norm(f.id));
      creating.set(u, { series, ids });
      if (ids.length) numbered.add(u);
    } else if (n.existing && n.existing.id === null && cellId.has(u) && cellId.get(u) !== null) numbered.add(u);
  }
  const allocs = new Map<string, { series: string; id: number }>();
  if (numbered.size) for (const a of prep(db, ALLOCS).all(JSON.stringify([...numbered])) as Array<{ ulid: string; series: string; id: number }>) allocs.set(a.ulid, a);
  const allocated = (u: string, series: string, v: unknown) => {
    const a = allocs.get(u);
    return !!a && a.series === series && a.id === norm(v);
  };
  // R-28, promote (P9): a solo project made team keeps the numbers its notes got before,
  // 1..seed (registerProject's seed; allocate hands out seed+1 on). Such a number is
  // accepted once: not allocated, not held by another office note, not twice in a batch.
  const seeds = new Map<string, number>();
  const promotedTaken = new Map<string, string>(); // series:id -> ulid, within this batch
  const promoted = (u: string, series: string, v: unknown) => {
    const id = norm(v);
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || allocs.has(u)) return false;
    let seed = seeds.get(series);
    if (seed === undefined) {
      const r = prep(db, `SELECT COALESCE((SELECT MIN(id) - 1 FROM po_series_allocations WHERE series = ?),
                                          (SELECT value FROM po_series_counters WHERE series = ?), 0) AS seed`).get(series, series) as { seed: number };
      seeds.set(series, (seed = r.seed));
    }
    if (id > seed) return false;
    const k = series + ":" + id, by = promotedTaken.get(k);
    if (by !== undefined && by !== u) return false;
    if (prep(db, `SELECT 1 FROM entries WHERE series = ? AND id = ? AND ulid <> ?`).get(series, id, u)) return false;
    promotedTaken.set(k, u);
    return true;
  };
  // R-28/R-35: a creation is in its project's series, numbered by allocate (or promote) or not yet.
  const badNumber = new Set<string>();
  for (const [u, e] of creating) {
    const code = team(notes.get(u)!.project!)!.code;
    if (!e.series.length || e.series.some((x) => x !== code) || e.ids.some((id) => !allocated(u, code, id) && !promoted(u, code, id))) badNumber.add(u);
  }

  // Each cell's key (null = refused outright or not judged) and, when refused, why.
  const whyKey: Array<string | null> = new Array(raws.length).fill(null);
  const why: Array<string | null> = new Array(raws.length).fill(null);
  const judge = (i: number, key: string, project: string | null) => {
    const x = answer(key, project);
    if (x) { whyKey[i] = key; why[i] = x; }
  };
  raws.forEach((r, i) => {
    if (keys[i] === null) { why[i] = UNREADABLE; return; } // fix 5: fail closed
    if (twice.size && twice.has(i)) { why[i] = TWICE; return; }
    if (r.table === "modules") { judge(i, moduleKey(keys[i]!), null); return; }
    const u = ulids[i];
    if (!u) return;
    const n = notes.get(u)!;
    if (n.refused) { why[i] = REFUSED_BEFORE; return; }
    if (n.held && r.table === "entries" && r.cid === "-1" && r.cl % 2 === 0) { why[i] = HARD; return; } // fix 1
    if (n.movable && r.table === "entries" && r.cid === "project_ulid" && norm(r.val) !== norm(n.existing!.hp ? n.existing!.project_ulid : null)) {
      why[i] = MOVED; return;
    }
    if (n.existing && r.table === "entries" && (r.cid === "id" || r.cid === "series")) {
      // Fix 3: numbers come from the office. Only assignPendingNumber (NULL -> integer) passes, judged at
      // allocate (R7), and only with the number allocate gave this note in its series (R-28).
      const cur = r.cid === "id" ? n.existing.id : n.existing.series;
      if (same(r.val, cur)) return;
      if (r.cid === "id" && cur === null && allocated(u, n.existing.series ?? "E", r.val)) return;
      why[i] = NUMBER; return;
    }
    if (badNumber.size && act[i] === "note.create" && badNumber.has(u)) { why[i] = NUMBER; return; } // R-28/R-35: its whole creating group
    if (r.table === "entry_revisions" && r.cid === "entry_ulid" && keys[i] && officeRev.has(keys[i]!) && r.val !== u) {
      why[i] = REV_MOVED; return;
    }
    const a = act[i];
    if (a === "") return;
    if (a !== null) { judge(i, a, n.project); return; }
    if (r.table === "refs") {
      const c = textCells(r.pk);
      if (c && c[1] === "entry" && c[2]?.startsWith(COPIED_TO_PREFIX)) { judge(i, "note.copy.out", n.project); return; } // R-3
    }
    judge(i, n.owner === origin ? "note.edit.own" : "note.edit.any", n.project);
  });
  const refusal = (r: RawChange, i: number, key: string | null, reason: string): Refusal =>
    ({ site_id: r.site_id.toString("hex"), db_version: r.db_version, ulid: ulids[i], key, reason });

  // R5: the first refused cell refuses its group. R7 within the batch: a note whose
  // creating group is refused is dead, and its later groups are refused for that
  // (they may hold another note's creation, so judge again until nothing new dies).
  const dead = new Set<string>();
  let anyWhy = false;
  for (let i = 0; i < why.length && !anyWhy; i++) anyWhy = why[i] !== null;
  for (; anyWhy; ) { // nothing refused: every group stays null (R-29: no pass)
    for (const g of groups.keys()) groups.set(g, null);
    raws.forEach((r, i) => {
      const g = groupOf[i];
      if (groups.get(g)) return;
      const u = ulids[i];
      if (u && dead.has(u) && creations.get(u) !== g) groups.set(g, refusal(r, i, null, REFUSED_BEFORE));
      else if (why[i]) groups.set(g, refusal(r, i, whyKey[i], why[i]!));
    });
    let grew = false;
    for (const [u, g] of creations) if (groups.get(g) && !dead.has(u)) { dead.add(u); grew = true; }
    if (!grew) break;
  }
  return { groups, groupOf, creations, noteProjects, keys, ulids, hints, held: heldProjects };
}
