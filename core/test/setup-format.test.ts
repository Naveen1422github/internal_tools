import { test } from 'node:test';
import assert from 'node:assert';
import { formatSetupReport } from '../src/setup/format.js';
import type { SetupReport } from '../src/setup/types.js';

test('the text report: groups in order, marks, fixes, skipped groups, summary line', () => {
  const report: SetupReport = {
    checks: [
      { group: 'install', id: 'install.node', mark: 'ok', text: 'Node 22.11.0 (needs >=20.9.0)' },
      { group: 'notebook', id: 'notebook.unregistered', mark: 'warn', text: "This notebook isn't in collab's list", fix: 'collab notebook adopt "/x.db" --name <name>' },
      { group: 'programs', id: 'programs.mcp', mark: 'error', text: 'The MCP is running older code than is installed (started 14:02, installed build 18:40)', fix: 'type /mcp in Claude Code and reconnect collab' },
      { group: 'sync', id: 'sync.skipped', mark: 'skipped', text: 'sharing is off for this notebook' },
    ],
    errors: 1,
    warnings: 1,
    exitCode: 2,
    notebook: null,
  };
  assert.equal(formatSetupReport(report), [
    'collab doctor',
    '',
    'Install',
    '  ✓ Node 22.11.0 (needs >=20.9.0)',
    '',
    'Notebook',
    "  ! This notebook isn't in collab's list",
    '      fix: collab notebook adopt "/x.db" --name <name>',
    '',
    'Programs',
    '  ✗ The MCP is running older code than is installed (started 14:02, installed build 18:40)',
    '      fix: type /mcp in Claude Code and reconnect collab',
    '',
    'Sync',
    '  - sharing is off for this notebook',
    '',
    '1 problem(s), 1 warning(s).',
  ].join('\n'));
});

test('a clean report ends with All good.', () => {
  const out = formatSetupReport({ checks: [{ group: 'install', id: 'install.node', mark: 'ok', text: 'Node 22' }], errors: 0, warnings: 0, exitCode: 0, notebook: null });
  assert.ok(out.endsWith('\nAll good.'));
});
