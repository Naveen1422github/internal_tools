#!/usr/bin/env node
// Writes build-info.json at the install root: { version, build, builtAt }.
// build = first 12 hex of sha256 over every file in the workspaces' dist folders
// (sorted path + content), so a rebuild of changed code gets a new identity even
// when no version was bumped (spec P9). Usage: node scripts/write-build-info.mjs [root]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not import.meta.dirname: that needs Node 20.11+, and the floor is 20.9.
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = ['core/dist', 'courier/dist', 'post-office/dist', 'mcp/dist', 'server/dist', 'cli/dist', 'ui/dist'];
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
for (const d of DIST) if (existsSync(join(root, d))) walk(join(root, d));
files.sort();
const h = createHash('sha256');
for (const f of files) { h.update(relative(root, f).replaceAll('\\', '/')); h.update('\0'); h.update(readFileSync(f)); }
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const info = { version, build: h.digest('hex').slice(0, 12), builtAt: new Date().toISOString() };
writeFileSync(join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${info.version} ${info.build}`);
