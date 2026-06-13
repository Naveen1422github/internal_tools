-- ============================================================
-- Collab v2 — dispatches updated_at
-- Migration: 0003_dispatches_updated_at
--
-- Purpose: Add updated_at to dispatches for better auditability.
-- ============================================================

BEGIN;

-- SQLite rejects ADD COLUMN with a non-constant default (e.g. datetime('now')),
-- so add the column nullable and backfill, then keep it current via triggers.
-- (CREATE TABLE allows non-constant defaults; ALTER TABLE ADD COLUMN does not.)
ALTER TABLE dispatches ADD COLUMN updated_at TEXT;

-- Backfill existing rows: a never-updated row's updated_at equals its created_at.
UPDATE dispatches SET updated_at = created_at WHERE updated_at IS NULL;

-- New rows: the insert path doesn't set updated_at, so seed it from created_at.
CREATE TRIGGER IF NOT EXISTS trg_dispatches_updated_at_insert
AFTER INSERT ON dispatches
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE dispatches SET updated_at = COALESCE(NEW.created_at, datetime('now')) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_dispatches_updated_at
AFTER UPDATE ON dispatches
FOR EACH ROW
BEGIN
  UPDATE dispatches SET updated_at = datetime('now') WHERE id = OLD.id;
END;

INSERT INTO schema_migrations (version) VALUES ('0003_dispatches_updated_at');

COMMIT;
