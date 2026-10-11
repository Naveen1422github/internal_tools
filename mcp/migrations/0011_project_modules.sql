-- ============================================================
-- Collab piece 2: module -> project binding.
-- Migration: 0011_project_modules
--
-- A note's project is chosen from its primary module (collab project bind).
-- project_modules is LOCAL, like projects (0010): a binding is this laptop's
-- own setting and must never be sent to a post office, so it is never a CRR
-- and is not in SYNCED_TABLES or CRR_ALTERS.
-- ============================================================
BEGIN;
CREATE TABLE IF NOT EXISTS project_modules (
  module       TEXT PRIMARY KEY,           -- soft FK to modules.slug
  project_ulid TEXT NOT NULL,              -- soft FK to projects.ulid
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_migrations (version) VALUES ('0011_project_modules');
COMMIT;
