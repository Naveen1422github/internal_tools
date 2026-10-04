import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupDoctor, startupProblem } from '../src/setup/engine.js';
import { getDb, closeDb, migrate } from '../src/db.js';
import { addNotebook } from '../src/notebooks.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'collab-doc-'));
  const data = join(root, 'data'); const proj = join(root, 'proj'); mkdirSync(proj, { recursive: true });
  const nb = join(root, 'nb.db');
  const db = getDb(nb, { create: true }); migrate(db); closeDb();
  const base = { cwd: proj, env: { COLLAB_DATA_DIR: data } as NodeJS.ProcessEnv, dataDir: data, now: new Date(), probePostOffice: null, claudeConfigFiles: [], isAlive: () => true };
  return { root, data, proj, nb, base, done: () => rmSync(root, { recursive: true, force: true }) };
}
const by = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

test('no notebook: notebook.choice is an error with the fix; dependent groups are skipped, not passed', async () => {
  const s = setup();
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version', 'notes'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').fix, /collab notebook/);
    assert.ok(r.checks.filter((c: any) => c.group === 'version').every((c: any) => c.mark === 'skipped'));
    assert.equal(r.exitCode, 2);
  } finally { s.done(); }
});

test('registered default notebook on the latest migration: notebook + version are ok', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const r = await runSetupDoctor({ ...s.base, groups: ['notebook', 'version'] });
    assert.equal(by(r, 'notebook.choice').mark, 'ok');
    assert.match(by(r, 'notebook.choice').text, /emp1st \(the default notebook\)/);
    assert.equal(by(r, 'version.notebook').mark, 'ok');
    assert.equal(r.exitCode, 0);
    assert.equal(r.notebook?.name, 'emp1st');
  } finally { s.done(); }
});

test('COLLAB_DB_PATH vs .collab disagreement is an error', async () => {
  const s = setup();
  try {
    addNotebook('emp1st', s.nb, s.data);
    const other = join(s.root, 'other.db'); const db = getDb(other, { create: true }); migrate(db); closeDb();
    addNotebook('supporthub', other, s.data);
    writeFileSync(join(s.proj, '.collab'), 'notebook = supporthub\n');
    const r = await runSetupDoctor({ ...s.base, env: { ...s.base.env, COLLAB_DB_PATH: s.nb }, groups: ['notebook'] });
    assert.equal(by(r, 'notebook.clash').mark, 'error');
    assert.match(by(r, 'notebook.clash').fix, /COLLAB_DB_PATH/);
  } finally { s.done(); }
});

test('a check that throws becomes an error line and the rest still run', async () => {
  const s = setup();
  mkdirSync(s.data, { recursive: true });
  writeFileSync(join(s.data, 'config.json'), '{ broken');
  try {
    const r = await runSetupDoctor({ ...s.base, groups: ['install', 'notebook'] });
    assert.equal(by(r, 'notebook.choice').mark, 'error');
    assert.match(by(r, 'notebook.choice').text, /config\.json/);
    assert.ok(by(r, 'install.node'));
  } finally { s.done(); }
});

test('startupProblem returns the first blocking error, or null', async () => {
  const s = setup();
  try {
    assert.equal((await startupProblem({ ...s.base }))?.id, 'notebook.choice');
    addNotebook('emp1st', s.nb, s.data);
    const p = await startupProblem({ ...s.base });
    assert.ok(p === null || p.group === 'install', 'only an install problem (e.g. add-on missing in CI) may remain');
  } finally { s.done(); }
});
