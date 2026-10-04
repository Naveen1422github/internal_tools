-- ============================================================
-- Collab — sync v1 preparation (spec 2026-10-04, plan 1)
-- Migration: 0007_sync_prep
--
-- Additive only. entries.needs_merge: set by the post office when two edits
-- of one entry cannot be merged (spec D8). sync_state: LOCAL-ONLY key/value
-- (never a CRR) holding this machine's sharing settings.
-- entry_revisions.merged_from + the revision trigger dropped: from 0007 edits
-- record their revision in code (core/src/revisions.ts, sync plan 2).
-- ============================================================
BEGIN;

ALTER TABLE entries ADD COLUMN needs_merge INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Edits record their revision in code (core/src/revisions.ts), not by trigger:
-- the trigger also fired when cr-sqlite applied a REMOTE edit, minting rows
-- that exist on one machine only. merged_from: comma-separated rev_ids a
-- merge (post office) or a person's resolution folded in (spec D8).
ALTER TABLE entry_revisions ADD COLUMN merged_from TEXT;
DROP TRIGGER IF EXISTS trg_entries_revision;

INSERT INTO schema_migrations (version) VALUES ('0007_sync_prep');

COMMIT;
