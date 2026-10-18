// file: cli/test/refused.test.ts
// RnR S2 (R6, R8, rule 5): `collab refused list|copy|delete`, and role refusals as one plain line.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  closeDb, resolveDbPath, addEntry, initModule, recordRefusal, writeAccessCache,
} from '@collab-mcp/core';
import { main } from '../src/main.js';
import type { Io } from '../src/io.js';

type Run = (argv: string[], ask?: (q: string) => Promise<boolean>) => Promise<{ code: number; out: string[]; err: string[]; asked: string[] }>;

async function withWorld(fn: (w: { run: Run; db: <T>(f: (db: Database.Database) => T) => T }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'collab-cli-refused-'));
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


type W = Parameters<Parameters<typeof withWorld>[0]>[0];
const TM = '01JPR0JECTTM00000000000000';

/** A notebook with solo NV, a team project TM (this laptop is a Reader there), one note, one refusal of it. */
async function setup(w: W) {
  assert.equal((await w.run(['notebook', 'new', 't'])).code, 0);
  assert.equal((await w.run(['project', 'create', 'Navi', '--code', 'NV'])).code, 0);
  return w.db((d) => {
    initModule(d, { slug: 'm' });
    d.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES (?, 'team TM', 'TM', 'team', 'fp')`).run(TM);
    writeAccessCache(d, { office: null, projects: [{ ulid: TM, code: 'TM', role: 'Reader', keys: ['note.view'], ai: {} }], replays: [] });
    const { id } = addEntry(d, { type: 'decision', title: 'Kept title', summary: 'kept summary', module: 'm', project: 'NV' });
    const note = d.prepare(`SELECT ulid FROM entries WHERE series = 'NV' AND id = ?`).get(id) as { ulid: string };
    const refusal = recordRefusal(d, { noteUlid: note.ulid, projectUlid: TM, kind: 'edit', key: 'note.edit', reason: 'You need "Edit notes" (note.edit) in TM to do this', cells: [] });
    return { refusal, noteUlid: note.ulid };
  });
}

test('refused list: id, project, kind, the note (its number) and the reason', async () => {
  await withWorld(async (w) => {
    const { refusal } = await setup(w);
    const r = await w.run(['refused', 'list']);
    assert.equal(r.code, 0, r.err.join(' | '));
    const line = r.out.find((l) => l.startsWith(refusal))!;
    assert.ok(line, r.out.join(' | '));
    assert.match(line, /TM\s+edit\s+NV-1\s+You need "Edit notes" \(note\.edit\) in TM to do this/);
  });
});

test('refused list shows the title when the note has no number yet', async () => {
  await withWorld(async (w) => {
    await setup(w);
    w.db((d) => {
      d.prepare(`UPDATE entries SET id = NULL WHERE series = 'NV'`).run();
    });
    const r = await w.run(['refused', 'list']);
    assert.match(r.out.join(' | '), /Kept title/);
  });
});

test('refused list with nothing refused says so', async () => {
  await withWorld(async (w) => {
    assert.equal((await w.run(['notebook', 'new', 't'])).code, 0);
    const r = await w.run(['refused', 'list']);
    assert.deepEqual(r.out, ['Nothing was refused.']);
  });
});

test('refused copy into a solo project prints the new ref and drops the refusal', async () => {
  await withWorld(async (w) => {
    const { refusal } = await setup(w);
    assert.equal((await w.run(['project', 'create', 'Other', '--code', 'OT'])).code, 0);
    const r = await w.run(['refused', 'copy', refusal, '--to', 'OT']);
    assert.equal(r.code, 0, r.err.join(' | '));
    assert.deepEqual(r.out, ['OT-1']);
    assert.deepEqual((await w.run(['refused', 'list'])).out, ['Nothing was refused.']);
  });
});

test('refused copy into a team project is refused in plain words and keeps the refusal', async () => {
  await withWorld(async (w) => {
    const { refusal } = await setup(w);
    const r = await w.run(['refused', 'copy', refusal, '--to', 'TM']);
    assert.equal(r.code, 1);
    assert.match(r.err.join(' | '), /TM is a team project\. Copy this note into a solo project instead/);
    assert.ok((await w.run(['refused', 'list'])).out.some((l) => l.startsWith(refusal)));
  });
});

test('refused delete says deleted and the row is gone; an unknown id fails', async () => {
  await withWorld(async (w) => {
    const { refusal } = await setup(w);
    const r = await w.run(['refused', 'delete', refusal]);
    assert.deepEqual(r.out, ['deleted']);
    assert.deepEqual((await w.run(['refused', 'list'])).out, ['Nothing was refused.']);
    assert.equal((await w.run(['refused', 'delete', refusal])).code, 1);
  });
});

test('a role refusal prints as one plain line, exit 1: no "[collab]", no stack', async () => {
  await withWorld(async (w) => {
    await setup(w);
    // Reader in TM: copying a note into TM is a write the role check stops before any network call.
    const r = await w.run(['copy', '--from', 'NV', '--to', 'TM', '--yes']);
    assert.equal(r.code, 1, r.out.join(' | '));
    assert.deepEqual(r.err, ['You need "Create notes" (note.create) in TM to do this']);
  });
});
