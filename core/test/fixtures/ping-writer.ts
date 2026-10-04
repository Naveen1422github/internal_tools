// A short-lived "script": opens a shared DB the way every tool does (getDb),
// writes one row, closes, and lets the process end on its own.
import { getDb, closeDb } from '../../src/db.js';

const db = getDb(process.argv[2]);
db.exec(`INSERT INTO modules (slug, name) VALUES ('from-script', 'written by a child process')`);
closeDb();
