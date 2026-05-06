#!/usr/bin/env node
import { getDb } from "../db.js";

function readArgValue(args: string[], name: string): string | null {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return null;
}

const since = readArgValue(process.argv.slice(2), "--since");
if (!since) {
  console.error("Usage: check-handoff-needed --since <ISO timestamp>");
  process.exit(2);
}

const dbPath = process.env.COLLAB_DB ?? process.env.COLLAB_DB_PATH;
const db = dbPath ? getDb(dbPath) : getDb();

const row = db
  .prepare("SELECT 1 AS ok FROM entries WHERE type = 'handoff' AND created_at >= ? LIMIT 1")
  .get(since) as { ok: 1 } | undefined;

process.exit(row ? 0 : 1);

