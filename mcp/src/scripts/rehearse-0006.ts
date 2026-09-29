#!/usr/bin/env node
/**
 * Rehearse 0006 on a COPY of a real collab DB. Never writes to the source.
 *   npx tsx src/scripts/rehearse-0006.ts <path-to-collab.db>
 * Optional: CRSQLITE_PATH=<dir>/crsqlite (no extension) also runs crsql_as_crr
 * on a second copy (cr-sqlite v0.16.3 prebuilt from its GitHub release; its npm
 * postinstall is broken on Node 22, so it is never a package dependency).
 */
import Database from "better-sqlite3";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative SOURCE imports: "@collab-mcp/core" is core/dist, stale until rebuilt.
import { migrate as migrateProd } from "../../../core/src/db.js";
import { doctor } from "../../../core/src/ops/doctor.js";
import { searchEntries } from "../../../core/src/ops/search.js";

const migrate = (db: Database.Database) => migrateProd(db, { includeStaged: true });
const PROBE_TERMS = ["migration", "supporthub", "timesheet", "ulid", "relay"];
const SYNCED = ["entries", "refs", "entry_modules", "entry_revisions", "tasks", "modules"];

const source = process.argv[2];
if (!source) throw new Error("usage: rehearse-0006.ts <path-to-collab.db>");
const sourceStat = statSync(source);

const dir = mkdtempSync(join(tmpdir(), "rehearse-0006-"));
const copyA = join(dir, "a.db");
const src = new Database(source, { readonly: true, fileMustExist: true });
src.prepare("VACUUM INTO ?").run(copyA);
src.close();

const a = new Database(copyA);
const one = (sql: string) => (a.prepare(sql).get() as any)?.c as number;
const rows = (sql: string) => JSON.stringify(a.prepare(sql).all());
const hits = () =>
  Object.fromEntries(
    PROBE_TERMS.map((t) => [
      t,
      searchEntries(a, { query: t, kind: "any", include_deprecated: false, limit: 50 } as any).results
        .map((r: any) => r.id).sort((x: number, y: number) => x - y),
    ]),
  );

// ---- before (0005) ----
const ENTRY_COLS = `ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category, superseded_by, author, superseded_by_ulid`;
const before = {
  entries: rows(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`),
  refs: rows(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`),
  modules: rows(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`),
  tasks: rows(`SELECT * FROM tasks ORDER BY id`),
  moduleRows: rows(`SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules ORDER BY slug`),
  revisions: one(`SELECT COUNT(*) c FROM entry_revisions`),
  expectedCounter: one(`SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='entries'),0), COALESCE((SELECT MAX(id) FROM entries),0)) c`),
  search: hits(),
};
const t0 = Date.now();
const applied = migrate(a);
const migrateMs = Date.now() - t0;

// ---- after (0006) ----
const after = {
  entries: rows(`SELECT ${ENTRY_COLS} FROM entries ORDER BY ulid`),
  refs: rows(`SELECT entry_ulid, ref_type, ref_value, target_ulid FROM refs ORDER BY 1, 2, 3`),
  modules: rows(`SELECT entry_ulid, module, is_primary FROM entry_modules ORDER BY 1, 2`),
  tasks: rows(`SELECT * FROM tasks ORDER BY id`),
  moduleRows: rows(`SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules ORDER BY slug`),
  revisions: one(`SELECT COUNT(*) c FROM entry_revisions`),
  counter: one(`SELECT value c FROM local_counters WHERE name='entry_number'`),
  search: hits(),
};
let ftsIntegrity = "ok";
try { a.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`); }
catch (e) { ftsIntegrity = (e as Error).message; }
const doctorChecks = doctor(a).checks;
a.close();

// ---- optional: cr-sqlite on a copy of the migrated copy ----
const crr: Record<string, string> = {};
if (process.env.CRSQLITE_PATH) {
  const copyB = join(dir, "b.db");
  const m = new Database(copyA);
  m.prepare("VACUUM INTO ?").run(copyB);
  m.close();
  const b = new Database(copyB);
  b.loadExtension(process.env.CRSQLITE_PATH);
  for (const t of SYNCED) {
    try { b.prepare("SELECT crsql_as_crr(?)").get(t); crr[t] = "ok"; }
    catch (e) { crr[t] = (e as Error).message; }
  }
  b.prepare("SELECT crsql_finalize()").get();
  b.close();
}

const liveStat = statSync(source);
const criteria: Array<[string, boolean]> = [
  ["applied0006", applied.includes("0006_ulid_contract")],
  ["entriesUnchanged", before.entries === after.entries],
  ["refsUnchanged", before.refs === after.refs],
  ["entryModulesUnchanged", before.modules === after.modules],
  ["tasksUnchanged", before.tasks === after.tasks],
  ["modulesUnchanged", before.moduleRows === after.moduleRows],
  ["noNewRevisions", before.revisions === after.revisions],
  ["counterSeeded", after.counter === before.expectedCounter],
  ["searchUnchanged", JSON.stringify(before.search) === JSON.stringify(after.search)],
  ["ftsIntegrity", ftsIntegrity === "ok"],
  ["doctorNoErrors", doctorChecks.every((c) => c.severity !== "error")],
  ["crrOk", Object.values(crr).every((v) => v === "ok")],
  ["liveDbUntouched", liveStat.size === sourceStat.size && liveStat.mtimeMs === sourceStat.mtimeMs],
];
const failed = criteria.filter(([, pass]) => !pass).map(([n]) => n);
console.log(JSON.stringify({
  applied, migrateMs, counter: after.counter, expectedCounter: before.expectedCounter,
  counts: Object.fromEntries((["entries", "refs", "modules", "tasks", "moduleRows"] as const).map((k) => [
    k, { before: JSON.parse(before[k]).length, after: JSON.parse(after[k]).length },
  ])),
  revisions: { before: before.revisions, after: after.revisions },
  searchHits: Object.fromEntries(PROBE_TERMS.map((t) => [t, { before: before.search[t].length, after: after.search[t].length }])),
  ftsIntegrity,
  crr: process.env.CRSQLITE_PATH ? crr : "skipped (CRSQLITE_PATH not set)",
  doctor: doctorChecks.map((c) => ({ name: c.name, severity: c.severity, detail: c.detail })),
  copies: dir, failed,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
