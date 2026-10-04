import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collabDataDir, readNotebookConfig, writeNotebookConfig, addNotebook, setDefaultNotebook,
  notebookDataDir, unnamedDataDir, nameForPath, NotebookConfigError, NOTEBOOK_NAME,
} from '../src/notebooks.js';
import { installRoot } from '../src/install-root.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'collab-nb-'));

test('data folder per OS, COLLAB_DATA_DIR wins', () => {
  assert.equal(collabDataDir({ COLLAB_DATA_DIR: '/x' }, 'linux', '/h'), '/x');
  assert.equal(collabDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h'), 'C:\\L\\collab');
  assert.equal(collabDataDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/collab');
  assert.equal(collabDataDir({ XDG_DATA_HOME: '/d' }, 'linux', '/h'), '/d/collab');
  assert.equal(collabDataDir({}, 'linux', '/h'), '/h/.local/share/collab');
});

test('missing config.json reads as empty; round trip is atomic and exact', () => {
  const d = tmp();
  try {
    assert.deepEqual(readNotebookConfig(d), { default: null, notebooks: {} });
    writeNotebookConfig({ default: 'a', notebooks: { a: { path: '/p/a.db' } } }, d);
    assert.deepEqual(readNotebookConfig(d), { default: 'a', notebooks: { a: { path: '/p/a.db' } } });
    assert.equal(existsSync(join(d, 'config.json.tmp')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('invalid config.json throws with the file path and is never rewritten', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'config.json'), '{ not json');
    assert.throws(() => readNotebookConfig(d), (e: any) => e instanceof NotebookConfigError && e.file === join(d, 'config.json'));
    assert.throws(() => addNotebook('a', '/p/a.db', d), NotebookConfigError);
    assert.equal(readFileSync(join(d, 'config.json'), 'utf8'), '{ not json');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('addNotebook: first one becomes default; refuses bad names, duplicate names and duplicate paths', () => {
  const d = tmp();
  try {
    addNotebook('emp1st', '/p/one.db', d);
    assert.equal(readNotebookConfig(d).default, 'emp1st');
    addNotebook('acme', '/p/two.db', d);
    assert.equal(readNotebookConfig(d).default, 'emp1st');
    assert.throws(() => addNotebook('Bad Name', '/p/3.db', d), /name/);
    assert.throws(() => addNotebook('acme', '/p/4.db', d), /already/);
    assert.throws(() => addNotebook('other', '/p/two.db', d), /already registered as "acme"/);
    assert.equal(nameForPath('/p/two.db', d), 'acme');
    setDefaultNotebook('acme', d);
    assert.equal(readNotebookConfig(d).default, 'acme');
    assert.throws(() => setDefaultNotebook('nope', d), /no notebook named "nope"/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('runtime folders live in the data folder, keyed by name or by a hash of the path', () => {
  assert.equal(notebookDataDir('acme', '/data'), join('/data', 'notebooks', 'acme'));
  const u1 = unnamedDataDir('/repo/mcp/collab.db', '/data');
  assert.match(u1, /notebooks[\\/]_path-[0-9a-f]{12}$/);
  assert.equal(u1, unnamedDataDir('/repo/mcp/collab.db', '/data'));
  assert.notEqual(u1, unnamedDataDir('/other/collab.db', '/data'));
});

test('names follow the slug rule', () => {
  assert.ok(NOTEBOOK_NAME.test('supporthub'));
  assert.ok(NOTEBOOK_NAME.test('team-2'));
  assert.ok(!NOTEBOOK_NAME.test('-x'));
  assert.ok(!NOTEBOOK_NAME.test('UPPER'));
});

test('installRoot finds the folder that holds addon-manifest.json', () => {
  assert.ok(existsSync(join(installRoot(), 'addon-manifest.json')));
});
