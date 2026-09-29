import { getDb, closeDb } from '@collab-mcp/core';

// Read-only inspection. getDb() resolves COLLAB_DB_PATH and refuses to create a
// missing DB (D9), so this can never conjure an empty ./collab.db.
const db = getDb();

try {
  const modules = db.prepare('SELECT * FROM modules').all();
  console.log('Modules:', modules);

  const entriesCount = db.prepare('SELECT category, count(*) as count FROM entries GROUP BY category').all();
  console.log('Entries Count:', entriesCount);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  closeDb();
}
