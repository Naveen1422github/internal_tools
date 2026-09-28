#!/usr/bin/env node
/**
 * Rehearse 0005 on a COPY of a real collab DB. Never writes to the source.
 *   npx tsx src/scripts/rehearse-0005.ts <path-to-collab.db>
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative SOURCE imports on purpose: "@collab-mcp/core" resolves to core/dist,
// which is the old build until the user rebuilds. tsx runs the .ts directly.
import { migrate as migrateProd } from "../../../core/src/db.js";
import { doctor } from "../../../core/src/ops/doctor.js";
import { searchEntries } from "../../../core/src/ops/search.js";

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });
// Terms that must find the same entry ids before and after (E-643: rows existing != search finding them).
const PROBE_TERMS = ["migration", "supporthub", "timesheet"];

const source = process.argv[2];
if (!source) throw new Error("usage: rehearse-0005.ts <path-to-collab.db>");

const dir = mkdtempSync(join(tmpdir(), "rehearse-0005-"));
const src = new Database(source, { readonly: true, fileMustExist: true });
const copyA = join(dir, "a.db"), copyB = join(dir, "b.db");
src.prepare("VACUUM INTO ?").run(copyA);
src.prepare("VACUUM INTO ?").run(copyB);
const beforeUpdatedAt = new Map(
  (src.prepare("SELECT id, updated_at FROM entries").all() as any[]).map((r) => [r.id, r.updated_at]),
);
src.close();

const a = new Database(copyA), b = new Database(copyB);
const hits = (db: Database.Database) =>
  Object.fromEntries(
    PROBE_TERMS.map((t) => [
      t,
      searchEntries(db, { query: t, kind: "any", include_deprecated: false, limit: 50 }).results
        .map((r: any) => r.id)
        .sort(),
    ]),
  );
const searchBefore = hits(a);
const appliedA = migrate(a); migrate(b);
const searchAfter = hits(a);
let ftsIntegrity = "ok";
try { a.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')"); }
catch (e) { ftsIntegrity = (e as Error).message; }

const one = (db: Database.Database, sql: string) => (db.prepare(sql).get() as any).c as number;
const ids = (sql: string) => a.prepare(sql).all().map((r: any) => r.id);
const same = JSON.stringify(ids("SELECT id FROM entries ORDER BY ulid")) === JSON.stringify(ids("SELECT id FROM entries ORDER BY id"));
const deterministic =
  JSON.stringify(a.prepare("SELECT id, ulid FROM entries ORDER BY id").all()) ===
  JSON.stringify(b.prepare("SELECT id, ulid FROM entries ORDER BY id").all());
const updatedAtChanged = (a.prepare("SELECT id, updated_at FROM entries").all() as any[])
  .filter((r) => beforeUpdatedAt.get(r.id) !== r.updated_at).length;

const report = {
  applied: appliedA,
  entries: one(a, "SELECT COUNT(*) c FROM entries"),
  entriesWithoutUlid: one(a, "SELECT COUNT(*) c FROM entries WHERE ulid IS NULL"),
  refsWithoutEntryUlid: one(a, "SELECT COUNT(*) c FROM refs WHERE entry_ulid IS NULL"),
  entryModulesWithoutUlid: one(a, "SELECT COUNT(*) c FROM entry_modules WHERE entry_ulid IS NULL"),
  entryLinks: one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry'"),
  entryLinksUnresolved: one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry' AND target_ulid IS NULL"),
  supersededResolved: `${one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by_ulid IS NOT NULL")} / ${one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by IS NOT NULL")}`,
  ulidOrderEqualsIdOrder: same,
  deterministicAcrossCopies: deterministic,
  updatedAtChanged,
  ftsIntegrity,
  searchUnchanged: JSON.stringify(searchBefore) === JSON.stringify(searchAfter),
  doctor: doctor(a).checks.filter((c) => c.severity !== "ok").map((c) => ({ name: c.name, severity: c.severity, detail: c.detail, items: c.items?.slice(0, 20) })),
  copies: dir,
};
console.log(JSON.stringify(report, null, 2));
a.close(); b.close();
