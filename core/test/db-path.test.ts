import { test } from 'node:test';
import assert from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveDbPath, getDb, closeDb, MissingDatabaseError, NoNotebookError } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.COLLAB_DB_PATH;
  if (value === undefined) delete process.env.COLLAB_DB_PATH;
  else process.env.COLLAB_DB_PATH = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.COLLAB_DB_PATH;
    else process.env.COLLAB_DB_PATH = previous;
  }
}

test('an explicit argument wins over the environment', () => {
  withEnv('/from/env/collab.db', () => {
    const r = resolveDbPath('/explicit/collab.db');
    assert.equal(r.path, '/explicit/collab.db');
    assert.equal(r.source, 'argument');
  });
});

test('falls back to COLLAB_DB_PATH when no argument is given', () => {
  withEnv('/from/env/collab.db', () => {
    const r = resolveDbPath();
    assert.equal(r.path, '/from/env/collab.db');
    assert.equal(r.source, 'COLLAB_DB_PATH');
  });
});

// Rules 4-6 (spec P7): ./collab.db is used only when it already exists; with
// nothing registered and no file, there is no silent new database (E-689).
// COLLAB_DATA_DIR points at an empty temp folder so no real notebook is read.
function withEmptyData(fn: (data: string) => void): void {
  const data = mkdtempSync(join(tmpdir(), 'collab-data-'));
  const previous = process.env.COLLAB_DATA_DIR;
  process.env.COLLAB_DATA_DIR = data;
  try { fn(data); } finally {
    if (previous === undefined) delete process.env.COLLAB_DATA_DIR;
    else process.env.COLLAB_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  }
}

test('collab.db in the CURRENT WORKING DIRECTORY is used only when it exists', () => {
  withEnv(undefined, () => withEmptyData(() => {
    const cwd = mkdtempSync(join(tmpdir(), 'collab-cwd-'));
    try {
      assert.throws(() => resolveDbPath(undefined, { cwd }), NoNotebookError);
      writeFileSync(join(cwd, 'collab.db'), '');
      const r = resolveDbPath(undefined, { cwd });
      assert.equal(r.path, join(cwd, 'collab.db'));
      assert.equal(r.source, 'cwd-existing');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }));
});

// The regression this file exists for: collab E-550. The old default was
// join(__dirname, "../../mcp/collab.db") - a path inside the install, therefore
// shared by every project pointed at it. A second workspace silently wrote its
// entries into another project's knowledge base for days, with no error.
// This must never come back, at any cwd.
test('the fallback is never the old package-relative path', () => {
  withEnv(undefined, () => withEmptyData(() => {
    const packageRelative = join(HERE, '..', '..', 'mcp', 'collab.db');
    assert.notEqual(
      resolveDbPath(undefined, { allowCreate: true }).path,
      packageRelative,
      'fallback resolved inside the install; it must be relative to cwd',
    );
  }));
});

test('the fallback tracks cwd rather than the module location', () => {
  withEnv(undefined, () => withEmptyData(() => {
    const original = process.cwd();
    try {
      process.chdir(HERE);
      const r = resolveDbPath(undefined, { allowCreate: true });
      assert.equal(r.path, join(HERE, 'collab.db'));
      assert.equal(r.source, 'cwd-create');
    } finally {
      process.chdir(original);
    }
  }));
});

function withVar(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { fn(); } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collab-guard-'));
  return { dir, path: join(dir, 'collab.db') };
}

// E-689: the REST server once opened ./collab.db because .env loaded late;
// SQLite created it, migrate() gave it a valid schema, and the UI showed 0
// entries with no error. A missing file must be an error, not a new DB.
test('getDb refuses to create a missing database file', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => {
      assert.throws(
        () => getDb(path),
        (e: Error) =>
          e instanceof MissingDatabaseError &&
          e.message.includes(path) &&
          e.message.includes('npm --prefix mcp run migrate'),
      );
    });
    assert.equal(existsSync(path), false, 'the refused path must not have been created');
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb creates the file when create: true is passed', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => { getDb(path, { create: true }); });
    assert.equal(existsSync(path), true);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb creates the file when COLLAB_DB_CREATE=1', () => {
  const { dir, path } = tempPath();
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', '1', () => { getDb(path); });
    assert.equal(existsSync(path), true);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDb opens :memory: without the guard', () => {
  closeDb();
  try {
    withVar('COLLAB_DB_CREATE', undefined, () => { assert.ok(getDb(':memory:')); });
  } finally {
    closeDb();
  }
});
