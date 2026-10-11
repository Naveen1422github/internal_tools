// file: cli/test/bind.test.ts
// `collab project bind|unbind|list`: a module's notes go to its bound project.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  closeDb, resolveDbPath, initModule, markProjectLeft,
} from '@collab-mcp/core';
import { main } from '../src/main.js';
import type { Io } from '../src/io.js';

type Run = (argv: string[], ask?: (q: string) => Promise<boolean>) => Promise<{ code: number; out: string[]; err: string[]; asked: string[] }>;

async function withWorld(fn: (w: { run: Run; db: <T>(f: (db: Database.Database) => T) => T }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-bind-'));
  const saved = { data: process.env.COLLAB_DATA_DIR, db: process.env.COLLAB_DB_PATH, nb: process.env.COLLAB_NOTEBOOK, cpd: process.env.CLAUDE_PROJECT_DIR, author: process.env.COLLAB_AUTHOR, cwd: process.cwd() };
  process.env.COLLAB_DATA_DIR = join(root, 'data');
  for (const k of ['COLLAB_DB_PATH', 'COLLAB_NOTEBOOK', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
  process.env.COLLAB_AUTHOR = 'naveen';
  process.chdir(root);
  const run: Run = async (argv, ask) => {
    const out: string[] = []; const err: string[] = []; const asked: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), ...(ask ? { ask: async (q: string) => { asked.push(q); return ask(q); } } : {}) };
    const r = await main(argv, io);
    closeDb();
    return { code: r.code, out, err, asked };
  };
  const db = <T>(f: (db: Database.Database) => T): T => {
    const d = new Database(resolveDbPath().path);
    try { return f(d); } finally { try { d.prepare('SELECT crsql_finalize()').get(); } catch { /* not loaded */ } d.close(); }
  };
  try { await fn({ run, db }); } finally {
    closeDb();
    process.chdir(saved.cwd);
    for (const [k, v] of [['COLLAB_DATA_DIR', saved.data], ['COLLAB_DB_PATH', saved.db], ['COLLAB_NOTEBOOK', saved.nb], ['CLAUDE_PROJECT_DIR', saved.cpd], ['COLLAB_AUTHOR', saved.author]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function setup(w: { run: Run; db: <T>(f: (db: Database.Database) => T) => T }) {
  assert.equal((await w.run(['notebook', 'new', 't'])).code, 0);
  assert.equal((await w.run(['project', 'create', 'Navi', '--code', 'NV'])).code, 0);
  assert.equal((await w.run(['project', 'create', 'Other', '--code', 'OT'])).code, 0);
  w.db((d) => { initModule(d, { slug: 'm' }); initModule(d, { slug: 'n' }); });
}

test('bind, list shows the modules, rebind, unbind', async () => {
  await withWorld(async (w) => {
    await setup(w);
    const b = await w.run(['project', 'bind', 'm', 'nv']);
    assert.equal(b.code, 0);
    assert.match(b.out.join('\n'), /Module m is bound to NV/);
    await w.run(['project', 'bind', 'n', 'NV']);
    assert.match((await w.run(['project', 'list'])).out.join('\n'), /NV\s+Navi\s+solo\s+0 note\(s\)\s+modules: m, n$/m);
    const re = await w.run(['project', 'bind', 'm', 'OT']);
    assert.match(re.out.join('\n'), /was bound to NV; now bound to OT/);
    const l = (await w.run(['project', 'list'])).out.join('\n');
    assert.match(l, /OT\s+Other\s+solo\s+0 note\(s\)\s+modules: m$/m);
    assert.match(l, /NV\s+Navi\s+solo\s+0 note\(s\)\s+modules: n$/m);
    const u = await w.run(['project', 'unbind', 'm']);
    assert.match(u.out.join('\n'), /no longer bound to OT/);
    assert.doesNotMatch((await w.run(['project', 'list'])).out.join('\n'), /OT.*modules:/);
  });
});

test('bind refuses an unknown module or project, a left team, and bad usage', async () => {
  await withWorld(async (w) => {
    await setup(w);
    const nm = await w.run(['project', 'bind', 'zz', 'NV']);
    assert.equal(nm.code, 1);
    assert.match(nm.err.join('\n'), /^collab: no module "zz"/);
    const np = await w.run(['project', 'bind', 'm', 'ZZ']);
    assert.equal(np.code, 1);
    assert.match(np.err.join('\n'), /^collab: no project "ZZ"/);
    w.db((d) => {
      d.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES ('01JPR0JECTSH00000000000000', 'Support', 'SH', 'team', 'fp')`).run();
      markProjectLeft(d, 'SH');
    });
    const lt = await w.run(['project', 'bind', 'm', 'SH']);
    assert.equal(lt.code, 1);
    assert.match(lt.err.join('\n'), /team you left/);
    assert.equal((await w.run(['project', 'bind', 'm'])).code, 2);
    assert.equal((await w.run(['project', 'unbind'])).code, 2);
  });
});
