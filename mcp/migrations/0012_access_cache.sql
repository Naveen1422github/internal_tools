-- ============================================================
-- Collab RnR stage S1: local access cache.
-- Migration: 0012_access_cache
--
-- This laptop's permissions as last fetched from the post office
-- (scope_key = 'office' or a project ULID). access_cache is LOCAL, like
-- projects (0010) and project_modules (0011): it is never a CRR and is not in
-- SYNCED_TABLES or CRR_ALTERS.
-- ============================================================
BEGIN;
CREATE TABLE IF NOT EXISTS access_cache (
  scope_key    TEXT PRIMARY KEY,            -- 'office' or the project ULID
  project_ulid TEXT,                        -- NULL for the office row
  role_name    TEXT NOT NULL,
  keys         TEXT NOT NULL,               -- JSON array of permission keys
  ai           TEXT NOT NULL DEFAULT '{}',  -- JSON {key: allow|ask|deny}
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_migrations (version) VALUES ('0012_access_cache');
COMMIT;
