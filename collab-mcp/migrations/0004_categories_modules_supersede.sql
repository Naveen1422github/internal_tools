-- ============================================================
-- Collab — knowledge-model redesign (decision E-00163)
-- Migration: 0004_categories_modules_supersede
--
-- Splits the overloaded `type` column into independent axes:
--   Axis 1  modules    -> many-to-many (entry_modules)
--   Axis 2  category   -> Index | Reference | Activity (drives lifecycle + retrieval)
--   Axis 3  type       -> unchanged, now content-shape only
-- Plus supersession (superseded_by) for "stale old once decided".
--
-- Additive only: ADD COLUMN + new table + backfill. No table rebuild,
-- no FTS surgery. Applies automatically on next server start.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Axis 2: category. Default 'Activity' is the safe (archivable) bucket;
-- backfill below promotes durable rows to Reference/Index.
-- ------------------------------------------------------------
ALTER TABLE entries
  ADD COLUMN category TEXT NOT NULL DEFAULT 'Activity'
  CHECK (category IN ('Index', 'Reference', 'Activity'));

-- ------------------------------------------------------------
-- Supersession: soft ref (entry id) to the entry that replaces this one.
-- NULL = not superseded. Not a hard FK (consistent with the soft-FK design).
-- ------------------------------------------------------------
ALTER TABLE entries
  ADD COLUMN superseded_by INTEGER;

-- ------------------------------------------------------------
-- Backfill category from existing type.
--   decision / gotcha                        -> Reference (durable truth)
--   handoff / review / session-note /
--   changelog / proposal / counter / rollup  -> Activity  (work trail; default)
--   known navigation hubs (READ-FIRST TOCs)  -> Index
-- (Default already set Activity, so we only need to promote Reference + Index.)
-- ------------------------------------------------------------
UPDATE entries SET category = 'Reference' WHERE type IN ('decision', 'gotcha');

-- Known index hubs. #155 = "📑 INDEX — Custom Reports Redesign — READ FIRST".
-- It stays type='handoff' (content shape) but category='Index' (protected) —
-- the exact entry whose mis-categorization motivated this redesign.
UPDATE entries SET category = 'Index' WHERE id IN (155);

CREATE INDEX IF NOT EXISTS idx_entries_category   ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_superseded ON entries(superseded_by);

-- ------------------------------------------------------------
-- Axis 1: many-to-many modules. An entry can belong to several modules;
-- exactly one row per entry may be is_primary=1 (home attribution).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_modules (
  entry_id    INTEGER NOT NULL,
  module      TEXT NOT NULL,            -- soft FK to modules.slug
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (entry_id, module)
);

CREATE INDEX IF NOT EXISTS idx_entry_modules_module ON entry_modules(module);
CREATE INDEX IF NOT EXISTS idx_entry_modules_entry  ON entry_modules(entry_id);

-- Cascade: drop an entry's module rows when the entry is hard-deleted.
CREATE TRIGGER IF NOT EXISTS trg_entry_modules_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM entry_modules WHERE entry_id = old.id;
END;

-- Backfill from the existing single entries.module as the primary module.
INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary)
  SELECT id, module, 1 FROM entries WHERE module IS NOT NULL AND TRIM(module) <> '';

-- ------------------------------------------------------------
-- Record this migration
-- ------------------------------------------------------------
INSERT INTO schema_migrations (version) VALUES ('0004_categories_modules_supersede');

COMMIT;

-- ============================================================
-- Verify after apply:
--   SELECT category, COUNT(*) FROM entries GROUP BY category;
--   SELECT COUNT(*) FROM entry_modules;
--   SELECT id, type, category FROM entries WHERE id = 155;   -- expect Index
-- ============================================================
