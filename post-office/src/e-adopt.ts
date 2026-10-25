// file: post-office/src/e-adopt.ts
// Local-first Task 4: the office adopts E as a real team project. E notes keep
// project_ulid NULL in their own rows forever; only their DELIVERY stamp becomes
// E_PROJECT_ULID, so they reach E's members only (and a new member by replay).
// Before adoption nothing changes. The E counter stays po_meta.counter.
import { E_PROJECT_ULID } from "@collab-mcp/core";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { seedNewProject } from "./access.js";
import { lastSeq, prep, resolveStamps, type DeliveryRow } from "./deliveries.js";

/** po_meta: "1" once this office has adopted E. */
export const E_ADOPTED_META = "e_adopted";
/** po_meta: the last delivery seq at adoption (every E row at or below it was a NULL row, sent to every member). */
export const E_ADOPTED_SEQ_META = "e_adopted_seq";
/** po_meta: JSON {device: receive_bookmark} of the live members at adoption (what each had acknowledged applying). */
export const E_ADOPTED_BOOKMARKS_META = "e_adopted_bookmarks";
/** The tables whose rows belong to a note; a NULL stamp there means E once adopted. `modules` is not one. */
export const NOTE_TABLES: ReadonlySet<string> = new Set(["entries", "refs", "entry_modules", "entry_revisions"]);

export function isEAdoptedOffice(db: Store): boolean {
  return (prep(db, `SELECT value FROM po_meta WHERE key = '${E_ADOPTED_META}'`).get() as { value: string } | undefined)?.value === "1";
}

/** A note row's stamp as delivered: no project (NULL) is E once the office adopted it. */
export function eStamp(adopted: boolean, tbl: string, stamp: string | null): string | null {
  return stamp === null && adopted && NOTE_TABLES.has(tbl) ? E_PROJECT_ULID : stamp;
}

/**
 * One transaction: register E (code 'E', bypassing registerProject's refusal of
 * that code) with `ownerDevice` as its only member, Owner; restamp the past
 * deliveries of notes with no project to E; mark the office adopted. Only rows
 * of the 4 note tables stamped NULL whose note resolves to no project are
 * touched: modules rows, held ('?') rows and project rows never. Throws if done.
 */
export function adoptE(db: Store, o: { name: string; ownerDevice: string }): { restamped: number } {
  const name = String(o.name ?? "").trim();
  if (!name) throw new StoreError("E needs a name");
  return db.transaction(() => {
    if (isEAdoptedOffice(db) || db.prepare(`SELECT 1 FROM po_projects WHERE ulid = ? OR code = 'E'`).get(E_PROJECT_ULID)) {
      throw new StoreError("this post office has already adopted E", 409);
    }
    if (!db.prepare(`SELECT 1 FROM po_members WHERE device_id = ? AND revoked_at IS NULL`).get(String(o.ownerDevice))) {
      throw new StoreError(`${o.ownerDevice} is not a member of this office`, 404);
    }
    const clash = db.prepare(`SELECT code FROM po_projects WHERE lower(name) = lower(?)`).get(name) as { code: string } | undefined;
    if (clash) throw new StoreError(`this team already has a project named "${name}" (${clash.code}); pick another --name`, 409);
    db.prepare(`INSERT INTO po_projects (ulid, name, code) VALUES (?, ?, 'E')`).run(E_PROJECT_ULID, name);
    seedNewProject(db, E_PROJECT_ULID, String(o.ownerDevice));

    // Resolved before the meta is set, so "no project" still reads as null here.
    const rows = db
      .prepare(
        `SELECT seq, tbl, pk, origin, 0 AS held FROM po_deliveries
          WHERE project_ulid IS NULL AND tbl IN (${[...NOTE_TABLES].map((t) => `'${t}'`).join(", ")})`,
      )
      .all() as DeliveryRow[];
    const seqs = resolveStamps(db, rows).filter((r) => r.stamp === null || r.stamp === "?").map((r) => r.seq);
    if (seqs.length) prep(db, `UPDATE po_deliveries SET project_ulid = ? WHERE seq IN (SELECT value FROM json_each(?))`).run(E_PROJECT_ULID, JSON.stringify(seqs));
    setMeta(db, E_ADOPTED_SEQ_META, String(lastSeq(db)));
    const marks = db.prepare(`SELECT device_id, receive_bookmark FROM po_members WHERE revoked_at IS NULL`).all() as Array<{ device_id: string; receive_bookmark: number }>;
    setMeta(db, E_ADOPTED_BOOKMARKS_META, JSON.stringify(Object.fromEntries(marks.map((m) => [m.device_id, m.receive_bookmark]))));
    setMeta(db, E_ADOPTED_META, "1");
    return { restamped: seqs.length };
  }).immediate();
}

/** A cr-sqlite packed pk of one text cell (the layout firstTextCell reads): an entries pk. */
export function packTextPk(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len: number[] = [];
  for (let n = b.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
  if (!len.length) len.push(0);
  return Buffer.concat([Buffer.from([1, (len.length << 3) | 3, ...len]), b]);
}

/**
 * Fix rounds 2-3: may the office address a write-back of `ulid` to `device` (it can't view
 * the note's stamp)? Only with proof the device already holds the note:
 * - "owner": it is the note's recorded owner (po_note_owners): any named cell may go back;
 * - a number (proof b): the note's entries row was a NULL (no-project, pre-E-adoption)
 *   delivery, which went to every member, at or below the bookmark `device` had acknowledged
 *   at adoption. The number is min(e_adopted_seq, that bookmark): a cell may go back only
 *   when its latest delivery is at or below it (cellSeenBy), so a value an E member wrote
 *   after adoption never reaches a non-member through a forged high col_version.
 * - null: no proof; the write-back follows its stamp like any office row.
 */
export function noteProof(db: Store, device: string, ulid: string): "owner" | number | null {
  if (prep(db, `SELECT 1 FROM po_note_owners WHERE ulid = ? AND device_id = ?`).get(ulid, device)) return "owner";
  if (!isEAdoptedOffice(db)) return null;
  let marks: Record<string, unknown> = {};
  try { marks = JSON.parse(getMeta(db, E_ADOPTED_BOOKMARKS_META) ?? "{}"); } catch { return null; }
  const mark = marks[device], limit = Math.min(Number(getMeta(db, E_ADOPTED_SEQ_META) ?? 0), typeof mark === "number" ? mark : 0);
  if (!(limit > 0)) return null;
  // E rows only (idx_po_deliveries_project): every E row at or below e_adopted_seq was a NULL row.
  return prep(db, `SELECT 1 FROM po_deliveries WHERE project_ulid = ? AND seq <= ? AND tbl = 'entries' AND pk = ? LIMIT 1`)
    .get(E_PROJECT_ULID, limit, packTextPk(ulid)) ? limit : null;
}

/** Proof b, per cell: every delivery of this E cell is at or below `limit` (the sender could already see its value). */
export function cellSeenBy(db: Store, limit: number, tbl: string, pk: Buffer, cid: string): boolean {
  const r = prep(db, `SELECT MAX(seq) s FROM po_deliveries WHERE project_ulid = ? AND tbl = ? AND pk = ? AND cid = ?`)
    .get(E_PROJECT_ULID, tbl, pk, cid) as { s: number | null };
  return r.s !== null && r.s <= limit;
}
