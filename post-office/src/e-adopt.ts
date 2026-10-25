// file: post-office/src/e-adopt.ts
// Local-first Task 4: the office adopts E as a real team project. E notes keep
// project_ulid NULL in their own rows forever; only their DELIVERY stamp becomes
// E_PROJECT_ULID, so they reach E's members only (and a new member by replay).
// Before adoption nothing changes. The E counter stays po_meta.counter.
import { E_PROJECT_ULID } from "@collab-mcp/core";
import { StoreError, setMeta, type Store } from "./store.js";
import { seedNewProject } from "./access.js";
import { prep, resolveStamps, type DeliveryRow } from "./deliveries.js";

/** po_meta: "1" once this office has adopted E. */
export const E_ADOPTED_META = "e_adopted";
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
    setMeta(db, E_ADOPTED_META, "1");
    return { restamped: seqs.length };
  }).immediate();
}
