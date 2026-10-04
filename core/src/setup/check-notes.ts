import Database from "better-sqlite3";
import { doctor } from "../ops/doctor.js";
import { liveEntry } from "../schema.js";
import { hasCrrTables, loadCrsqlite, isCrsqliteLoaded } from "../sync/extension.js";
import type { DB } from "../db.js";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "notes" as const;

/**
 * The existing data checks, unchanged. They run on their own short-lived
 * read-write handle: FTS5's 'integrity-check' command is an INSERT, which a
 * read-only connection refuses ("attempt to write a readonly database") even
 * though it changes nothing. No other statement here writes.
 */
export function checkNoteData(_ctx: SetupContext, st: GroupState): SetupCheck[] {
  const db: DB = new Database(st.resolution!.path, { fileMustExist: true });
  try {
    if (hasCrrTables(db)) loadCrsqlite(db);
    const r = doctor(db);
    const ok = r.checks.filter((c) => c.severity === "ok").length;
    const out: SetupCheck[] = [];
    if (ok) out.push({ group: G, id: "notes.ok", mark: "ok", text: `${ok} checks passed` });
    for (const c of r.checks.filter((c) => c.severity !== "ok")) {
      out.push({ group: G, id: "notes." + c.name, mark: c.severity === "warn" ? "warn" : "error", text: c.detail });
    }
    return out;
  } finally {
    if (isCrsqliteLoaded(db)) { try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ } }
    db.close();
  }
}

/** E-643: every live note must be findable by search. */
export function checkSearchIndex(_ctx: SetupContext, st: GroupState): SetupCheck {
  const db = st.db!;
  const hasUlid = !!db.prepare(`SELECT 1 FROM pragma_table_info('entries_fts') WHERE name = 'ulid'`).get();
  if (!hasUlid) return { group: G, id: "notes.search", mark: "ok", text: "search index check needs migration 0006" };
  const { n } = db.prepare(
    `SELECT COUNT(*) n FROM entries e WHERE ${liveEntry(db, "e")} AND e.ulid NOT IN (SELECT ulid FROM entries_fts WHERE ulid IS NOT NULL)`,
  ).get() as { n: number };
  return n > 0
    ? { group: G, id: "notes.search", mark: "error", text: `${n} note(s) can't be found by search`, fix: "collab notebook reindex" }
    : { group: G, id: "notes.search", mark: "ok", text: "Every note is in the search index" };
}
