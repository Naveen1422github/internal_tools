// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

function formatEnvelope(task, opts = {}) {
  let env = [];

  // Task basic info
  env.push(`# Task @${task.id} — ${task.title}`);
  env.push('');
  env.push(`**Module:** @${task.module || 'none'}`);
  env.push(`**Status:** ${task.status || 'unknown'}  ·  **Priority:** ${task.priority || 'medium'}  ·  **Assignee:** ${task.assignee || 'none'}`);
  env.push('');

  // Summary
  if (task.summary) {
    env.push('## Summary');
    env.push(task.summary);
    env.push('');
  }

  // Description/Context
  if (task.description) {
    env.push('## Context');
    env.push(task.description);
    env.push('');
  }

  // If there's an active DB we can fetch recent entries to enrich
  let db = null;
  try {
    const dbPath = path.resolve(__dirname, '..', '..', 'collab-mcp', 'collab.db');
    if (fs.existsSync(dbPath)) {
      db = new Database(dbPath, { readonly: true });

      // Recent activity (entries related to this task or module)
      let recentActivity = [];
      if (task.module) {
        recentActivity = db.prepare(`
          SELECT created_at, agent, type, title, module
          FROM entries
          WHERE (module = ? OR task_id = ?) AND deprecated = 0
          ORDER BY created_at DESC
          LIMIT 5
        `).all(task.module, task.id);
      } else if (task.id) {
        recentActivity = db.prepare(`
          SELECT created_at, agent, type, title, module
          FROM entries
          WHERE task_id = ? AND deprecated = 0
          ORDER BY created_at DESC
          LIMIT 5
        `).all(task.id);
      }

      if (recentActivity.length > 0) {
        env.push('## Recent activity');
        for (const act of recentActivity.reverse()) { // oldest to newest
          const time = new Date(act.created_at).toTimeString().substring(0, 5);
          env.push(`- ${time}  ${act.agent || 'Unknown'}  ${act.type}: ${act.title}`);
        }
        env.push('');
      }

      // Linked entries
      if (task.id) {
        const linkedEntries = db.prepare(`
          SELECT rowid as id, type, title
          FROM entries
          WHERE task_id = ? AND deprecated = 0
          ORDER BY created_at DESC
          LIMIT 5
        `).all(task.id);

        if (linkedEntries.length > 0) {
          env.push('## Linked entries');
          for (const entry of linkedEntries) {
            env.push(`- E-${String(entry.id).padStart(5, '0')} (${entry.type}) — ${entry.title}`);
          }
          env.push('');
        }
      }
    }
  } catch (err) {
    console.error(`[envelope] failed to read db: ${err.message}`);
  } finally {
    if (db) db.close();
  }

  env.push('—— READY ——');

  return env.join('\n');
}

module.exports = { formatEnvelope };
