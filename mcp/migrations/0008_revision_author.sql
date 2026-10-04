-- ============================================================
-- Collab — who wrote each version (web UI part 2, decision V6)
-- Migration: 0008_revision_author
--
-- entry_revisions is a cr-sqlite CRR on a shared notebook. core/src/db.ts runs
-- this file inside one transaction between crsql_begin_alter and
-- crsql_commit_alter when the table is a CRR (and plainly when it is not), so
-- this file has no BEGIN/COMMIT of its own.
-- ============================================================
ALTER TABLE entry_revisions ADD COLUMN author TEXT;

INSERT INTO schema_migrations (version) VALUES ('0008_revision_author');
