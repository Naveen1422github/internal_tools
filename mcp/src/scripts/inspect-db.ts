import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('collab.db');
const db = new Database(dbPath);

try {
  const modules = db.prepare('SELECT * FROM modules').all();
  console.log('Modules:', modules);
  
  const entriesCount = db.prepare('SELECT category, count(*) as count FROM entries GROUP BY category').all();
  console.log('Entries Count:', entriesCount);
} catch (e) {
  console.error(e);
} finally {
  db.close();
}
