import type { DB } from "./db.js";
import { ulidFromLegacy, parseEntryRef } from "./ulid.js";
import { resolveAuthor } from "./author.js";

export interface BackfillReport {
  entries: number;
  refs: number;
  entryModules: number;
  superseded: number;
  authors: number;
  unresolvedEntryRefs: Array<{ entry_id: number; ref_value: string }>;
  skippedEntries: Array<{ id: number; created_at: string; error: string }>;
}

/**
 * Fill every ULID-shaped column that is still NULL. Idempotent; runs on every
 * migrate(). Entries get a DETERMINISTIC ulid (ulidFromLegacy), so a row
 * repaired here gets the same ulid on every machine that holds it.
 * Unresolvable entry links are reported, never deleted (decision D4).
 *
 * MUST NOT THROW on bad data: it runs inside every server start, so one odd
 * row would stop every collab session from opening. Bad rows are skipped,
 * reported, and surfaced by doctor's data.entries_without_ulid.
 */
export function backfillUlids(db: DB): BackfillReport {
  const run = db.transaction((): BackfillReport => {
    const missing = db
      .prepare(`SELECT id, created_at, title FROM entries WHERE ulid IS NULL ORDER BY id`)
      .all() as Array<{ id: number; created_at: string; title: string }>;
    const setUlid = db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`);
    const skippedEntries: BackfillReport["skippedEntries"] = [];
    let filled = 0;
    for (const r of missing) {
      try {
        setUlid.run(ulidFromLegacy(r.id, r.created_at, r.title), r.id);
        filled++;
      } catch (e) {
        skippedEntries.push({ id: r.id, created_at: r.created_at, error: (e as Error).message });
      }
    }
    if (skippedEntries.length > 0) {
      console.error(`[collab-mcp] backfill skipped ${skippedEntries.length} entries with unusable created_at; run collab_doctor`);
    }

    const author = resolveAuthor();
    const authors = author
      ? db.prepare(`UPDATE entries SET author = ? WHERE author IS NULL`).run(author).changes
      : 0;

    const refs = db.prepare(`
      UPDATE refs SET entry_ulid = (SELECT ulid FROM entries WHERE id = refs.entry_id)
       WHERE entry_ulid IS NULL
    `).run().changes;

    const entryModules = db.prepare(`
      UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = entry_modules.entry_id)
       WHERE entry_ulid IS NULL
    `).run().changes;

    const superseded = db.prepare(`
      UPDATE entries SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = entries.superseded_by)
       WHERE superseded_by IS NOT NULL AND superseded_by_ulid IS NULL
    `).run().changes;

    // Entry links: parsed in JS with the same rules as the SQL trigger.
    const pending = db
      .prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type = 'entry' AND target_ulid IS NULL ORDER BY entry_id, ref_value`)
      .all() as Array<{ entry_id: number; ref_value: string }>;
    const ulidOf = db.prepare(`SELECT ulid FROM entries WHERE id = ?`);
    const setTarget = db.prepare(
      `UPDATE refs SET target_ulid = ? WHERE entry_id = ? AND ref_type = 'entry' AND ref_value = ?`,
    );
    const unresolvedEntryRefs: BackfillReport["unresolvedEntryRefs"] = [];
    for (const r of pending) {
      const id = parseEntryRef(r.ref_value);
      const hit = id === null ? undefined : (ulidOf.get(id) as { ulid: string | null } | undefined);
      if (hit?.ulid) setTarget.run(hit.ulid, r.entry_id, r.ref_value);
      else unresolvedEntryRefs.push(r);
    }

    return { entries: filled, refs, entryModules, superseded, authors, unresolvedEntryRefs, skippedEntries };
  });
  return run();
}
