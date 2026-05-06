#!/usr/bin/env node
/**
 * Standalone migration runner.
 *   npm run migrate
 * or
 *   npx tsx src/migrate.ts
 */
import { getDb, migrate, closeDb } from "./db.js";

const db = getDb();
const applied = migrate(db);

if (applied.length === 0) {
  console.log("[collab-migrate] no new migrations to apply");
} else {
  console.log(`[collab-migrate] applied: ${applied.join(", ")}`);
}

closeDb();
