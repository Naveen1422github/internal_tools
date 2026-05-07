const { test } = require('node:test');
const assert = require('node:assert');
const claude = require('../claude');

test('claude spawnArgs with task', () => {
  const task = {
    id: 'T-042',
    title: 'Wire collab MCP into agent handoff hook'
  };

  const args = claude.spawnArgs({ task });

  assert.ok(args.args.includes('--print'));
  assert.ok(args.args.includes('--input-format'));
  assert.ok(args.args.includes('text'));
  assert.ok(args.initialStdin.includes('T-042'));
  assert.ok(args.initialStdin.includes('Wire collab MCP'));
  assert.ok(args.initialStdin.endsWith('—— READY ——'));
});

test('claude spawnArgs without task', () => {
  const args = claude.spawnArgs({});

  assert.deepStrictEqual(args.args, []);
  assert.strictEqual(args.initialStdin, undefined);
});
