const { getDb } = require('./core/db.cjs');
const db = getDb();
try {
  const result = db.prepare(`
    INSERT INTO entries (type, kind, category, title, summary, agent, module, deprecated)
    VALUES ('session-note', 'log', 'Activity', 'Phase 3 Start', 'Phase 3 server ESM-TS — starting', 'Gemini', 'workspace-redesign', 0)
  `).run();
  const id = result.lastInsertRowid;
  db.prepare(`
    INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary)
    VALUES (?, 'workspace-redesign', 1)
  `).run(id);
  console.log('Successfully logged starting session-note, entry ID:', id);
} catch (err) {
  console.error('Failed to log session start:', err);
  process.exit(1);
}
