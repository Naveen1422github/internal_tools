// Fails the mcp test run when a dist the tests spawn is older than its source.
// project-tools.test.ts spawns mcp/dist/server.js, which imports core's dist,
// so a stale build in either package tests old code without saying so.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Newest mtime of any .ts file under dir (0 if none). */
function newestTs(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestTs(p));
    else if (e.name.endsWith(".ts")) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const checks = [
  { pkg: "mcp", dist: join(root, "mcp", "dist", "server.js"), src: join(root, "mcp", "src") },
  { pkg: "core", dist: join(root, "core", "dist", "index.js"), src: join(root, "core", "src") },
];

const stale = [];
for (const c of checks) {
  if (!existsSync(c.dist)) stale.push(`${c.pkg}: ${c.dist} is missing`);
  else if (statSync(c.dist).mtimeMs < newestTs(c.src)) stale.push(`${c.pkg}: dist is older than src`);
}

if (stale.length) {
  console.error(`[check-dist] stale build:\n  ${stale.join("\n  ")}\nRebuild first: npm run build (from internal-tools/).`);
  process.exit(1);
}
