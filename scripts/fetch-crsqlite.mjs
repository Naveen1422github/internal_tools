#!/usr/bin/env node
// Downloads and verifies the pinned cr-sqlite add-on (addon-manifest.json).
// Needs core built first: npm -w @collab-mcp/core run build
import { installAddon } from '../core/dist/addon.js';
const r = await installAddon();
if (r.state !== 'ok') { console.error(`cr-sqlite: ${r.state}${'key' in r ? ' (' + r.key + ')' : ''}${'path' in r ? ' ' + r.path : ''}`); process.exit(1); }
console.log(`cr-sqlite ${r.version} -> ${r.path} (verified)`);
