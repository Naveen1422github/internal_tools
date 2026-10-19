// UI parity Task 7d: the CLI's and the MCP's shared lines, pinned so neither drifts.
import { test } from 'node:test';
import assert from 'node:assert';
import { teamListLines } from '../src/ops/team.js';

test('teamListLines: the `collab team list` table, column for column', () => {
  const lines = teamListLines({ code: 'SH', name: 'Support hub' }, {
    members: [
      { device_id: 'd-0123456789', name: 'Naveen', role: 'Owner', last_seen_at: '2026-10-19 10:00:00' },
      { device_id: 'd-abcdef0123', name: 'Rinku', role: 'Contributor', last_seen_at: null },
    ],
    roles: [{ name: 'Owner', keys: ['note.view', 'project.edit'] }, { name: 'Reader', keys: ['note.view'] }],
  });
  assert.deepEqual(lines, [
    'SH (Support hub)',
    'DEVICE        NAME                  ROLE              LAST SEEN',
    'd-0123456789  Naveen                Owner             2026-10-19 10:00:00',
    'd-abcdef0123  Rinku                 Contributor       -',
    'Roles in SH:',
    '  Owner: note.view, project.edit',
    '  Reader: note.view',
  ]);
});
