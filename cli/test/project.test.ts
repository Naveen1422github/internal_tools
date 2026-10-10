// file: cli/test/project.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDb, resolveDbPath, enableSync, setSyncValue, addEntry, SYNC_KEYS } from '@collab-mcp/core';
import { main } from '../src/main.js';
import { stubServer } from '../../core/test/helpers/https-stub.js';

// Temp data folder and temp cwd only: nothing here touches a real notebook.
async function withWorld(fn: (w: { root: string; run: (...argv: string[]) => Promise<{ code: number; out: string[]; err: string[] }> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-project-'));
  const saved = { data: process.env.COLLAB_DATA_DIR, db: process.env.COLLAB_DB_PATH, nb: process.env.COLLAB_NOTEBOOK, cpd: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd() };
  process.env.COLLAB_DATA_DIR = join(root, 'data');
  for (const k of ['COLLAB_DB_PATH', 'COLLAB_NOTEBOOK', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
  process.chdir(root);
  const run = async (...argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const r = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    closeDb();
    return { code: r.code, out, err };
  };
  try { await fn({ root, run }); } finally {
    closeDb();
    process.chdir(saved.cwd);
    for (const [k, v] of [['COLLAB_DATA_DIR', saved.data], ['COLLAB_DB_PATH', saved.db], ['COLLAB_NOTEBOOK', saved.nb], ['CLAUDE_PROJECT_DIR', saved.cpd]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('project create / list / rename / use round trip', async () => {
  await withWorld(async ({ root, run }) => {
    assert.equal((await run('notebook', 'new', 't')).code, 0);
    const c = await run('project', 'create', 'supporthub', '--code', 'sh');
    assert.equal(c.code, 0, c.err.join('\n'));
    assert.match(c.out.join('\n'), /SH/);
    const l = await run('project', 'list');
    assert.equal(l.code, 0, l.err.join('\n'));
    assert.match(l.out.join('\n'), /SH\s+supporthub\s+solo/);
    const r = await run('project', 'rename', 'SH', 'Support', 'Hub');
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match((await run('project', 'list')).out.join('\n'), /SH\s+Support Hub/);
    assert.equal(existsSync(join(root, '.collab')), false);
    const u = await run('project', 'use', 'sh');
    assert.equal(u.code, 0, u.err.join('\n'));
    const text = readFileSync(join(root, '.collab'), 'utf8');
    assert.match(text, /^notebook = t$/m);
    assert.match(text, /^project = [0-9A-HJKMNP-TV-Z]{26}\s+# SH Support Hub$/m);
    assert.match((await run('project', 'list')).out.join('\n'), /^\* SH/m, 'the current project is marked');
  });
});

test('project use keeps the other lines and comments of .collab and replaces an older project line', async () => {
  await withWorld(async ({ root, run }) => {
    await run('notebook', 'new', 't');
    await run('project', 'create', 'alpha', '--code', 'AL');
    await run('project', 'create', 'beta', '--code', 'BE');
    writeFileSync(join(root, '.collab'), '# my project\nnotebook = t   # the team notebook\n\n');
    assert.equal((await run('project', 'use', 'AL')).code, 0);
    assert.equal((await run('project', 'use', 'BE')).code, 0);
    const text = readFileSync(join(root, '.collab'), 'utf8');
    assert.match(text, /^# my project$/m);
    assert.match(text, /^notebook = t   # the team notebook$/m);
    assert.equal((text.match(/^project = /gm) ?? []).length, 1);
    assert.match(text, /# BE beta$/m);
  });
});

test('project create with a clash prints the P10 message and exits non-zero', async () => {
  await withWorld(async ({ run }) => {
    await run('notebook', 'new', 't');
    await run('project', 'create', 'supporthub', '--code', 'SH');
    const r = await run('project', 'create', 'SupportHub', '--code', 'XY');
    assert.notEqual(r.code, 0);
    assert.match(r.err.join('\n'), /rename/);
    assert.match(r.err.join('\n'), /different notebook/);
    const bad = await run('project', 'create', 'x', '--code', 'E');
    assert.notEqual(bad.code, 0);
    const usage = await run('project', 'create', 'x');
    assert.equal(usage.code, 2);
  });
});

// Stage C (P9, E-820): any member creates a team project or promotes a solo one.
test('project create --team and project promote talk to the post office and say what happens next', async () => {
  const seeds: number[] = [];
  const office = await stubServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const b = JSON.parse(body);
      seeds.push(b.seed);
      res.end(JSON.stringify({ project: { ulid: b.ulid, name: b.name, code: b.code, created_at: 'now' } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    await withWorld(async ({ run }) => {
      assert.equal((await run('notebook', 'new', 't')).code, 0);
      const unshared = await run('project', 'create', 'Support', '--code', 'SH', '--team');
      assert.equal(unshared.code, 1);
      assert.match(unshared.err.join('\n'), /share this notebook first/);
      // Share it (what `collab sync setup` writes), pointing at the stub office.
      const db = new Database(resolveDbPath().path);
      try {
        enableSync(db);
        setSyncValue(db, SYNC_KEYS.url, office.url);
        setSyncValue(db, SYNC_KEYS.fingerprint, office.fingerprint);
        setSyncValue(db, SYNC_KEYS.device, 'd-test');
        setSyncValue(db, SYNC_KEYS.key, 'k-test');
      } finally { db.prepare('SELECT crsql_finalize()').get(); db.close(); }
      const c = await run('project', 'create', 'Support', '--code', 'SH', '--team');
      assert.equal(c.code, 0, c.err.join('\n'));
      assert.equal(c.out[0], `Created team project SH (Support): numbers come from the post office at ${office.url}; with the office down, notes are saved and wait for their number.`);
      assert.match((await run('project', 'list')).out.join('\n'), /SH\s+Support\s+team\s+0 note\(s\)$/m);

      assert.equal((await run('project', 'create', 'Navi', '--code', 'NV')).code, 0);
      const w = new Database(resolveDbPath().path);
      try {
        for (const title of ['one', 'two', 'three']) addEntry(w, { type: 'decision', title, summary: 's', project: 'NV' });
        addEntry(w, { type: 'decision', title: 'waits', summary: 's', project: 'SH' }); // a team note saved without a number
      } finally { w.prepare('SELECT crsql_finalize()').get(); w.close(); }
      assert.match((await run('project', 'list')).out.join('\n'), /SH\s+Support\s+team\s+1 note\(s\), 1 waiting for a number/);
      const pr = await run('project', 'promote', 'nv');
      assert.equal(pr.code, 0, pr.err.join('\n'));
      assert.deepEqual(seeds, [0, 3]);
      assert.match(pr.out.join('\n'), /NV.*team project/);
      assert.match(pr.out.join('\n'), /after NV-3/);
      assert.match(pr.out.join('\n'), /next note is NV-4/);
      assert.match((await run('project', 'list')).out.join('\n'), /NV\s+Navi\s+team/);
    });
  } finally { await office.close(); }
});
