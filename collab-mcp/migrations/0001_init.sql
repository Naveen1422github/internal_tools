-- ============================================================
-- Collab v2 — initial schema
-- Migration: 0001_init
-- See DESIGN.md §4, §5 for rationale
-- ============================================================

-- Expectation: caller has already set the following PRAGMAs once
-- on the connection (do them in JS, not in this migration file):
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;           -- (no hard FKs yet, future-proof)
--   PRAGMA synchronous = NORMAL;        -- WAL-friendly

BEGIN;

-- ------------------------------------------------------------
-- Migration bookkeeping
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- tasks — mutable state; replaces BOARD.md
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,         -- "T-001"
  title        TEXT NOT NULL,
  summary      TEXT,                     -- one-liner, <= 200 chars (enforced at app layer)
  description  TEXT,                     -- markdown body (Problem / Files / Constraints / ...)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','assigned','in-progress','review','done')),
  assignee     TEXT                      -- 'Claude' | 'Codex' | 'Gemini' | 'User' | NULL
               CHECK (assignee IS NULL OR assignee IN ('Claude','Codex','Gemini','User')),
  priority     TEXT                      -- critical | high | medium | low
               CHECK (priority IS NULL OR priority IN ('critical','high','medium','low')),
  module       TEXT,                     -- soft FK to modules.slug
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_module   ON tasks(module);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

-- Keep updated_at fresh on UPDATE
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
BEGIN
  UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ------------------------------------------------------------
-- entries — append-only (except status/deprecated which are mutable)
-- Types: handoff|review|proposal|counter|decision|gotcha|rollup|session-note|changelog
-- Kinds: signal (searched by default) | log (opt-in)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL
                   CHECK (type IN (
                     'handoff','review','proposal','counter','decision',
                     'gotcha','rollup','session-note','changelog'
                   )),
  kind             TEXT NOT NULL CHECK (kind IN ('signal','log')),
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft','active','resolved','deprecated')),
  agent            TEXT
                   CHECK (agent IS NULL OR agent IN ('Claude','Codex','Gemini','User')),
  module           TEXT,                 -- soft FK to modules.slug
  task_id          TEXT,                 -- soft FK to tasks.id
  tokens_estimate  INTEGER NOT NULL DEFAULT 0,
  rollup_of_task   TEXT,                 -- if type='rollup', the task whose entries this summarizes
  deprecated       INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- Enforce invariants
  CHECK (type != 'rollup' OR rollup_of_task IS NOT NULL),
  CHECK (length(summary) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_entries_type       ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_module     ON entries(module);
CREATE INDEX IF NOT EXISTS idx_entries_task       ON entries(task_id);
CREATE INDEX IF NOT EXISTS idx_entries_created    ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_kind       ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_status     ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_deprecated ON entries(deprecated);

CREATE TRIGGER IF NOT EXISTS trg_entries_updated_at
AFTER UPDATE ON entries
FOR EACH ROW
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ------------------------------------------------------------
-- entries_fts — FTS5 virtual table
-- content='entries' means storage-shared; no duplication.
-- Triggers below keep the FTS index in sync.
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title,
  summary,
  description,
  content='entries',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_ai
AFTER INSERT ON entries
BEGIN
  INSERT INTO entries_fts(rowid, title, summary, description)
  VALUES (new.id, new.title, new.summary, new.description);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_ad
AFTER DELETE ON entries
BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, description)
  VALUES ('delete', old.id, old.title, old.summary, old.description);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_au
AFTER UPDATE ON entries
BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, description)
  VALUES ('delete', old.id, old.title, old.summary, old.description);
  INSERT INTO entries_fts(rowid, title, summary, description)
  VALUES (new.id, new.title, new.summary, new.description);
END;

-- ------------------------------------------------------------
-- refs — many-to-many from entries to files/tasks/other entries/urls
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refs (
  entry_id    INTEGER NOT NULL,
  ref_type    TEXT NOT NULL CHECK (ref_type IN ('file','task','entry','url')),
  ref_value   TEXT NOT NULL,
  PRIMARY KEY (entry_id, ref_type, ref_value)
);

CREATE INDEX IF NOT EXISTS idx_refs_value    ON refs(ref_value);
CREATE INDEX IF NOT EXISTS idx_refs_entry    ON refs(entry_id);
CREATE INDEX IF NOT EXISTS idx_refs_type     ON refs(ref_type);

-- Cascade delete refs when their owning entry is deleted (rare path; mostly we soft-deprecate)
CREATE TRIGGER IF NOT EXISTS trg_refs_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM refs WHERE entry_id = old.id;
END;

-- ------------------------------------------------------------
-- modules — lazy-populated per-module context
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS modules (
  slug           TEXT PRIMARY KEY
                 CHECK (slug GLOB '[a-z0-9]*' AND slug NOT LIKE '%_%' AND length(slug) <= 60),
                 -- kebab-case-only; no underscores; max 60 chars
  name           TEXT,
  summary        TEXT,
  description    TEXT,
  current_goal   TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','stable','deprecated')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_modules_updated_at
AFTER UPDATE ON modules
FOR EACH ROW
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END;

-- ------------------------------------------------------------
-- Record this migration
-- ------------------------------------------------------------
INSERT INTO schema_migrations (version) VALUES ('0001_init');

COMMIT;

-- ============================================================
-- Sanity queries (copy/paste into sqlite3 shell to verify)
-- ============================================================
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- SELECT version, applied_at FROM schema_migrations;
-- INSERT INTO entries(type, kind, title, summary, description, agent)
--   VALUES('gotcha','signal','Test','Test gotcha','Body of test', 'Claude');
-- SELECT rowid, title FROM entries_fts WHERE entries_fts MATCH 'test';
