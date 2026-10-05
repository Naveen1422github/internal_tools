import type { DB } from "../db.js";
import { collabStartDir, findCollabFile } from "../db.js";
import { parseEntryRef } from "../ulid.js";
import { getHubStatus, IMPORTANT_TYPES } from "./hub.js";
import { hasSeries, liveEntry } from "../schema.js";
import { currentProject } from "../projects.js";
import { hasCrrTables, isCrsqliteLoaded } from "../sync/extension.js";
import { formatEntryRef } from "../entry-ref.js";

export interface DoctorCheck {
  name: string; // short id, e.g. "schema.tables"
  severity: "ok" | "warn" | "error";
  detail: string; // one-line human summary
  items?: Array<string | number>; // optional offending ids / names
}

export interface DoctorResult {
  ok: boolean; // true iff no checks have severity='error'
  checks: DoctorCheck[];
}

const EXPECTED_TABLES = new Set([
  "entries",
  "refs",
  "tasks",
  "modules",
  "dispatches",
  "entry_modules",
  "schema_migrations",
  "entries_fts",
  "entries_fts_config",
  "entries_fts_data",
  "entries_fts_docsize",
  "entries_fts_idx",
  "sqlite_sequence",
]);

const EXPECTED_INDEXES = new Set([
  "idx_entries_created",
  "idx_entries_deprecated",
  "idx_entries_kind",
  "idx_entries_module",
  "idx_entries_status",
  "idx_entries_task",
  "idx_entries_type",
  "idx_entries_category",
  "idx_entries_superseded",
  "idx_entry_modules_module",
  "idx_entry_modules_entry",
  "idx_refs_entry",
  "idx_refs_type",
  "idx_refs_value",
  "idx_tasks_assignee",
  "idx_tasks_module",
  "idx_tasks_status",
  "idx_dispatches_agent",
  "idx_dispatches_created",
  "idx_dispatches_entry",
  "idx_dispatches_module",
]);

const EXPECTED_TRIGGERS = new Set([
  "trg_entries_fts_ad",
  "trg_entries_fts_ai",
  "trg_entries_fts_au",
  "trg_entries_updated_at",
  "trg_modules_updated_at",
  "trg_refs_cascade_delete",
  "trg_tasks_updated_at",
  "trg_entry_modules_cascade_delete",
  "trg_dispatches_updated_at",
  "trg_dispatches_updated_at_insert",
]);

// Migration 0005 (staged): objects that exist only once 0005 has been applied.
// trg_entries_updated_at and trg_entries_fts_au are re-created under their same
// names by 0005, so they stay in the base EXPECTED_TRIGGERS above, not here.
const EXPECTED_TABLES_0005 = new Set(["entry_revisions"]);

const EXPECTED_INDEXES_0005 = new Set([
  "idx_entries_ulid",
  "idx_refs_entry_ulid",
  "idx_refs_target_ulid",
  "idx_entry_modules_entry_ulid",
  "idx_entry_revisions_entry",
]);

const EXPECTED_TRIGGERS_0005 = new Set([
  "trg_refs_fill_ulids",
  "trg_entry_modules_fill_ulid",
  "trg_entries_fill_superseded_ulid",
  "trg_entries_revision",
]);

// Migration 0006 rebuilds entries/refs/entry_modules/tasks/modules and the FTS
// table, so its expected objects are a complete list, not a delta.
const EXPECTED_TABLES_0006 = new Set([
  "entries", "refs", "tasks", "modules", "dispatches", "entry_modules", "schema_migrations",
  "entries_fts", "entries_fts_config", "entries_fts_content", "entries_fts_data",
  "entries_fts_docsize", "entries_fts_idx", "sqlite_sequence", "entry_revisions", "local_counters",
]);

const EXPECTED_INDEXES_0006 = new Set([
  "idx_entries_id", "idx_entries_type", "idx_entries_module", "idx_entries_task",
  "idx_entries_created", "idx_entries_kind", "idx_entries_status", "idx_entries_deprecated",
  "idx_entries_category", "idx_entries_superseded",
  "idx_refs_value", "idx_refs_type", "idx_refs_target_ulid",
  "idx_entry_modules_module",
  "idx_tasks_status", "idx_tasks_module", "idx_tasks_assignee",
  "idx_dispatches_agent", "idx_dispatches_module", "idx_dispatches_created", "idx_dispatches_entry",
  "idx_entry_revisions_entry",
]);

const EXPECTED_TRIGGERS_0006 = new Set([
  "trg_entries_updated_at", "trg_entries_fts_ai", "trg_entries_fts_ad", "trg_entries_fts_au",
  "trg_entries_ulid_immutable", "trg_entries_fill_superseded_ulid", "trg_entries_revision",
  "trg_refs_fill_target_ulid", "trg_refs_cascade_delete", "trg_entry_modules_cascade_delete",
  "trg_tasks_updated_at", "trg_modules_updated_at",
  "trg_dispatches_updated_at", "trg_dispatches_updated_at_insert",
]);

function union(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a, ...b]);
}

function diffSets(actual: Set<string>, expected: Set<string>): { missing: string[]; extra: string[] } {
  const missing = [...expected].filter((x) => !actual.has(x)).sort();
  const extra = [...actual].filter((x) => !expected.has(x)).sort();
  return { missing, extra };
}

function schemaCheck(
  name: string,
  actual: Set<string>,
  expected: Set<string>,
  label: string,
): DoctorCheck {
  const { missing, extra } = diffSets(actual, expected);
  const severity: DoctorCheck["severity"] =
    missing.length > 0 ? "error" : extra.length > 0 ? "warn" : "ok";
  const items =
    missing.length === 0 && extra.length === 0
      ? undefined
      : [...missing.map((m) => `missing:${m}`), ...extra.map((e) => `extra:${e}`)];
  const detail =
    missing.length === 0 && extra.length === 0
      ? `${expected.size} expected ${label} present`
      : `${missing.length} missing, ${extra.length} extra ${label}`;
  return { name, severity, detail, items };
}

export function doctor(db: DB, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): DoctorResult {
  const checks: DoctorCheck[] = [];

  // Migration-aware: a DB that hasn't applied staged 0005/0006 yet must never
  // see their objects reported as missing (or its data checks throw on
  // not-yet-existing columns). Guarded: schema_migrations itself may not exist
  // on a very old DB.
  const applied = (version: string): boolean => {
    try {
      return !!db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(version);
    } catch {
      return false;
    }
  };
  const has0005 = applied("0005_ulid_expand");
  const has0006 = applied("0006_ulid_contract");

  // Copied: the 0007 line below adds to it, and the constants are shared.
  const expectedTables = new Set(has0006 ? EXPECTED_TABLES_0006
    : has0005 ? union(EXPECTED_TABLES, EXPECTED_TABLES_0005) : EXPECTED_TABLES);
  let expectedIndexes = has0006 ? EXPECTED_INDEXES_0006
    : has0005 ? union(EXPECTED_INDEXES, EXPECTED_INDEXES_0005) : EXPECTED_INDEXES;
  let expectedTriggers = has0006 ? EXPECTED_TRIGGERS_0006
    : has0005 ? union(EXPECTED_TRIGGERS, EXPECTED_TRIGGERS_0005) : EXPECTED_TRIGGERS;
  // 0007 (staged) adds the local-only sync_state table and drops the revision
  // trigger (revisions are written by code from 0007, core/src/revisions.ts).
  if (applied("0007_sync_prep")) {
    expectedTables.add("sync_state");
    expectedTriggers = new Set([...expectedTriggers].filter((t) => t !== "trg_entries_revision"));
  }
  // 0009 adds the local projects table and the series/project indexes.
  if (applied("0009_projects")) {
    expectedTables.add("projects");
    expectedIndexes = union(expectedIndexes, new Set(["idx_entries_series_id", "idx_entries_project", "idx_projects_name"]));
  }
  // A shared DB carries cr-sqlite's own bookkeeping (crsql_*, <t>__crsql_clock/
  // _pks/_itrig...). Those are the extension's, not ours: not "extra".
  const shared = hasCrrTables(db);
  // cr-sqlite's own objects (crsql_* bookkeeping, <t>__crsql_* clocks/triggers)
  // are never "extra"; crsql_* tables can outlive a disableSync.
  const ours = (name: string) => !(name.startsWith("crsql_") || (shared && name.includes("crsql")));

  // 1) schema.tables
  const tableRows = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND (
            name NOT LIKE 'sqlite_%'
            OR name = 'sqlite_sequence'
          )
      `,
    )
    .all() as Array<{ name: string }>;
  const actualTables = new Set(tableRows.map((r) => r.name).filter(ours));
  checks.push(schemaCheck("schema.tables", actualTables, expectedTables, "tables"));

  // 2) schema.indexes
  const indexRows = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name NOT LIKE 'sqlite_autoindex_%'
      `,
    )
    .all() as Array<{ name: string }>;
  const actualIndexes = new Set(indexRows.map((r) => r.name).filter(ours));
  checks.push(schemaCheck("schema.indexes", actualIndexes, expectedIndexes, "indexes"));

  // 3) schema.triggers
  const triggerRows = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
      `,
    )
    .all() as Array<{ name: string }>;
  const actualTriggers = new Set(triggerRows.map((r) => r.name).filter(ours));
  checks.push(schemaCheck("schema.triggers", actualTriggers, expectedTriggers, "triggers"));

  // 4) data.orphan_refs.task
  const orphanTaskRefs = db
    .prepare(
      `
        SELECT entry_id, ref_value
        FROM refs
        WHERE ref_type = 'task'
          AND ref_value NOT IN (SELECT id FROM tasks)
        ORDER BY entry_id ASC, ref_value ASC
      `,
    )
    .all() as Array<{ entry_id: number; ref_value: string }>;
  checks.push({
    name: "data.orphan_refs.task",
    severity: orphanTaskRefs.length > 0 ? "warn" : "ok",
    detail:
      orphanTaskRefs.length > 0
        ? `found ${orphanTaskRefs.length} orphan task ref(s)`
        : "no orphan task refs",
    items:
      orphanTaskRefs.length > 0
        ? orphanTaskRefs.map((r) => `${formatEntryRef(r.entry_id)} -> T-${r.ref_value}`)
        : undefined,
  });

  // 5) data.orphan_refs.entry: parsed with the same rules as the link triggers.
  //    The old SQL used CAST(ref_value AS INTEGER), which is 0 for "E-214" and
  //    "#116", so every non-numeric link was reported as an orphan (144 false
  //    positives on the real DB, 2026-09-29). A tombstoned target still resolves
  //    (D5b: a deleted entry stays readable by its number).
  const liveIds = new Set(
    (db.prepare(`SELECT id FROM entries WHERE id IS NOT NULL`).all() as Array<{ id: number }>).map((r) => r.id),
  );
  // refs.entry_id is legacy/nullable from 0006 on; the owner is entry_ulid.
  const ownerId = has0005 ? `(SELECT e.id FROM entries e WHERE e.ulid = refs.entry_ulid)` : `entry_id`;
  // 0005+ (J17): a link is followed by target_ulid, so it is an orphan only when
  // that ULID names no row. target_ulid NULL is reported by
  // data.unresolved_entry_refs (check 11), not counted twice here.
  const orphanEntryRefs = has0005
    ? (db.prepare(
        `SELECT ${ownerId} AS entry_id, ref_value FROM refs
          WHERE ref_type = 'entry' AND target_ulid IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM entries t WHERE t.ulid = refs.target_ulid)
          ORDER BY 1 ASC, ref_value ASC`,
      ).all() as Array<{ entry_id: number | null; ref_value: string }>)
    : (
        db.prepare(`SELECT ${ownerId} AS entry_id, ref_value FROM refs WHERE ref_type = 'entry' ORDER BY 1 ASC, ref_value ASC`)
          .all() as Array<{ entry_id: number | null; ref_value: string }>
      ).filter((r) => {
        const target = parseEntryRef(r.ref_value);
        return target === null || !liveIds.has(target);
      });
  checks.push({
    name: "data.orphan_refs.entry",
    severity: orphanEntryRefs.length > 0 ? "warn" : "ok",
    detail:
      orphanEntryRefs.length > 0
        ? `found ${orphanEntryRefs.length} orphan entry ref(s)`
        : "no orphan entry refs",
    items:
      orphanEntryRefs.length > 0
        ? orphanEntryRefs.map((r) => `${formatEntryRef(r.entry_id ?? 0)} -> ${r.ref_value}`)
        : undefined,
  });

  // 6) data.orphan_module.entries
  const orphanModuleEntries = db
    .prepare(
      `
        SELECT id
        FROM entries
        WHERE module IS NOT NULL
          AND module NOT IN (SELECT slug FROM modules)
        ORDER BY id ASC
      `,
    )
    .all() as Array<{ id: number }>;
  checks.push({
    name: "data.orphan_module.entries",
    severity: orphanModuleEntries.length > 0 ? "warn" : "ok",
    detail:
      orphanModuleEntries.length > 0
        ? `found ${orphanModuleEntries.length} entries with unknown module`
        : "no orphan module entries",
    items: orphanModuleEntries.length > 0 ? orphanModuleEntries.map((r) => r.id) : undefined,
  });

  // 7) data.orphan_task.entries
  const orphanTaskEntries = db
    .prepare(
      `
        SELECT id
        FROM entries
        WHERE task_id IS NOT NULL
          AND task_id NOT IN (SELECT id FROM tasks)
        ORDER BY id ASC
      `,
    )
    .all() as Array<{ id: number }>;
  checks.push({
    name: "data.orphan_task.entries",
    severity: orphanTaskEntries.length > 0 ? "warn" : "ok",
    detail:
      orphanTaskEntries.length > 0
        ? `found ${orphanTaskEntries.length} entries with unknown task_id`
        : "no orphan task entries",
    items: orphanTaskEntries.length > 0 ? orphanTaskEntries.map((r) => r.id) : undefined,
  });

  // 8) data.dangling_superseded — superseded_by points to a non-existent entry.
  //    0005+ (J17): followed by superseded_by_ulid; before that, by the number.
  const danglingSuperseded = db
    .prepare(
      has0005
        ? `
        SELECT id, superseded_by
        FROM entries
        WHERE superseded_by_ulid IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM entries t WHERE t.ulid = entries.superseded_by_ulid)
        ORDER BY id ASC
      `
        : `
        SELECT id, superseded_by
        FROM entries
        WHERE superseded_by IS NOT NULL
          AND superseded_by NOT IN (SELECT id FROM entries)
        ORDER BY id ASC
      `,
    )
    .all() as Array<{ id: number; superseded_by: number | null }>;
  checks.push({
    name: "data.dangling_superseded",
    severity: danglingSuperseded.length > 0 ? "warn" : "ok",
    detail:
      danglingSuperseded.length > 0
        ? `found ${danglingSuperseded.length} entries with dangling superseded_by`
        : "no dangling superseded_by",
    items:
      danglingSuperseded.length > 0
        ? danglingSuperseded.map((r) => `${formatEntryRef(r.id)} -> ${formatEntryRef(r.superseded_by)}`)
        : undefined,
  });

  // 9) data.entries_without_module — non-deprecated entries with no entry_modules row
  const withoutModuleSql = has0005
    ? `SELECT id FROM entries WHERE deprecated = 0${has0006 ? " AND deleted_at IS NULL" : ""} AND ulid NOT IN (SELECT entry_ulid FROM entry_modules WHERE entry_ulid IS NOT NULL) ORDER BY id`
    : `SELECT id FROM entries WHERE deprecated = 0 AND id NOT IN (SELECT entry_id FROM entry_modules) ORDER BY id`;
  const entriesWithoutModule = db.prepare(withoutModuleSql).all() as Array<{ id: number }>;
  checks.push({
    name: "data.entries_without_module",
    severity: entriesWithoutModule.length > 0 ? "warn" : "ok",
    detail:
      entriesWithoutModule.length > 0
        ? `found ${entriesWithoutModule.length} non-deprecated entries with no module (informational)`
        : "all non-deprecated entries have at least one module",
    items: entriesWithoutModule.length > 0 ? entriesWithoutModule.map((r) => r.id) : undefined,
  });

  // 10) data.entries_without_ulid -- should be 0 after migrate()'s backfill.
  // Never queries the ulid column until 0005 has actually added it.
  if (has0005) {
    const noUlid = db.prepare(`SELECT id FROM entries WHERE ulid IS NULL ORDER BY id`).all() as Array<{ id: number }>;
    checks.push({
      name: "data.entries_without_ulid",
      // "warn", not "error": rows written by scripts or older builds that
      // insert straight into entries (bypassing addEntry/rollup) legitimately
      // lack a ulid until the next migrate() backfills them. That's expected
      // transient state, not corruption.
      severity: noUlid.length > 0 ? "warn" : "ok",
      detail: noUlid.length > 0
        ? `found ${noUlid.length} entries without a ulid; restart the server (migrate() backfills them)`
        : "every entry has a ulid",
      items: noUlid.length > 0 ? noUlid.map((r) => formatEntryRef(r.id)) : undefined,
    });
  } else {
    checks.push({
      name: "data.entries_without_ulid",
      severity: "ok",
      detail: "skipped: migration 0005 not applied",
    });
  }

  // 11) data.unresolved_entry_refs -- entry links whose target could not be matched (kept, never deleted).
  // Never queries the target_ulid column until 0005 has actually added it.
  if (has0005) {
    const unresolved = db.prepare(`
      SELECT entry_id, ref_value FROM refs
       WHERE ref_type = 'entry' AND target_ulid IS NULL
       ORDER BY entry_id, ref_value
    `).all() as Array<{ entry_id: number; ref_value: string }>;
    checks.push({
      name: "data.unresolved_entry_refs",
      severity: unresolved.length > 0 ? "warn" : "ok",
      detail: unresolved.length > 0
        ? `found ${unresolved.length} entry links that point at no existing entry`
        : "every entry link resolves",
      items: unresolved.length > 0 ? unresolved.map((r) => `${formatEntryRef(r.entry_id)} -> ${JSON.stringify(r.ref_value)}`) : undefined,
    });
  } else {
    checks.push({
      name: "data.unresolved_entry_refs",
      severity: "ok",
      detail: "skipped: migration 0005 not applied",
    });
  }

  const has0009 = hasSeries(db);
  if (has0006) {
    // From 0009 a number is unique per series: E-1 and SH-1 are different notes.
    const dupIds = db
      .prepare(has0009
        ? `SELECT series, id, COUNT(*) AS n FROM entries WHERE id IS NOT NULL GROUP BY series, id HAVING n > 1 ORDER BY series = 'E' DESC, series, id`
        : `SELECT 'E' AS series, id, COUNT(*) AS n FROM entries WHERE id IS NOT NULL GROUP BY id HAVING n > 1 ORDER BY id`)
      .all() as Array<{ series: string; id: number; n: number }>;
    checks.push({
      name: "data.duplicate_entry_ids",
      severity: dupIds.length > 0 ? "warn" : "ok",
      detail: dupIds.length > 0 ? `${dupIds.length} E-number(s) used by more than one entry` : "every E-number is unique",
      items: dupIds.length > 0 ? dupIds.map((r) => `${formatEntryRef(r.id, r.series)} x${r.n}`) : undefined,
    });
    const tomb = (db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NOT NULL`).get() as { c: number }).c;
    checks.push({ name: "data.tombstones", severity: "ok", detail: `${tomb} tombstoned entr${tomb === 1 ? "y" : "ies"}` });
  }

  // Stage B1 (spec rule 8): every project state explained. 0009+ only.
  if (has0009) checks.push(...projectChecks(db, opts));

  // T-011 / E-657: main note (hub) coverage. warn-only: drift, not corruption.
  // Only registered modules (modules table) are checked; modules that exist
  // only in entry_modules can't hold a hub and are covered by orphan_module.
  if (has0005) {
    const types = IMPORTANT_TYPES.map((t) => `'${t}'`).join(",");
    const slugs = (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
    const hasImportant = db.prepare(
      `SELECT 1 FROM entry_modules em JOIN entries e ON e.ulid = em.entry_ulid
        WHERE em.module = ? AND ${liveEntry(db, "e")} AND e.deprecated = 0 AND e.type IN (${types}) LIMIT 1`,
    );
    const missing: string[] = [];
    const unlinked: string[] = [];
    const expired: string[] = [];
    for (const slug of slugs) {
      const s = getHubStatus(db, slug, 0);
      if (s.state !== "ok") {
        if (hasImportant.get(slug)) missing.push(slug);
        continue;
      }
      const c = s.coverage!;
      if (c.unlinked_count > 0) unlinked.push(`${slug}: ${c.unlinked_count} not linked from ${formatEntryRef(c.hub.id)}`);
      for (const x of c.expired) expired.push(`${slug}: ${formatEntryRef(x.from_id)} -> ${x.to_id !== null ? formatEntryRef(x.to_id) : x.to_ref}`);
    }
    checks.push({
      name: "hub.missing",
      severity: missing.length > 0 ? "warn" : "ok",
      detail: missing.length > 0 ? `${missing.length} module(s) have important notes but no live main note` : "every module with important notes has a main note",
      items: missing.length > 0 ? missing : undefined,
    });
    checks.push({
      name: "hub.unlinked",
      severity: unlinked.length > 0 ? "warn" : "ok",
      detail: unlinked.length > 0 ? `${unlinked.length} module(s) have notes their main note does not reach` : "main notes reach every important note",
      items: unlinked.length > 0 ? unlinked : undefined,
    });
    checks.push({
      name: "hub.expired_links",
      severity: expired.length > 0 ? "warn" : "ok",
      detail: expired.length > 0 ? `${expired.length} main-note link(s) point at retired notes (remove with collab_update_refs)` : "no expired main-note links",
      items: expired.length > 0 ? expired : undefined,
    });
  }

  // Sync v1 (plan 1): forks awaiting a person, and the extension a shared DB needs.
  if (db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get()) {
    const nm = db.prepare(`SELECT id FROM entries WHERE needs_merge = 1 AND deprecated = 0 ORDER BY id`).all() as Array<{ id: number }>;
    checks.push({
      name: "sync.needs_merge",
      severity: nm.length > 0 ? "warn" : "ok",
      detail: nm.length > 0 ? `${nm.length} note(s) have edits the post office could not merge; pick the final text` : "no unmerged edits",
      items: nm.length > 0 ? nm.map((r) => formatEntryRef(r.id)) : undefined,
    });
  }
  if (hasCrrTables(db)) {
    const loaded = isCrsqliteLoaded(db);
    checks.push({
      name: "sync.extension",
      severity: loaded ? "ok" : "error",
      detail: loaded ? "cr-sqlite loaded" : "this DB shares notes but cr-sqlite is not loaded on this connection: writes will fail",
    });
  }

  // fts.integrity: row-count parity cannot see a corrupted index (E-684).
  // The strict form (rank = 1) also compares against the content table.
  // Several sessions + the REST server share the file: a lock is not corruption.
  let ftsIntegrity = "ok";
  let ftsBusy = false;
  try {
    db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`);
  } catch (e) {
    ftsIntegrity = (e as Error).message;
    const code = (e as { code?: string }).code;
    ftsBusy = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
  }
  checks.push({
    name: "fts.integrity",
    severity: ftsIntegrity === "ok" ? "ok" : ftsBusy ? "warn" : "error",
    detail:
      ftsIntegrity === "ok" ? "fts index consistent"
        : ftsBusy ? `fts integrity-check skipped: database busy (${ftsIntegrity}); rerun doctor`
        : `fts integrity-check failed: ${ftsIntegrity}`,
  });

  // 12) fts.count_parity
  const entryCount = (db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c;
  const ftsCount = (db.prepare("SELECT COUNT(*) AS c FROM entries_fts").get() as { c: number }).c;
  const parityOk = entryCount === ftsCount;
  checks.push({
    name: "fts.count_parity",
    severity: parityOk ? "ok" : "error",
    detail: parityOk
      ? `entries=${entryCount}, entries_fts=${ftsCount}`
      : `entries=${entryCount}, entries_fts=${ftsCount}`,
  });

  // 13) fts.rebuild_hint
  checks.push({
    name: "fts.rebuild_hint",
    severity: parityOk ? "ok" : "warn",
    detail: parityOk
      ? "fts index in sync"
      : "Run: INSERT INTO entries_fts(entries_fts) VALUES('rebuild');",
  });

  return {
    ok: checks.every((c) => c.severity !== "error"),
    checks,
  };
}


/** projects.current / projects.orphan_notes / projects.series_mismatch (stage B1). */
function projectChecks(db: DB, opts: { cwd?: string; env?: NodeJS.ProcessEnv }): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  try {
    const found = findCollabFile(collabStartDir(opts));
    const p = currentProject(db, opts);
    out.push({
      name: "projects.current",
      severity: "ok",
      detail: p
        ? `${p.code} ${p.name} (${p.mode}), from ${found!.file}: new notes are ${p.code}-n`
        : "none: notes go to the E series (no .collab names a project)",
    });
  } catch (e) {
    out.push({ name: "projects.current", severity: "error", detail: (e as Error).message.replace(/^\[collab\] /, "") });
  }

  const orphans = db.prepare(
    `SELECT e.series, e.id FROM entries e
      WHERE e.project_ulid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.ulid = e.project_ulid)
      ORDER BY e.series, e.id`,
  ).all() as Array<{ series: string; id: number | null }>;
  out.push({
    name: "projects.orphan_notes",
    severity: orphans.length > 0 ? "error" : "ok",
    detail: orphans.length > 0
      ? `${orphans.length} note(s) name a project that isn't in this notebook`
      : "every project note's project is here",
    items: orphans.length > 0 ? orphans.map((r) => formatEntryRef(r.id, r.series)) : undefined,
  });

  const mismatched = db.prepare(
    `SELECT e.series, e.id, p.code FROM entries e JOIN projects p ON p.ulid = e.project_ulid
      WHERE e.series <> p.code ORDER BY e.series, e.id`,
  ).all() as Array<{ series: string; id: number | null; code: string }>;
  out.push({
    name: "projects.series_mismatch",
    severity: mismatched.length > 0 ? "error" : "ok",
    detail: mismatched.length > 0
      ? `${mismatched.length} note(s) numbered in another series than their project's code`
      : "every project note carries its project's code",
    items: mismatched.length > 0 ? mismatched.map((r) => `${formatEntryRef(r.id, r.series)} (project ${r.code})`) : undefined,
  });
  return out;
}
