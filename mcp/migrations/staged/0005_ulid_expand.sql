-- ============================================================
-- Collab — team-sync schema, EXPAND phase (E-674, E-646, E-648, E-651, E-657)
-- Migration: 0005_ulid_expand
--
-- Additive only. The integer id stays the working key; every existing read and
-- write keeps working. 0006 (contract) makes ulid the PK and drops the old keys.
--
-- Who fills what:
--   entries.ulid            -> JS at insert (core) + startup backfill (stragglers)
--   refs/entry_modules keys -> triggers below (connection-independent)
--   superseded_by_ulid      -> trigger below
--   entry_revisions         -> trigger below
-- No UNIQUE indexes: cr-sqlite forbids them besides the PK (E-646).
-- ============================================================

BEGIN;

ALTER TABLE entries ADD COLUMN ulid TEXT;                -- permanent identity; PK in 0006
ALTER TABLE entries ADD COLUMN author TEXT;              -- machine owner (D2); not the agent
ALTER TABLE entries ADD COLUMN superseded_by_ulid TEXT;  -- ULID twin of superseded_by
CREATE INDEX IF NOT EXISTS idx_entries_ulid ON entries(ulid);

ALTER TABLE refs ADD COLUMN entry_ulid TEXT;   -- the owning entry
ALTER TABLE refs ADD COLUMN target_ulid TEXT;  -- ref_type='entry' only: the entry pointed at
CREATE INDEX IF NOT EXISTS idx_refs_entry_ulid  ON refs(entry_ulid);
CREATE INDEX IF NOT EXISTS idx_refs_target_ulid ON refs(target_ulid);

ALTER TABLE entry_modules ADD COLUMN entry_ulid TEXT;
CREATE INDEX IF NOT EXISTS idx_entry_modules_entry_ulid ON entry_modules(entry_ulid);

ALTER TABLE modules ADD COLUMN hub TEXT;  -- ULID of the module's hub entry (E-657)

-- ------------------------------------------------------------
-- updated_at means "content last changed" (decision D6). The old trigger fired
-- on ANY update, so backfilling ulid/author would stamp all history with the
-- migration time. Re-create it to watch content columns only; the new
-- bookkeeping columns (ulid, author, superseded_by_ulid) never bump it.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_entries_updated_at;
CREATE TRIGGER trg_entries_updated_at
AFTER UPDATE OF type, kind, title, summary, description, status, agent, module,
                task_id, tokens_estimate, rollup_of_task, deprecated, category, superseded_by
ON entries
FOR EACH ROW
BEGIN
  UPDATE entries SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ------------------------------------------------------------
-- Edit history for three-way merge (E-651, decision D5).
-- rev_id is random, not a per-entry counter: two machines editing at once
-- must never mint the same revision key.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_revisions (
  rev_id        TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entry_ulid    TEXT NOT NULL DEFAULT '',
  parent_rev_id TEXT,
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_entry_revisions_entry ON entry_revisions(entry_ulid, created_at);

-- ------------------------------------------------------------
-- Fill triggers. The legacy link parser here MUST match parseEntryRef()
-- in core/src/ulid.ts: "214", "E-214", "E-00214", "E214", "#116", any case,
-- trimmed. A parity test enforces it.
-- ------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_refs_fill_ulids
AFTER INSERT ON refs
BEGIN
  UPDATE refs SET
    entry_ulid = COALESCE(NEW.entry_ulid, (SELECT ulid FROM entries WHERE id = NEW.entry_id)),
    target_ulid = CASE WHEN NEW.ref_type <> 'entry' THEN NULL ELSE COALESCE(NEW.target_ulid, (
      SELECT e.ulid FROM entries e WHERE e.id = (
        SELECT CAST(d AS INTEGER) FROM (
          SELECT CASE
            WHEN s GLOB '#[0-9]*'  THEN substr(s, 2)
            WHEN s GLOB 'E-[0-9]*' THEN substr(s, 3)
            WHEN s GLOB 'E[0-9]*'  THEN substr(s, 2)
            ELSE s
          END AS d
          FROM (SELECT upper(trim(NEW.ref_value)) AS s)
        )
        WHERE d <> '' AND d NOT GLOB '*[^0-9]*' AND CAST(d AS INTEGER) > 0
      )
    )) END
  WHERE entry_id = NEW.entry_id AND ref_type = NEW.ref_type AND ref_value = NEW.ref_value;
END;

CREATE TRIGGER IF NOT EXISTS trg_entry_modules_fill_ulid
AFTER INSERT ON entry_modules
WHEN NEW.entry_ulid IS NULL
BEGIN
  UPDATE entry_modules SET entry_ulid = (SELECT ulid FROM entries WHERE id = NEW.entry_id)
  WHERE entry_id = NEW.entry_id AND module = NEW.module;
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fill_superseded_ulid
AFTER UPDATE OF superseded_by ON entries
BEGIN
  UPDATE entries
     SET superseded_by_ulid = (SELECT ulid FROM entries WHERE id = NEW.superseded_by)
   WHERE id = NEW.id;
END;

-- First real edit records the pre-edit text as the root (the merge base),
-- then every real edit appends a child of the latest revision.
-- `IS NOT` treats NULL = NULL, so a full-row rewrite with identical text is a no-op.
CREATE TRIGGER IF NOT EXISTS trg_entries_revision
AFTER UPDATE OF title, summary, description ON entries
WHEN NEW.ulid IS NOT NULL
 AND (OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.description IS NOT NEW.description)
BEGIN
  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description, created_at)
  SELECT NEW.ulid, NULL, OLD.title, OLD.summary, OLD.description, OLD.created_at
   WHERE NOT EXISTS (SELECT 1 FROM entry_revisions WHERE entry_ulid = NEW.ulid);

  INSERT INTO entry_revisions (entry_ulid, parent_rev_id, title, summary, description)
  VALUES (
    NEW.ulid,
    (SELECT rev_id FROM entry_revisions WHERE entry_ulid = NEW.ulid ORDER BY created_at DESC, rowid DESC LIMIT 1),
    NEW.title, NEW.summary, NEW.description
  );
END;

INSERT INTO schema_migrations (version) VALUES ('0005_ulid_expand');

COMMIT;

-- Verify after apply:
--   SELECT COUNT(*) FROM entries WHERE ulid IS NULL;                        -- expect 0 (after backfill)
--   SELECT COUNT(*) FROM refs WHERE entry_ulid IS NULL;                     -- expect 0
--   SELECT COUNT(*) FROM refs WHERE ref_type='entry' AND target_ulid IS NULL; -- = unresolved list
