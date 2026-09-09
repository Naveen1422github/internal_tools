import Database from 'better-sqlite3';
import path from 'path';

const [type, title, summary, description, moduleName, category, status] = process.argv.slice(2);

if (!type || !title || !summary) {
  console.error("Usage: tsx log-collab.ts <type> <title> <summary> [description] [moduleName] [category] [status]");
  process.exit(1);
}

const dbPath = path.resolve('collab.db');
const db = new Database(dbPath);

try {
  const kind = (type === 'gotcha' || type === 'decision' || type === 'proposal' || type === 'changelog') ? 'signal' : 'log';
  const finalCategory = category || (type === 'gotcha' || type === 'decision' ? 'Reference' : 'Activity');
  const tokensEstimate = description ? Math.ceil(description.length / 4) : 0;
  
  const insertStmt = db.prepare(`
    INSERT INTO entries (type, kind, title, summary, description, status, agent, module, category, tokens_estimate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const info = insertStmt.run(
    type,
    kind,
    title,
    summary,
    description || null,
    status || 'active',
    'Gemini',
    moduleName || null,
    finalCategory,
    tokensEstimate
  );
  
  const entryId = info.lastInsertRowid;
  console.log(`Inserted entry E-${entryId}`);
  
  if (moduleName) {
    // Ensure module exists or insert a placeholder
    const modExists = db.prepare('SELECT 1 FROM modules WHERE slug = ?').get(moduleName);
    if (!modExists) {
      db.prepare('INSERT INTO modules (slug, name, status) VALUES (?, ?, ?)')
        .run(moduleName, moduleName, 'active');
      console.log(`Created placeholder module: ${moduleName}`);
    }
    
    db.prepare('INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, 1)')
      .run(entryId, moduleName);
  }
} catch (e) {
  console.error('Error logging to DB:', e);
  process.exit(1);
} finally {
  db.close();
}
