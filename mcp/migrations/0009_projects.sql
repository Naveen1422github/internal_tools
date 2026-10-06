-- ============================================================
-- Collab piece 2 stage B1: projects with their own note series (spec P1).
-- Migration: 0009_projects
--
-- entries is a cr-sqlite CRR on a shared notebook. core/src/db.ts runs this
-- file inside one transaction between crsql_begin_alter('entries') and
-- crsql_commit_alter when the table is a CRR (and plainly when it is not), so
-- this file has no BEGIN/COMMIT of its own (same path as 0008).
-- ============================================================
ALTER TABLE entries ADD COLUMN series TEXT NOT NULL DEFAULT 'E';
ALTER TABLE entries ADD COLUMN project_ulid TEXT;
CREATE INDEX IF NOT EXISTS idx_entries_series_id ON entries (series, id);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries (project_ulid);

-- Local, never synced in B1 (team projects arrive in stage C).
CREATE TABLE IF NOT EXISTS projects (
  ulid        TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE CHECK (code GLOB '[A-Z][A-Z0-9]*' AND length(code) BETWEEN 2 AND 8 AND code <> 'E'),
  mode        TEXT NOT NULL DEFAULT 'solo' CHECK (mode IN ('solo', 'team')),
  team        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects (lower(name));

ALTER TABLE dispatches ADD COLUMN entry_ulid TEXT;

-- A synced notebook gets the guarded variant of this trigger right after this
-- file (core/src/db.ts AFTER_MIGRATION, E-643).
DROP TRIGGER IF EXISTS trg_refs_fill_target_ulid;
CREATE TRIGGER trg_refs_fill_target_ulid
AFTER INSERT ON refs
WHEN NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
BEGIN
  UPDATE refs SET target_ulid = (
    SELECT e.ulid FROM entries e, (
      -- A project code (2-8 of A-Z/0-9, starting with a letter, before the first '-')
      -- is checked FIRST, so a code like E2 in 'E2-5' is not misread as legacy 'E2'.
      SELECT COALESCE(c, CASE
               WHEN s GLOB '#[0-9]*' OR s GLOB 'E-[0-9]*' OR s GLOB 'E[0-9]*' OR (s <> '' AND s NOT GLOB '*[^0-9]*') THEN 'E'
             END) AS ser,
             CASE
               WHEN c IS NOT NULL     THEN substr(s, length(c) + 2)
               WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
               WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
               WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
               ELSE s
             END AS d
        FROM (
          SELECT s, CASE
                   WHEN instr(s, '-') BETWEEN 3 AND 9
                    AND substr(s, 1, instr(s, '-') - 1) GLOB '[A-Z]*'
                    AND substr(s, 1, instr(s, '-') - 1) NOT GLOB '*[^A-Z0-9]*'
                   THEN substr(s, 1, instr(s, '-') - 1)
                 END AS c
            FROM (SELECT upper(trim(NEW.ref_value, ' ' || char(9,10,11,12,13,160))) AS s)
        )
    ) p
    WHERE p.ser IS NOT NULL
      AND p.d <> '' AND p.d NOT GLOB '*[^0-9]*' AND CAST(p.d AS INTEGER) > 0
      AND e.series = p.ser AND e.id = CAST(p.d AS INTEGER)
    ORDER BY e.ulid LIMIT 1
  )
  WHERE entry_ulid = NEW.entry_ulid AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END;

-- superseded_by is a bare number, so it means series E: without the series
-- filter a missing E-n would fill in a project note's ulid (SH-n).
DROP TRIGGER IF EXISTS trg_entries_fill_superseded_ulid;
CREATE TRIGGER trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
WHEN NEW.superseded_by IS NOT OLD.superseded_by
 AND NEW.superseded_by_ulid IS OLD.superseded_by_ulid
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = NEW.superseded_by AND e.series = 'E' ORDER BY e.ulid LIMIT 1)
   WHERE ulid = NEW.ulid;
END;

INSERT INTO schema_migrations (version) VALUES ('0009_projects');
