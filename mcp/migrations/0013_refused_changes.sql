-- ============================================================
-- Collab RnR stage S2: local refused changes.
-- Migration: 0013_refused_changes
--
-- A change the post office refused (R6, rule 5: nothing a user typed is lost
-- silently). refused_changes is LOCAL, like access_cache (0012): never a CRR,
-- not in SYNCED_TABLES or CRR_ALTERS. cells = WireChange[] JSON.
-- ============================================================
BEGIN;
CREATE TABLE IF NOT EXISTS refused_changes (
  ulid         TEXT PRIMARY KEY,
  note_ulid    TEXT,
  project_ulid TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('new','edit')),
  key          TEXT,                        -- the permission key that was missing
  reason       TEXT NOT NULL,
  cells        TEXT NOT NULL,               -- JSON WireChange[]
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS refused_new_once ON refused_changes (note_ulid) WHERE kind = 'new';
INSERT INTO schema_migrations (version) VALUES ('0013_refused_changes');
COMMIT;
