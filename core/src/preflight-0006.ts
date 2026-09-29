import type { DB } from "./db.js";
import { newUlid, ulidFromLegacy } from "./ulid.js";
import { resolveAuthor } from "./author.js";

/**
 * Everything 0006's table rebuild assumes, checked BEFORE any table is touched
 * (collab E-685 item 1). Runs inside one transaction: if anything is wrong it
 * throws and its own repairs roll back too, so the DB is exactly as it was.
 */
export class PreflightError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `[collab-mcp] 0006 pre-flight failed, nothing was changed:\n  - ${problems.join("\n  - ")}\n` +
        `[collab-mcp] Fix these rows, then start the server again.`,
    );
    this.name = "PreflightError";
  }
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const eid = (id: number | null) => `E-${String(id ?? "?").padStart(5, "0")}`;

export function preflight0006(db: DB): { assignedUlids: number; stampedAuthors: number } {
  const run = db.transaction(() => {
    // 1. Rows the 0005 backfill skipped (unparseable created_at) or that were
    //    written without core. Prefer the deterministic legacy ULID (D1 of the
    //    0005 plan) so every machine holding the row derives the same one.
    const missing = db
      .prepare(`SELECT id, created_at, title FROM entries WHERE ulid IS NULL ORDER BY id`)
      .all() as Array<{ id: number; created_at: string; title: string }>;
    const setUlid = db.prepare(`UPDATE entries SET ulid = ? WHERE id = ?`);
    for (const r of missing) {
      let u: string;
      try { u = ulidFromLegacy(r.id, r.created_at, r.title); } catch { u = newUlid(); }
      setUlid.run(u, r.id);
    }

    // 2. One-time author stamp (E-685 #7). After 0006 the startup backfill
    //    never stamps author, so a synced row is never claimed by this machine.
    const author = resolveAuthor();
    const stampedAuthors = author
      ? db.prepare(`UPDATE entries SET author = ? WHERE author IS NULL`).run(author).changes
      : 0;

    // 3. ULID keys the rebuilt tables need as NOT NULL primary-key columns.
    db.prepare(`UPDATE refs SET entry_ulid = (SELECT ulid FROM entries WHERE id = refs.entry_id) WHERE entry_ulid IS NULL`).run();
    db.prepare(`UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = entry_modules.entry_id) WHERE entry_ulid IS NULL`).run();
    db.prepare(`
      UPDATE entries SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = entries.superseded_by)
       WHERE superseded_by IS NOT NULL AND superseded_by_ulid IS NULL
    `).run();

    // 4. Validate. Collect everything, then fail once with the full list.
    const problems: string[] = [];
    const seen = new Map<string, number>();
    for (const r of db.prepare(`SELECT id, ulid FROM entries ORDER BY id`).all() as Array<{ id: number; ulid: string }>) {
      if (!ULID_RE.test(r.ulid)) problems.push(`${eid(r.id)}: invalid ulid "${r.ulid}"`);
      const prev = seen.get(r.ulid);
      if (prev !== undefined) problems.push(`${eid(prev)} and ${eid(r.id)} share ulid ${r.ulid}`);
      else seen.set(r.ulid, r.id);
    }
    for (const r of db.prepare(`SELECT entry_id, ref_type, ref_value FROM refs WHERE entry_ulid IS NULL`).all() as any[]) {
      problems.push(`refs row (${eid(r.entry_id)}, ${r.ref_type}, ${r.ref_value}) has no owning entry`);
    }
    for (const r of db.prepare(`SELECT entry_id, module FROM entry_modules WHERE entry_ulid IS NULL`).all() as any[]) {
      problems.push(`entry_modules row (${eid(r.entry_id)}, ${r.module}) has no owning entry`);
    }
    const nullTasks = (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE id IS NULL`).get() as { c: number }).c;
    if (nullTasks > 0) problems.push(`${nullTasks} task row(s) with a NULL id`);
    const nullModules = (db.prepare(`SELECT COUNT(*) c FROM modules WHERE slug IS NULL`).get() as { c: number }).c;
    if (nullModules > 0) problems.push(`${nullModules} module row(s) with a NULL slug`);

    if (problems.length > 0) throw new PreflightError(problems);
    return { assignedUlids: missing.length, stampedAuthors };
  });
  return run();
}
