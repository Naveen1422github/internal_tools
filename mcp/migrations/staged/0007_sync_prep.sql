-- ============================================================
-- Collab — sync v1 preparation (spec 2026-10-04, plan 1)
-- Migration: 0007_sync_prep
--
-- Additive only. entries.needs_merge: set by the post office when two edits
-- of one entry cannot be merged (spec D8). sync_state: LOCAL-ONLY key/value
-- (never a CRR) holding this machine's sharing settings.
-- ============================================================
BEGIN;

ALTER TABLE entries ADD COLUMN needs_merge INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

INSERT INTO schema_migrations (version) VALUES ('0007_sync_prep');

COMMIT;
