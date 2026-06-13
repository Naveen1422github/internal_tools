-- ============================================================
-- Collab v2 — dispatches table
-- Migration: 0002_dispatches
--
-- Purpose: capture per-dispatch token usage and wall-clock so we
-- can compute "tokens displaced from Claude's window" honestly.
--
-- Headline metric (B): net = output_tokens - prompt_tokens_est.
-- Also stored (A): output_tokens alone (overstates but quotable).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS dispatches (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id              INTEGER,
  agent                 TEXT NOT NULL CHECK (agent IN ('Codex','Gemini')),

  -- Claude side: cost of dispatching (the prompt Claude wrote + sent)
  prompt_chars          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens_est     INTEGER NOT NULL DEFAULT 0,

  -- Subagent side: from Codex JSONL token_count.total_token_usage (last event)
  input_tokens          INTEGER,
  cached_input_tokens   INTEGER,
  output_tokens         INTEGER,
  reasoning_tokens      INTEGER,
  total_tokens          INTEGER,

  wall_clock_ms         INTEGER NOT NULL DEFAULT 0,
  exit_code             INTEGER NOT NULL DEFAULT 0,

  module                TEXT,
  task_id               TEXT,
  source                TEXT,

  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispatches_agent    ON dispatches(agent);
CREATE INDEX IF NOT EXISTS idx_dispatches_module   ON dispatches(module);
CREATE INDEX IF NOT EXISTS idx_dispatches_created  ON dispatches(created_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_entry    ON dispatches(entry_id);

INSERT INTO schema_migrations (version) VALUES ('0002_dispatches');

COMMIT;
