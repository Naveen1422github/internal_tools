// file: cli/test/copy.test.ts
// Stage B2 (spec P8, rule 7): `collab copy` lists, asks, then copies.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  closeDb, resolveDbPath, addEntry, initModule, planCopy, copyPlanLines, markProjectLeft,
} from '@collab-mcp/core';
import { main } from '../src/main.js';
import type { Io } from '../src/io.js';

type Run = (argv: string[], ask?: (q: string) => Promise<boolean>) => Promise<{ code: number; out: string[]; err: string[]; asked: string[] }>;

async function withWorld(fn: (w: { run: Run; db: <T>(f: (db: Database.Database) => T) => T }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-copy-'));
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
  w.db((d) => {
    initModule(d, { slug: 'm' });
    addEntry(d, { type: 'decision', title: 'one', summary: 's', module: 'm' });
    addEntry(d, { type: 'gotcha', title: 'two', summary: 's', module: 'm' });
  });
}
const nvCount = (w: { db: <T>(f: (db: Database.Database) => T) => T }) =>
  w.db((d) => (d.prepare(`SELECT COUNT(*) n FROM entries WHERE series = 'NV'`).get() as { n: number }).n);

test('no way to ask and no --yes: prints the list (the same lines as core) and copies nothing', async () => {
  await withWorld(async (w) => {
    await setup(w);
    const expected = w.db((d) => copyPlanLines(planCopy(d, { from: 'm', to: 'NV' })));
    const r = await w.run(['copy', '--from', 'm', '--to', 'NV']);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, [...expected, 'Nothing copied: run again with --yes to copy, or run it in a terminal to be asked.']);
    assert.equal(nvCount(w), 0);
  });
});

test('asked: no copies nothing; yes copies and prints what changed; --yes does not ask', async () => {
  await withWorld(async (w) => {
    await setup(w);
    const no = await w.run(['copy', '--from', 'm', '--to', 'NV'], async () => false);
    assert.deepEqual(no.asked, ['Copy these 2 notes into NV (Navi)? [y/N] ']);
    assert.equal(no.out.at(-1), 'Nothing copied.');
    assert.equal(nvCount(w), 0);
    const yes = await w.run(['copy', '--from', 'm', '--to', 'NV'], async () => true);
    assert.equal(yes.code, 0, yes.err.join('\n'));
    assert.ok(yes.out.includes('Copied 2 notes from module m (E notes) into NV (Navi, solo):'));
    assert.ok(yes.out.includes('  E-00001 -> NV-1'));
    assert.ok(yes.out.includes('  E-00002 -> NV-2'));
    assert.equal(nvCount(w), 2);
    w.db((d) => addEntry(d, { type: 'decision', title: 'three', summary: 's', module: 'm' }));
    const forced = await w.run(['copy', '--from', 'm', '--to', 'NV', '--yes'], async () => { throw new Error('must not ask'); });
    assert.equal(forced.code, 0, forced.err.join('\n'));
    assert.deepEqual(forced.asked, []);
    assert.ok(forced.out.includes('  E-00003 -> NV-3'));
    assert.ok(forced.out.includes('Skipped 2 already copied.'));
  });
});

test('--author me and --since pass through; usage and refusals', async () => {
  await withWorld(async (w) => {
    await setup(w);
    w.db((d) => d.prepare(`UPDATE entries SET created_at = '2025-01-01 00:00:00' WHERE title = 'one'`).run());
    const r = await w.run(['copy', '--from', 'm', '--to', 'NV', '--author', 'me', '--since', '2026-01-01']);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.out[1], /only notes by naveen created on or after 2026-01-01/);
    assert.equal(r.out.filter((l) => l.startsWith('  E-')).length, 1);
    assert.equal((await w.run(['copy', '--from', 'm'])).code, 2);
    assert.equal((await w.run(['copy', '--from', 'm', '--to', 'NV', '--bogus', 'x'])).code, 2);
    const bad = await w.run(['copy', '--from', 'm', '--to', 'ZZ', '--yes']);
    assert.equal(bad.code, 1);
    assert.match(bad.err.join('\n'), /^collab: no project "ZZ"/);
  });
});

test('project list marks a team you left', async () => {
  await withWorld(async (w) => {
    await setup(w);
    w.db((d) => {
      d.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES ('01JPR0JECTSH00000000000000', 'Support', 'SH', 'team', 'fp')`).run();
      markProjectLeft(d, 'SH');
    });
    const l = await w.run(['project', 'list']);
    assert.match(l.out.join('\n'), /SH\s+Support\s+team\s+0 note\(s\) \(left team, read-only\)$/m);
    assert.match(l.out.join('\n'), /NV\s+Navi\s+solo\s+0 note\(s\)$/m);
  });
});
