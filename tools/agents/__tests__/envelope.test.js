const { test } = require('node:test');
const assert = require('node:assert');
const { formatEnvelope } = require('../envelope');

test('envelope formatting includes task headings and sentinel', () => {
  const envelope = formatEnvelope({
    id: 'T-042',
    title: 'Wire collab MCP into agent handoff hook',
    status: 'in-progress',
    priority: 'high',
    assignee: 'Claude',
    module: 'collab-mcp',
    summary: 'Hook fires before subagent context is sealed; needs to flush pending entries.',
    description: 'This is the context description.',
  }, { dbPath: 'missing.db' });

  assert.match(envelope, /# Task @T-042 - Wire collab MCP into agent handoff hook/);
  assert.match(envelope, /\*\*Module:\*\* @collab-mcp/);
  assert.match(envelope, /\*\*Status:\*\* in-progress/);
  assert.match(envelope, /\*\*Assignee:\*\* Claude/);
  assert.match(envelope, /## Summary/);
  assert.match(envelope, /Hook fires before subagent context is sealed/);
  assert.match(envelope, /## Context/);
  assert.match(envelope, /This is the context description./);
  assert.ok(envelope.endsWith('-- READY --'), 'Envelope must end with sentinel');
});
