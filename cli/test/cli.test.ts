import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDb, closeDb, migrate, readNotebookConfig } from '@collab-mcp/core';
import { main } from '../src/main.js';

// Every test runs against a temp data folder and a temp cwd: nothing here may
// read or write the real data folder or a real notebook.
async function withWorld(fn: (w: { root: string; data: string; run: (...argv: string[]) => Promise<{ code: number; out: string[]; err: string[] }> }) => Promise<void>, deps?: any) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-'));
  const data = join(root, 'data');
  const saved = { data: process.env.COLLAB_DATA_DIR, db: process.env.COLLAB_DB_PATH, nb: process.env.COLLAB_NOTEBOOK, cwd: process.cwd() };
  process.env.COLLAB_DATA_DIR = data;
  delete process.env.COLLAB_DB_PATH;
  delete process.env.COLLAB_NOTEBOOK;
  process.chdir(root);
  const run = async (...argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const r = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
    return { code: r.code, out, err };
  };
  try { await fn({ root, data, run }); } finally {
    closeDb();
    process.chdir(saved.cwd);
    for (const [k, v] of [['COLLAB_DATA_DIR', saved.data], ['COLLAB_DB_PATH', saved.db], ['COLLAB_NOTEBOOK', saved.nb]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('--version prints the build identity', async () => {
  await withWorld(async ({ run }) => {
    const r = await run('--version');
    assert.equal(r.code, 0);
    assert.match(r.out[0], /^collab /);
  });
});

test('notebook new creates the file in the data folder and makes it the default; twice is refused', async () => {
  await withWorld(async ({ data, run }) => {
    const r = await run('notebook', 'new', 't');
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.ok(existsSync(join(data, 'notebooks', 't', 'notebook.db')));
    assert.equal(readNotebookConfig(data).default, 't');
    const again = await run('notebook', 'new', 't');
    assert.notEqual(again.code, 0);
    assert.match(again.err.join('\n'), /already/);
  });
});

test('notebook adopt registers a collab notebook in place and refuses other SQLite files', async () => {
  await withWorld(async ({ root, run }) => {
    const x = join(root, 'x.db');
    const db = getDb(x, { create: true }); migrate(db); closeDb();
    const r = await run('notebook', 'adopt', x, '--name', 'x');
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.out.join('\n'), /stays where it is/);
    const list = await run('notebook', 'list');
    assert.match(list.out.join('\n'), /x/);
    assert.match(list.out.join('\n'), new RegExp(x.replace(/[\\.]/g, '\\$&')));
    const other = join(root, 'other.db');
    const o = new Database(other); o.exec('CREATE TABLE t (a)'); o.close();
    const bad = await run('notebook', 'adopt', other, '--name', 'other');
    assert.notEqual(bad.code, 0);
    assert.match(bad.err.join('\n'), /isn't a collab notebook/);
  });
});

test('--notebook picks the notebook (rule 1) and which says so', async () => {
  await withWorld(async ({ root, run }) => {
    const x = join(root, 'x.db');
    const db = getDb(x, { create: true }); migrate(db); closeDb();
    assert.equal((await run('notebook', 'adopt', x, '--name', 'x')).code, 0);
    const r = await run('--notebook', 'x', 'notebook', 'which');
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.out.join('\n'), /x \(from --notebook\)/);
  });
});

test('doctor --json is the report as data, with all 7 groups', async () => {
  await withWorld(async ({ run }) => {
    const r = await run('doctor', '--json');
    const rep = JSON.parse(r.out.join('\n'));
    assert.ok([0, 1, 2].includes(rep.exitCode));
    assert.equal(r.code, rep.exitCode);
    const groups = new Set(rep.checks.map((c: any) => c.group));
    for (const g of ['install', 'notebook', 'version', 'programs', 'sync', 'claude', 'notes']) assert.ok(groups.has(g), g);
  });
});

test('sync routes to the courier CLI unchanged', async () => {
  let seen: string[] | null = null;
  const deps = { importModule: async () => ({ runCli: async (a: string[]) => { seen = a; return { code: 0 }; } }) };
  await withWorld(async ({ run }) => {
    const r = await run('sync', 'status');
    assert.equal(r.code, 0);
    assert.deepEqual(seen, ['sync', 'status']);
  }, deps);
});

test('an unknown command prints the usage and exits 2', async () => {
  await withWorld(async ({ run }) => {
    const r = await run('frobnicate');
    assert.equal(r.code, 2);
    assert.match(r.err.join('\n'), /collab notebook/);
  });
});
