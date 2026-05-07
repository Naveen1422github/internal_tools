const { test } = require('node:test');
const assert = require('node:assert');
const agents = require('../index');

test('registry exports all 4 adapters', () => {
  const keys = Object.keys(agents);
  assert.deepStrictEqual(keys.sort(), ['claude', 'codex', 'gemini', 'jules']);
});

test('each adapter implements the interface', () => {
  for (const name in agents) {
    const adapter = agents[name];
    assert.strictEqual(adapter.name, name);
    assert.strictEqual(typeof adapter.detect, 'function');
    assert.strictEqual(typeof adapter.spawnArgs, 'function');
    assert.strictEqual(typeof adapter.onExit, 'function');
  }
});
