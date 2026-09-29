// Seeds a fresh Collab DB with a few genuinely useful onboarding entries.
// Self-documenting: a friend's first `collab_search` surfaces real guidance.
//
//   COLLAB_DB_PATH=./collab.db node scripts/seed-starter.mjs
//
// Idempotent: re-running inserts nothing once `start-here` exists.
// NOTE: uses an EXPLICIT db path (defaults to ./collab.db in the cwd) so it can
// never accidentally write to core's package-relative default DB.
import { join } from 'node:path';
import { getDb, migrate, addEntry } from '@collab-mcp/core';

const dbPath = process.env.COLLAB_DB_PATH ?? join(process.cwd(), 'collab.db');
const db = getDb(dbPath, { create: true });
migrate(db);

const already = db.prepare("SELECT 1 FROM entries WHERE title = ? LIMIT 1").get('Start here');
if (already) {
  console.log('Starter entries already present — nothing to do.');
  process.exit(0);
}

const MODULE = 'getting-started';
const entries = [
  {
    type: 'session-note',
    category: 'Index',
    title: 'Start here',
    summary: 'How to use this knowledge base: search before you add; capture decisions, gotchas, and changelogs as you work.',
    description:
      'Collab MCP is a small, local, AI-shared knowledge base. The loop is simple:\n' +
      '1. SEARCH first (collab_search) before adding — avoid duplicates and re-deriving.\n' +
      '2. CAPTURE as you work: a `decision` when you choose an approach, a `gotcha` when something bites you, a `changelog` when you finish a unit of work.\n' +
      '3. Keep summaries short (<=200 chars). Put detail in the description.\n' +
      'Your AI assistant can read and write these entries through the MCP tools, so the next session (yours or a teammate\'s) starts with context instead of guesswork.',
  },
  {
    type: 'gotcha',
    category: 'Reference',
    title: 'Connecting your AI agent to Collab MCP',
    summary: 'Setup for Claude Code (.mcp.json), Codex (codex mcp add), and agy (mcp_config.json). Set COLLAB_DB_PATH per workspace.',
    description:
      'The server is standard MCP, so any MCP client works. Verified setups:\n\n' +
      'Claude Code — add to .mcp.json:\n' +
      '  "collab": { "command": "node", "args": ["<path>/mcp/dist/server.js"],\n' +
      '              "env": { "COLLAB_DB_PATH": "<workspace>/collab.db" }, "type": "stdio" }\n\n' +
      'Codex:\n' +
      '  codex mcp add collab --env COLLAB_DB_PATH=<workspace>/collab.db -- node <abs>/mcp/dist/server.js\n\n' +
      'agy (Antigravity CLI) — add to ~/.gemini/antigravity-cli/mcp_config.json:\n' +
      '  { "mcpServers": { "collab": { "command": "node", "args": ["<abs>/mcp/dist/server.js"],\n' +
      '                                "env": { "COLLAB_DB_PATH": "<workspace>/collab.db" } } } }\n\n' +
      'IMPORTANT: the default DB lives inside the package, so without COLLAB_DB_PATH every\n' +
      'workspace shares one DB. Set COLLAB_DB_PATH to a per-workspace file for isolation.',
  },
  {
    type: 'decision',
    category: 'Reference',
    title: 'Example decision: search before adding',
    summary: 'We search the knowledge base before adding an entry, so the same decision/gotcha is captured once, not many times.',
    description:
      'This is an example `decision` entry. Decisions record a choice and its reasoning so future-you (and your AI) do not re-litigate it. Try: `collab_search` for "search" to see how this surfaces.',
  },
  {
    type: 'gotcha',
    category: 'Reference',
    title: 'Example gotcha: summaries are capped at 200 characters',
    summary: 'addEntry rejects summaries over 200 chars. Keep the summary as a one-line hook; put the real content in the description.',
    description:
      'This is an example `gotcha` entry — a sharp edge worth remembering. Gotchas are the highest-value entries to capture because they save the most time when re-hit.',
  },
  {
    type: 'changelog',
    category: 'Activity',
    title: 'Example changelog: log when you finish a unit of work',
    summary: 'When you complete a task, log a changelog so the next session sees what shipped and why, without reading the diff.',
    description:
      'This is an example `changelog` entry. Changelogs are an activity log of completed work. Pair them with the `module` field so an entire feature\'s history is one filtered search away.',
  },
];

let n = 0;
for (const e of entries) {
  addEntry(db, { ...e, module: MODULE, agent: 'User' });
  n++;
}
console.log(`Seeded ${n} starter entries into ${dbPath}`);
