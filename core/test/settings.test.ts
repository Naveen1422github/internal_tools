import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, settingsPath } from '../src/settings.js';

test('reads KEY=VALUE, skips comments and blanks, strips quotes, never overrides', () => {
  const d = mkdtempSync(join(tmpdir(), 'collab-set-'));
  try {
    const f = join(d, 'settings.env');
    writeFileSync(f, '# web\nPORT=7473\n\nGROQ_MODEL="groq/compound-mini"\nGROQ_API_KEY=abc=def\nBAD LINE\n');
    const env: NodeJS.ProcessEnv = { PORT: '9000' };
    const set = loadSettings(f, env);
    assert.deepEqual(set.sort(), ['GROQ_API_KEY', 'GROQ_MODEL']);
    assert.equal(env.PORT, '9000');
    assert.equal(env.GROQ_MODEL, 'groq/compound-mini');
    assert.equal(env.GROQ_API_KEY, 'abc=def');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a missing file sets nothing', () => {
  assert.deepEqual(loadSettings(join(tmpdir(), 'nope-' + Date.now(), 'settings.env'), {}), []);
});

test('settings.env lives in the data folder', () => {
  assert.equal(settingsPath('/data'), join('/data', 'settings.env'));
});
