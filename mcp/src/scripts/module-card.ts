#!/usr/bin/env node
import { getDb } from "../db.js";
import { getModule } from "../tools/module.js";

function readArgValue(args: string[], name: string): string | null {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return null;
}

const slug = readArgValue(process.argv.slice(2), "--slug");
if (!slug) {
  console.error("Usage: module-card --slug <slug>");
  process.exit(2);
}

const dbPath = process.env.COLLAB_DB ?? process.env.COLLAB_DB_PATH;
const db = dbPath ? getDb(dbPath) : getDb();

const result = getModule(db, slug);
if (!result.module) process.exit(0);

const lines: string[] = [];
lines.push(
  `[module] ${result.module.slug}${
    result.module.name ? ` (${result.module.name})` : ""
  }`
);
if (result.module.current_goal) lines.push(`  goal: ${result.module.current_goal}`);
if (result.module.summary) lines.push(`  summary: ${result.module.summary}`);
if (result.active_tasks.length > 0) {
  lines.push("\nActive tasks:");
  for (const t of result.active_tasks) {
    lines.push(`  [${t.id}] ${t.status}${t.priority ? ` (${t.priority})` : ""} - ${t.title}`);
  }
}
if (result.top_gotchas.length > 0) {
  lines.push("\nTop gotchas:");
  for (const g of result.top_gotchas) {
    lines.push(`  [E-${String(g.id).padStart(5, "0")}] ${g.summary}`);
  }
}
if (result.recent_decisions.length > 0) {
  lines.push("\nRecent decisions:");
  for (const d of result.recent_decisions) {
    lines.push(`  [E-${String(d.id).padStart(5, "0")}] ${d.title}`);
  }
}
if (result.recent_handoffs.length > 0) {
  lines.push("\nRecent handoffs:");
  for (const h of result.recent_handoffs) {
    lines.push(`  [E-${String(h.id).padStart(5, "0")}] ${h.agent ?? "?"} - ${h.title}`);
  }
}

process.stdout.write(lines.join("\n"));

