// file: post-office/src/classify.ts
import { labelOf, COPIED_TO_PREFIX, type RawChange } from "@collab-mcp/core";
import type { Store } from "./store.js";
import { projectKeys, officeKeys } from "./access.js";
import { firstTextCell, textCells, prep, batchHints, revisionEntries } from "./deliveries.js";

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
// The spike's op->cells table (§3) decides the side cells: supersede, archive and
// resolve carry the note's other cells in the group (updated_at, deprecated).

export interface Refusal { site_id: string /* hex */; db_version: number; ulid: string | null; key: string | null; reason: string }
/** groups: every group of the batch, null = accepted. groupOf: each raw's group. creations: new note -> its creating group. */
export interface Verdict { groups: Map<string, Refusal | null>; groupOf: string[]; creations: Map<string, string> }

export function groupKey(r: RawChange): string {
  return r.site_id.toString("hex") + ":" + r.db_version;
}

const REFUSED_BEFORE = "this note was refused when it was created";
const MOVED = "A note can't move between projects: copy it instead"; // S2-1
const REV_MOVED = "A note's history can't move to another note";
const NOTE_TABLES = new Set(["entries", "refs", "entry_modules", "entry_revisions"]);

// One lookup for every note of the batch: the office's row (if any), its owner,
// and whether its creation was refused (R7; that note is never held here).
const NOTE_FACTS = `
SELECT j.value AS ulid, e.ulid IS NOT NULL AS held, e.project_ulid, e.deprecated, e.deleted_at, e.needs_merge,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'project_ulid') AS hp,
       EXISTS (SELECT 1 FROM entries__crsql_clock c WHERE c.key = p.__crsql_key AND c.col_name = 'series') AS hs,
       o.device_id AS owner, r.ulid IS NOT NULL AS refused
  FROM json_each(?) j
  LEFT JOIN entries e ON e.ulid = j.value
  LEFT JOIN entries__crsql_pks p ON p.ulid = e.ulid
  LEFT JOIN po_note_owners o ON o.ulid = j.value
  LEFT JOIN po_refused_notes r ON r.ulid = j.value`;
interface Facts {
  ulid: string; held: number; project_ulid: string | null; deprecated: number | null; deleted_at: string | null;
  needs_merge: number | null; hp: number; hs: number; owner: string | null; refused: number;
}

/** How one note of the batch is judged. */
interface Note {
  refused: boolean;          // in po_refused_notes
  project: string | null;    // judged in this team project; null = not judged (rule 2)
  existing: Facts | null;    // the office's row, for an existing note
  movable: boolean;          // S2-1 applies: the office knows its project (NULL included)
  created: string | null;    // the group creating it in this batch
  owner: string | null;
}

const norm = (v: unknown): unknown => (v === "" || v === undefined ? null : typeof v === "bigint" ? Number(v) : v);

/**
 * R4/R5: judge one batch from `origin`. Every raw gets a group (site_id +
 * db_version); a group is refused when any of its cells is (reason = the first
 * refused cell's). Three IN queries at most (revisions, notes, module slugs),
 * plus one role lookup per distinct project.
 */
export function classify(db: Store, origin: string, raws: RawChange[]): Verdict {
  const groupOf: string[] = new Array(raws.length);
  const groups = new Map<string, Refusal | null>();
  const creations = new Map<string, string>();
  const hints = batchHints(raws);

  // Each raw's group and first pk cell, decoded once per run of equal values.
  let lastSite: Buffer | null = null, lastDbv = -1, g = "", lastPk: Buffer | null = null, lastKey: string | null = null;
  const keys: Array<string | null> = new Array(raws.length);
  const revSet = new Set<string>();
  raws.forEach((r, i) => {
    if (r.db_version !== lastDbv || !lastSite!.equals(r.site_id)) {
      lastSite = r.site_id; lastDbv = r.db_version; g = groupKey(r);
      if (!groups.has(g)) groups.set(g, null);
    }
    groupOf[i] = g;
    if (!lastPk || !lastPk.equals(r.pk)) { lastPk = r.pk; lastKey = firstTextCell(r.pk); }
    keys[i] = lastKey;
    if (r.table === "entry_revisions" && lastKey) revSet.add(lastKey);
  });
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
  if (wanted.length) for (const f of prep(db, NOTE_FACTS).all(JSON.stringify(wanted)) as Facts[]) facts.set(f.ulid, f);

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
    } else if (created && hints.project.has(u)) {
      // New here, or held with its project cell still arriving: the batch says its project.
      isNew = true;
      project = hints.project.get(u) ?? null;
    } // else: S1 holds it as '?', not judged here
    if (project !== null && !team(project)) project = null; // solo or unknown project (rule 2)
    if (isNew) creations.set(u, created!);
    notes.set(u, { refused: !!f.refused, project, existing, movable, created: isNew ? created : null, owner: isNew ? origin : f.owner });
  }

  // Per (group, note): the action that carries all of the note's cells in it.
  // act[i]: the key for every cell of the pair, null = judged per cell, "" = not judged.
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
  const setAll = (idx: number[], a: string | null) => { for (const i of idx) act[i] = a; };
  for (const [g, byNote] of pairs) for (const [u, idx] of byNote) {
    const n = notes.get(u)!;
    if (n.created === g) { setAll(idx, "note.create"); continue; }
    const e = n.existing;
    let sup = false, arch = false, res = false, onlyId = true, anyId = false;
    for (const i of idx) {
      const r = raws[i];
      if (r.table !== "entries") { onlyId = false; continue; }
      const v = norm(r.val);
      if (r.cid === "superseded_by" || r.cid === "superseded_by_ulid") { if (v !== null) sup = true; }
      else if (r.cid === "deprecated") { if (!e || v !== norm(e.deprecated)) arch = true; }
      else if (r.cid === "deleted_at") { if (!e || v !== norm(e.deleted_at)) arch = true; }
      else if (r.cid === "needs_merge") { if (v === 0 && e?.needs_merge === 1) res = true; }
      if (r.cid === "id") anyId = true;
      else if (r.cid !== "updated_at") onlyId = false;
    }
    setAll(idx, sup ? "note.supersede" : arch ? "note.archive" : res ? "merge.resolve"
      : onlyId && anyId ? "" /* assignPendingNumber: judged at allocate (R7) */ : null);
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

  // Each cell's key (null = refused outright or not judged) and, when refused, why.
  const whyKey: Array<string | null> = new Array(raws.length).fill(null);
  const why: Array<string | null> = new Array(raws.length).fill(null);
  const judge = (i: number, key: string, project: string | null) => {
    const x = answer(key, project);
    if (x) { whyKey[i] = key; why[i] = x; }
  };
  raws.forEach((r, i) => {
    if (r.table === "modules") { if (keys[i]) judge(i, moduleKey(keys[i]!), null); return; }
    const u = ulids[i];
    if (!u) return;
    const n = notes.get(u)!;
    if (n.refused) { why[i] = REFUSED_BEFORE; return; }
    if (n.movable && r.table === "entries" && r.cid === "project_ulid" && norm(r.val) !== norm(n.existing!.hp ? n.existing!.project_ulid : null)) {
      why[i] = MOVED; return;
    }
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
  for (;;) {
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
  return { groups, groupOf, creations };
}
