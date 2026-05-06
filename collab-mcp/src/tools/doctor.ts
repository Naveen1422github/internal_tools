import type { DB } from "../db.js";

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
  "idx_refs_entry",
  "idx_refs_type",
  "idx_refs_value",
  "idx_tasks_assignee",
  "idx_tasks_module",
  "idx_tasks_status",
]);

const EXPECTED_TRIGGERS = new Set([
  "trg_entries_fts_ad",
  "trg_entries_fts_ai",
  "trg_entries_fts_au",
  "trg_entries_updated_at",
  "trg_modules_updated_at",
  "trg_refs_cascade_delete",
  "trg_tasks_updated_at",
]);

function toEntryId(id: number): string {
  return `E-${String(id).padStart(5, "0")}`;
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

export function doctor(db: DB): DoctorResult {
  const checks: DoctorCheck[] = [];

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
  const actualTables = new Set(tableRows.map((r) => r.name));
  checks.push(schemaCheck("schema.tables", actualTables, EXPECTED_TABLES, "tables"));

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
  const actualIndexes = new Set(indexRows.map((r) => r.name));
  checks.push(schemaCheck("schema.indexes", actualIndexes, EXPECTED_INDEXES, "indexes"));

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
  const actualTriggers = new Set(triggerRows.map((r) => r.name));
  checks.push(schemaCheck("schema.triggers", actualTriggers, EXPECTED_TRIGGERS, "triggers"));

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
        ? orphanTaskRefs.map((r) => `${toEntryId(r.entry_id)} -> T-${r.ref_value}`)
        : undefined,
  });

  // 5) data.orphan_refs.entry
  const orphanEntryRefs = db
    .prepare(
      `
        SELECT entry_id, ref_value
        FROM refs
        WHERE ref_type = 'entry'
          AND CAST(ref_value AS INTEGER) NOT IN (SELECT id FROM entries)
        ORDER BY entry_id ASC, ref_value ASC
      `,
    )
    .all() as Array<{ entry_id: number; ref_value: string }>;
  checks.push({
    name: "data.orphan_refs.entry",
    severity: orphanEntryRefs.length > 0 ? "warn" : "ok",
    detail:
      orphanEntryRefs.length > 0
        ? `found ${orphanEntryRefs.length} orphan entry ref(s)`
        : "no orphan entry refs",
    items:
      orphanEntryRefs.length > 0
        ? orphanEntryRefs.map((r) => {
            const missingId = Number.parseInt(r.ref_value, 10);
            return `${toEntryId(r.entry_id)} -> ${toEntryId(Number.isFinite(missingId) ? missingId : 0)}`;
          })
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

  // 8) fts.count_parity
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

  // 9) fts.rebuild_hint
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

