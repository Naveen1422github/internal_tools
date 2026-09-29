-- ============================================================
-- Collab — team-sync schema, CONTRACT phase (E-687, E-685, E-674, E-648, E-651)
-- Migration: 0006_ulid_contract
--
-- Rebuilds entries / refs / entry_modules / tasks / modules so every table
-- that will sync has a NOT NULL primary key and a DEFAULT on every other
-- NOT NULL column (cr-sqlite rules; verified with crsql_as_crr in the
-- 2026-09-29 spike and re-checked by mcp/src/scripts/rehearse-0006.ts).
--
--   entries.ulid          -> PRIMARY KEY (was: id INTEGER PK AUTOINCREMENT)
--   entries.id            -> E-number LABEL: nullable, NOT unique (E-648)
--   entries.deleted_at    -> tombstone; the app never hard-deletes after 0006
--   refs PK               -> (entry_ulid, ref_type, ref_value)       (E-651)
--   entry_modules PK      -> (entry_ulid, module)
--   refs/entry_modules.entry_id -> write-only legacy label, never read
--   entries_fts           -> keeps its OWN copy of the text, keyed by ulid
--   local_counters        -> local E-number allocator (never synced)
--
-- dispatches is NOT rebuilt: it is local telemetry (token counts of this
-- machine's agent runs), it never syncs, and its INTEGER AUTOINCREMENT key is
-- what keeps sqlite_sequence alive.
--
-- The JS pre-flight (core/src/preflight-0006.ts) runs BEFORE this file and
-- guarantees: every entry has a valid, unique 26-char ulid; every refs /
-- entry_modules row has entry_ulid; tasks.id and modules.slug are non-NULL.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Seed the E-number counter FIRST. The 'entries' row of sqlite_sequence
--    disappears when the AUTOINCREMENT table is dropped below. max(seq, max(id))
--    so numbers that were used and then deleted are never handed out again.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_counters (
  name   TEXT    NOT NULL PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO local_counters (name, value)
SELECT 'entry_number', MAX(
  COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'entries'), 0),
  COALESCE((SELECT MAX(id) FROM entries), 0)
);

-- ------------------------------------------------------------
-- 1. Drop every trigger that names a table being rebuilt, and the external-
--    content FTS table (content='entries'). If any survives, ALTER TABLE ...
--    RENAME below fails with "error in trigger ...: no such table: main.entries".
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_entries_fts_ai;
DROP TRIGGER IF EXISTS trg_entries_fts_ad;
DROP TRIGGER IF EXISTS trg_entries_fts_au;
DROP TRIGGER IF EXISTS trg_entries_updated_at;
DROP TRIGGER IF EXISTS trg_entries_fill_superseded_ulid;
DROP TRIGGER IF EXISTS trg_entries_revision;
DROP TRIGGER IF EXISTS trg_refs_cascade_delete;
DROP TRIGGER IF EXISTS trg_refs_fill_ulids;
DROP TRIGGER IF EXISTS trg_entry_modules_cascade_delete;
DROP TRIGGER IF EXISTS trg_entry_modules_fill_ulid;
DROP TRIGGER IF EXISTS trg_tasks_updated_at;
DROP TRIGGER IF EXISTS trg_modules_updated_at;
DROP TABLE IF EXISTS entries_fts;

-- ------------------------------------------------------------
-- 2. entries (explicit column lists everywhere: 0005 appended columns, so
--    SELECT * would silently misalign)
-- ------------------------------------------------------------
CREATE TABLE entries_new (
  ulid               TEXT    NOT NULL PRIMARY KEY CHECK (length(ulid) = 26),
  id                 INTEGER,  -- E-number label (E-648): nullable, no UNIQUE
  type               TEXT    NOT NULL DEFAULT 'session-note'
                     CHECK (type IN ('handoff','review','proposal','counter','decision',
                                     'gotcha','rollup','session-note','changelog')),
  kind               TEXT    NOT NULL DEFAULT 'log' CHECK (kind IN ('signal','log')),
  title              TEXT    NOT NULL DEFAULT '',
  summary            TEXT    NOT NULL DEFAULT '' CHECK (length(summary) <= 200),
  description        TEXT,
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('draft','active','resolved','deprecated')),
  agent              TEXT    CHECK (agent IS NULL OR agent IN ('Claude','Codex','Gemini','User')),
  module             TEXT,
  task_id            TEXT,
  tokens_estimate    INTEGER NOT NULL DEFAULT 0,
  rollup_of_task     TEXT,
  deprecated         INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0,1)),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  category           TEXT    NOT NULL DEFAULT 'Activity'
                     CHECK (category IN ('Index','Reference','Activity')),
  superseded_by      INTEGER,
  author             TEXT,
  superseded_by_ulid TEXT,
  deleted_at         TEXT,
  CHECK (type != 'rollup' OR rollup_of_task IS NOT NULL)
);
INSERT INTO entries_new (
  ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category,
  superseded_by, author, superseded_by_ulid, deleted_at
)
SELECT
  ulid, id, type, kind, title, summary, description, status, agent, module, task_id,
  tokens_estimate, rollup_of_task, deprecated, created_at, updated_at, category,
  superseded_by, author, superseded_by_ulid, NULL
FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX idx_entries_id         ON entries(id);
CREATE INDEX idx_entries_type       ON entries(type);
CREATE INDEX idx_entries_module     ON entries(module);
CREATE INDEX idx_entries_task       ON entries(task_id);
CREATE INDEX idx_entries_created    ON entries(created_at);
CREATE INDEX idx_entries_kind       ON entries(kind);
CREATE INDEX idx_entries_status     ON entries(status);
CREATE INDEX idx_entries_deprecated ON entries(deprecated);
CREATE INDEX idx_entries_category   ON entries(category);
CREATE INDEX idx_entries_superseded ON entries(superseded_by);

-- ------------------------------------------------------------
-- 3. refs: PK moves to entry_ulid (E-651). entry_id stays as a write-only label.
-- ------------------------------------------------------------
CREATE TABLE refs_new (
  entry_ulid   TEXT    NOT NULL,
  ref_type     TEXT    NOT NULL DEFAULT 'file' CHECK (ref_type IN ('file','task','entry','url')),
  ref_value    TEXT    NOT NULL DEFAULT '',
  entry_id     INTEGER,
  target_ulid  TEXT,
  PRIMARY KEY (entry_ulid, ref_type, ref_value)
);
INSERT INTO refs_new (entry_ulid, ref_type, ref_value, entry_id, target_ulid)
SELECT entry_ulid, ref_type, ref_value, entry_id, target_ulid FROM refs;
DROP TABLE refs;
ALTER TABLE refs_new RENAME TO refs;

CREATE INDEX idx_refs_value       ON refs(ref_value);
CREATE INDEX idx_refs_type        ON refs(ref_type);
CREATE INDEX idx_refs_target_ulid ON refs(target_ulid);

-- ------------------------------------------------------------
-- 4. entry_modules
-- ------------------------------------------------------------
CREATE TABLE entry_modules_new (
  entry_ulid  TEXT    NOT NULL,
  module      TEXT    NOT NULL DEFAULT '',
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  entry_id    INTEGER,
  PRIMARY KEY (entry_ulid, module)
);
INSERT INTO entry_modules_new (entry_ulid, module, is_primary, entry_id)
SELECT entry_ulid, module, is_primary, entry_id FROM entry_modules;
DROP TABLE entry_modules;
ALTER TABLE entry_modules_new RENAME TO entry_modules;

CREATE INDEX idx_entry_modules_module ON entry_modules(module);

-- ------------------------------------------------------------
-- 5. tasks: NOT NULL PK + DEFAULT on title.
-- ------------------------------------------------------------
CREATE TABLE tasks_new (
  id           TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  summary      TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','assigned','in-progress','review','done')),
  assignee     TEXT CHECK (assignee IS NULL OR assignee IN ('Claude','Codex','Gemini','User')),
  priority     TEXT CHECK (priority IS NULL OR priority IN ('critical','high','medium','low')),
  module       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tasks_new (id, title, summary, description, status, assignee, priority, module, created_at, updated_at)
SELECT id, title, summary, description, status, assignee, priority, module, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_status   ON tasks(status);
CREATE INDEX idx_tasks_module   ON tasks(module);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);

-- ------------------------------------------------------------
-- 6. modules: NOT NULL PK. The slug CHECK is 0002's (INSTR), NOT 0001's
--    broken LIKE '%_%' (where _ is a wildcard). Keeps 0005's hub column.
-- ------------------------------------------------------------
CREATE TABLE modules_new (
  slug          TEXT NOT NULL PRIMARY KEY
                CHECK (slug GLOB '[a-z0-9]*' AND INSTR(slug, '_') = 0 AND length(slug) <= 60),
  name          TEXT,
  summary       TEXT,
  description   TEXT,
  current_goal  TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stable','deprecated')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  hub           TEXT
);
INSERT INTO modules_new (slug, name, summary, description, current_goal, status, created_at, updated_at, hub)
SELECT slug, name, summary, description, current_goal, status, created_at, updated_at, hub FROM modules;
DROP TABLE modules;
ALTER TABLE modules_new RENAME TO modules;

-- ------------------------------------------------------------
-- 7. FTS with its own copy of the text, keyed by ulid. Local only, never
--    synced. Deletes scan by the UNINDEXED ulid column; the 10k-row timing
--    test in migrate-0006.test.ts holds this to the E-674 budget.
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE entries_fts USING fts5(
  ulid UNINDEXED,
  title,
  summary,
  description,
  tokenize = 'porter unicode61'
);
INSERT INTO entries_fts (ulid, title, summary, description)
SELECT ulid, title, summary, description FROM entries;

-- ------------------------------------------------------------
-- 8. Triggers. Creation order matters: SQLite fires the NEWEST same-event
--    trigger first (E-684). Safe here because trg_entries_fts_au watches only
--    the three FTS columns, so the bookkeeping UPDATEs below never reach it.
-- ------------------------------------------------------------
CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category,
                superseded_by, deleted_at
ON entries
FOR EACH ROW
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE ulid = OLD.ulid;
END;

CREATE TRIGGER trg_entries_fts_ai
AFTER INSERT ON entries
BEGIN
  INSERT INTO entries_fts (ulid, title, summary, description)
  VALUES (new.ulid, new.title, new.summary, new.description);
END;

CREATE TRIGGER trg_entries_fts_ad
AFTER DELETE ON entries
BEGIN
  DELETE FROM entries_fts WHERE ulid = old.ulid;
END;

CREATE TRIGGER trg_entries_fts_au
AFTER UPDATE OF title, summary, description ON entries
BEGIN
  DELETE FROM entries_fts WHERE ulid = old.ulid;
  INSERT INTO entries_fts (ulid, title, summary, description)
  VALUES (new.ulid, new.title, new.summary, new.description);
END;

-- The ulid is the identity everything else hangs off (refs, modules, FTS,
-- revisions, sync). Changing it would orphan all of them silently.
CREATE TRIGGER trg_entries_ulid_immutable
BEFORE UPDATE OF ulid ON entries
WHEN NEW.ulid IS NOT OLD.ulid
BEGIN
  SELECT RAISE(ABORT, 'entries.ulid is immutable');
END;

-- Writers set superseded_by_ulid themselves. This only repairs a legacy
-- writer that changed the integer superseded_by but not its ULID twin.
CREATE TRIGGER trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
WHEN NEW.superseded_by IS NOT OLD.superseded_by
 AND NEW.superseded_by_ulid IS OLD.superseded_by_ulid
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT e.ulid FROM entries e WHERE e.id = NEW.superseded_by ORDER BY e.ulid LIMIT 1)
   WHERE ulid = NEW.ulid;
END;

-- Unchanged from 0005 (already keyed on ulid).
CREATE TRIGGER trg_entries_revision
AFTER UPDATE OF title, summary, description ON entries
WHEN NEW.ulid IS NOT NULL
 AND (OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.description IS NOT NEW.description)
BEGIN
  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description, created_at)
  SELECT NEW.ulid, NULL, OLD.title, OLD.summary, OLD.description, OLD.updated_at
   WHERE NOT EXISTS (SELECT 1 FROM entry_revisions WHERE entry_ulid = NEW.ulid);

  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description)
  VALUES (
    NEW.ulid,
    (SELECT rev_id FROM entry_revisions WHERE entry_ulid = NEW.ulid ORDER BY created_at DESC, rowid DESC LIMIT 1),
    NEW.title, NEW.summary, NEW.description
  );
END;

-- Resolves a legacy link value ("214", "E-214", "#116", ...) to the target's
-- ulid. The parser MUST match parseEntryRef() in core/src/ulid.ts (same
-- explicit whitespace set; the 0005 parity test guards it).
-- id is no longer unique, so pick deterministically (lowest ulid).
CREATE TRIGGER trg_refs_fill_target_ulid
AFTER INSERT ON refs
WHEN NEW.ref_type = 'entry' AND NEW.target_ulid IS NULL
BEGIN
  UPDATE refs SET target_ulid = (
    SELECT e.ulid FROM entries e WHERE e.id = (
      SELECT CAST(d AS INTEGER) FROM (
        SELECT CASE
          WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
          WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
          WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
          ELSE s
        END AS d
        FROM (SELECT upper(trim(NEW.ref_value, ' ' || char(9,10,11,12,13,160))) AS s)
      )
      WHERE d <> '' AND d NOT GLOB '*[^0-9]*' AND CAST(d AS INTEGER) > 0
    )
    ORDER BY e.ulid LIMIT 1
  )
  WHERE entry_ulid = NEW.entry_ulid AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END;

-- Hard deletes still happen (a synced delete, a script). Cascade by ulid.
CREATE TRIGGER trg_refs_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM refs WHERE entry_ulid = old.ulid;
END;

CREATE TRIGGER trg_entry_modules_cascade_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM entry_modules WHERE entry_ulid = old.ulid;
END;

CREATE TRIGGER trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
BEGIN
  UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_modules_updated_at
AFTER UPDATE ON modules
FOR EACH ROW
BEGIN
  UPDATE modules SET updated_at = datetime('now') WHERE slug = OLD.slug;
END;

INSERT INTO schema_migrations (version) VALUES ('0006_ulid_contract');

COMMIT;
