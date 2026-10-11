-- ============================================================
-- Collab piece 2 stage B2: a team project this laptop left (spec P11).
-- Migration: 0010_project_left
--
-- left_at NULL = not left. Set by markProjectLeft (stage D's leave calls it):
-- the project's notes stay on this laptop, read-only and marked "left team",
-- and are never sent or numbered again. projects is local (never a CRR), so
-- this is a plain ALTER and is not in CRR_ALTERS.
-- ============================================================
BEGIN;
ALTER TABLE projects ADD COLUMN left_at TEXT;
INSERT INTO schema_migrations (version) VALUES ('0010_project_left');
COMMIT;
