import { test } from 'node:test';
import assert from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../src/db.js';

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

test('falls back to collab.db in the CURRENT WORKING DIRECTORY', () => {
  withEnv(undefined, () => {
    const r = resolveDbPath();
    assert.equal(r.path, join(process.cwd(), 'collab.db'));
    assert.equal(r.source, 'cwd-fallback');
  });
});

// The regression this file exists for: collab E-550. The old default was
// join(__dirname, "../../mcp/collab.db") - a path inside the install, therefore
// shared by every project pointed at it. A second workspace silently wrote its
// entries into another project's knowledge base for days, with no error.
// This must never come back, at any cwd.
test('the fallback is never the old package-relative path', () => {
  withEnv(undefined, () => {
    const packageRelative = join(HERE, '..', '..', 'mcp', 'collab.db');
    assert.notEqual(
      resolveDbPath().path,
      packageRelative,
      'fallback resolved inside the install; it must be relative to cwd',
    );
  });
});

test('the fallback tracks cwd rather than the module location', () => {
  withEnv(undefined, () => {
    const original = process.cwd();
    try {
      process.chdir(HERE);
      assert.equal(resolveDbPath().path, join(HERE, 'collab.db'));
    } finally {
      process.chdir(original);
    }
  });
});
