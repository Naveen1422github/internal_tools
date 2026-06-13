-- 0002_fix_modules_slug_check.sql
-- Fixes broken CHECK constraint on modules.slug.
-- Original used `slug NOT LIKE '%_%'` which is always FALSE for non-empty
-- strings because '_' is the LIKE single-char wildcard. Result: every
-- INSERT into modules (and every INSERT OR IGNORE from collab_module_init)
-- silently failed. Replace with INSTR(slug, '_') = 0 for unambiguous
-- "contains no literal underscore" semantics.
--
-- Safe to run because the modules table is empty as a side effect of the bug.
-- Standard SQLite recreate-and-rename pattern (CHECK constraints can't be
-- altered in place).

BEGIN;

DROP TRIGGER IF EXISTS trg_modules_updated_at;

CREATE TABLE modules_new (
  slug           TEXT PRIMARY KEY
                 CHECK (slug GLOB '[a-z0-9]*'
                        AND INSTR(slug, '_') = 0
                        AND length(slug) <= 60),
  name           TEXT,
  summary        TEXT,
  description    TEXT,
  current_goal   TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','stable','deprecated')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO modules_new SELECT * FROM modules;
DROP TABLE modules;
ALTER TABLE modules_new RENAME TO modules;

CREATE TRIGGER trg_modules_updated_at
AFTER UPDATE ON modules
FOR EACH ROW
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END;

INSERT INTO schema_migrations (version) VALUES ('0002_fix_modules_slug_check');

COMMIT;