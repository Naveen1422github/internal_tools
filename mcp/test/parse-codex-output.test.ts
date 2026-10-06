// file: mcp/test/parse-codex-output.test.ts
// Stage B1: a dispatch follows its note by ULID (dispatches.entry_ulid), whatever its series.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, addEntry, createProject } from '@collab-mcp/core';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scripts', 'parse-codex-output.ts');
const TSX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

test('a saved Codex output in project SH (SH-3) writes that note\'s ulid into dispatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-codex-'));
  try {
    const dbPath = join(root, 'collab.db');
    const db = new Database(dbPath);
    migrate(db);
    const p = createProject(db, { name: 'supporthub', code: 'SH' });
    addEntry(db, { type: 'decision', title: 'one', summary: 's', project: 'SH' });
    addEntry(db, { type: 'decision', title: 'two', summary: 's', project: 'SH' });
    db.close();
    writeFileSync(join(root, '.collab'), `notebook = t\nproject = ${p.ulid}\n`);
    const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the parser and tests.' } }) + '\n';
    const env = { ...process.env, COLLAB_DATA_DIR: join(root, 'data') };
    delete env.COLLAB_DB_PATH; delete env.COLLAB_NOTEBOOK; delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [TSX, SCRIPT, '--save', '--db', dbPath, '--wall-ms', '5', '--agent', 'Codex'],
      { cwd: root, env, input: jsonl, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const check = new Database(dbPath, { readonly: true });
    try {
      const sh3 = check.prepare(`SELECT ulid FROM entries WHERE series = 'SH' AND id = 3`).get() as { ulid: string } | undefined;
      assert.ok(sh3, 'the note was saved as SH-3');
      const d = check.prepare(`SELECT entry_id, entry_ulid FROM dispatches`).get() as { entry_id: number; entry_ulid: string };
      assert.equal(d.entry_ulid, sh3!.ulid);
      assert.equal(d.entry_id, 3);
    } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
