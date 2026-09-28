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
const copyA = join(dir, "a.db"), copyB = join(dir, "b.db");

// ONE snapshot of the source, taken once, read-only. copyB is then derived
// from copyA (not from the source a second time) so there is no window for a
// live writer to make copyA and copyB diverge before either is migrated.
const src = new Database(source, { readonly: true, fileMustExist: true });
src.prepare("VACUUM INTO ?").run(copyA);
src.close();

const a = new Database(copyA);
a.prepare("VACUUM INTO ?").run(copyB);
// Read BEFORE migrating either copy, and from copyA (the frozen snapshot),
// not the live source.
const beforeUpdatedAt = new Map(
  (a.prepare("SELECT id, updated_at FROM entries").all() as any[]).map((r) => [r.id, r.updated_at]),
);

const b = new Database(copyB);
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

const entriesWithoutUlid = one(a, "SELECT COUNT(*) c FROM entries WHERE ulid IS NULL");
const refsWithoutEntryUlid = one(a, "SELECT COUNT(*) c FROM refs WHERE entry_ulid IS NULL");
const entryModulesWithoutUlid = one(a, "SELECT COUNT(*) c FROM entry_modules WHERE entry_ulid IS NULL");
const entryLinksUnresolved = one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry' AND target_ulid IS NULL");
const supersededResolvedCount = one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by_ulid IS NOT NULL");
const supersededTotalCount = one(a, "SELECT COUNT(*) c FROM entries WHERE superseded_by IS NOT NULL");
const revisionsAfterMigrate = one(a, "SELECT COUNT(*) c FROM entry_revisions");
const searchUnchanged = JSON.stringify(searchBefore) === JSON.stringify(searchAfter);
const doctorChecks = doctor(a).checks;
const doctorErrors = doctorChecks.filter((c) => c.severity === "error");

const report = {
  applied: appliedA,
  entries: one(a, "SELECT COUNT(*) c FROM entries"),
  entriesWithoutUlid,
  refsWithoutEntryUlid,
  entryModulesWithoutUlid,
  entryLinks: one(a, "SELECT COUNT(*) c FROM refs WHERE ref_type='entry'"),
  entryLinksUnresolved,
  supersededResolved: `${supersededResolvedCount} / ${supersededTotalCount}`,
  ulidOrderEqualsIdOrder: same,
  deterministicAcrossCopies: deterministic,
  updatedAtChanged,
  revisionsAfterMigrate,
  ftsIntegrity,
  searchUnchanged,
  doctor: doctorChecks.filter((c) => c.severity !== "ok").map((c) => ({ name: c.name, severity: c.severity, detail: c.detail, items: c.items?.slice(0, 20) })),
  copies: dir,
};

// ------------------------------------------------------------
// Pass/fail summary. Anything false here means the rehearsal did NOT prove
// 0005 is safe to release, regardless of how the raw numbers above read.
// ------------------------------------------------------------
const criteria: Array<[string, boolean]> = [
  ["entriesWithoutUlid", entriesWithoutUlid === 0],
  ["refsWithoutEntryUlid", refsWithoutEntryUlid === 0],
  ["entryModulesWithoutUlid", entryModulesWithoutUlid === 0],
  ["entryLinksUnresolved", entryLinksUnresolved === 0],
  ["ulidOrderEqualsIdOrder", same === true],
  ["deterministicAcrossCopies", deterministic === true],
  ["supersededResolved", supersededResolvedCount === supersededTotalCount],
  ["updatedAtChanged", updatedAtChanged === 0],
  ["ftsIntegrity", ftsIntegrity === "ok"],
  ["searchUnchanged", searchUnchanged === true],
  ["revisionsAfterMigrate", revisionsAfterMigrate === 0],
  ["doctorNoErrors", doctorErrors.length === 0],
];
const failed = criteria.filter(([, pass]) => !pass).map(([name]) => name);

console.log(JSON.stringify(report, null, 2));
console.log(JSON.stringify({ failed }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}

a.close(); b.close();
