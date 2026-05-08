// consumed by tools/console.js spawn(); see briefs/T3-agent-adapters.md
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function pushSection(lines, heading, value) {
  if (!value) return;
  lines.push(`## ${heading}`, String(value), '');
}

function formatEnvelope(task, opts = {}) {
  const lines = [
    `# Task @${task.id} - ${task.title}`,
    '',
    `**Module:** @${task.module || 'none'}`,
    `**Status:** ${task.status || 'unknown'}  ·  **Priority:** ${task.priority || 'medium'}  ·  **Assignee:** ${task.assignee || 'none'}`,
    '',
  ];

  pushSection(lines, 'Summary', task.summary);
  pushSection(lines, 'Context', task.description || task.body);

  let db;
  try {
    const dbPath = opts.dbPath || path.resolve(__dirname, '..', '..', 'collab-mcp', 'collab.db');
    if (fs.existsSync(dbPath)) {
      db = new Database(dbPath, { readonly: true });
      const recent = db.prepare(`
        SELECT rowid AS id, created_at, agent, type, title
        FROM entries
        WHERE deprecated = 0 AND (task_id = @taskId OR module = @module)
        ORDER BY created_at DESC
        LIMIT 5
      `).all({ taskId: task.id || null, module: task.module || null });

      if (recent.length > 0) {
        lines.push('## Recent activity');
        for (const entry of recent.reverse()) {
          const time = String(entry.created_at || '').slice(11, 16) || '--:--';
          lines.push(`- ${time}  ${entry.agent || 'Unknown'}  ${entry.type}: ${entry.title}`);
        }
        lines.push('');
      }

      if (task.id) {
        const linked = db.prepare(`
          SELECT rowid AS id, type, title
          FROM entries
          WHERE deprecated = 0 AND task_id = ?
          ORDER BY created_at DESC
          LIMIT 5
        `).all(task.id);

        if (linked.length > 0) {
          lines.push('## Linked entries');
          for (const entry of linked) {
            lines.push(`- E-${String(entry.id).padStart(5, '0')} (${entry.type}) - ${entry.title}`);
          }
          lines.push('');
        }
      }
    }
  } catch {
    // Envelope enrichment is best-effort; the base task context is still valid.
  } finally {
    if (db) db.close();
  }

  lines.push('-- READY --');
  return lines.join('\n').slice(0, 4096);
}

module.exports = { formatEnvelope };
