// Data fixtures + helpers shared by both layout variants.
window.MOCK_DATA = (() => {
  const tasks = [
    {
      id: 'T-042', title: 'Wire collab MCP into agent handoff hook', status: 'in-progress',
      priority: 'high', assignee: 'Claude', module: 'collab-mcp',
      services: ['collab-mcp', 'public'],
      summary: 'Hook fires before subagent context is sealed; needs to flush pending entries.',
      body: [
        { h: 'Context', p: 'When an agent finishes a turn, the collab hook should ensure pending entries are persisted before the parent agent continues.' },
        { h: 'Acceptance criteria', list: [
          'Pre-handoff hook calls `collab.flush()`',
          'Failure surfaces in agent transcript, not silently',
          'Adds session-note entry on completion',
        ]},
        { h: 'Files', code: 'collab-mcp/src/tools/handoff.ts\ncollab-mcp/src/hooks/pre-handoff.ts' },
      ],
      activity: [
        { t: '14:02', a: 'User',   act: 'created task' },
        { t: '14:18', a: 'Claude', act: 'sent to claude-1 (workspace)' },
        { t: '15:31', a: 'Claude', act: 'pushed entry E-00231 (proposal)' },
      ],
    },
    {
      id: 'T-041', title: 'Codex profile auto-rotate on 429', status: 'review', priority: 'critical',
      assignee: 'Codex', module: 'codex-profiles',
      services: ['tools/codex.js', 'public'],
      summary: 'Detect rate-limit response and rotate to next ready profile within one second.',
      body: [
        { h: 'Notes', p: 'Probe should run in background — never block prompt entry.' },
      ],
      activity: [
        { t: '12:45', a: 'User',   act: 'created task' },
        { t: '13:10', a: 'Codex',  act: 'pushed proposal E-00229' },
      ],
    },
    {
      id: 'T-040', title: 'FTS5 reindex job for large entry bodies', status: 'pending',
      priority: 'medium', assignee: null, module: 'collab-mcp',
      services: ['collab-mcp'],
      summary: 'Background reindex when entry body exceeds 8 kB.',
      body: [{ h: 'Why', p: 'Long entries are getting truncated in search snippets.' }],
      activity: [{ t: '11:02', a: 'User', act: 'created task' }],
    },
    {
      id: 'T-039', title: 'Terminal tab persistence across reload', status: 'in-progress',
      priority: 'medium', assignee: 'Codex', module: 'dashboard',
      services: ['public', 'server.js'],
      summary: 'Sessions vanish on reload; should restore the same set of tabs and CWDs.',
      body: [],
      activity: [{ t: '09:14', a: 'User', act: 'created task' }],
    },
    {
      id: 'T-038', title: 'Add /run @T- shortcut to Claude session', status: 'assigned',
      priority: 'high', assignee: 'Claude', module: 'dashboard',
      services: ['public'],
      summary: 'Slash command resolves to task body and pipes into focused agent terminal.',
      body: [],
      activity: [{ t: 'Yesterday', a: 'User', act: 'created task' }],
    },
    {
      id: 'T-037', title: 'Doctor: detect orphaned task → entry refs', status: 'done',
      priority: 'low', assignee: 'Gemini', module: 'collab-mcp',
      services: ['collab-mcp'],
      summary: 'Add check that all entry.task_id values resolve to a real task.',
      body: [],
      activity: [
        { t: '2d ago', a: 'User', act: 'created task' },
        { t: '1d ago', a: 'Gemini', act: 'completed → done' },
      ],
    },
    {
      id: 'T-036', title: 'Move git-bash detection out of codex.js', status: 'pending',
      priority: 'low', assignee: null, module: 'codex-profiles',
      services: ['tools/codex.js'],
      summary: 'Refactor — share with future windows-only tools.',
      body: [],
      activity: [],
    },
    {
      id: 'T-035', title: 'Drag task → terminal pipes context envelope', status: 'in-progress',
      priority: 'high', assignee: 'Claude', module: 'dashboard',
      services: ['public'],
      summary: 'Ergonomics: drag the task chip into a terminal tab.',
      body: [],
      activity: [],
    },
  ];

  const tree = [
    { kind: 'workspace', name: 'frontend2', open: true, children: [
      { kind: 'svc', name: 'collab-mcp', meta: 'mcp', open: true, children: [
        { kind: 'folder', name: 'src', open: true, children: [
          { kind: 'folder', name: 'tools', open: true, children: [
            { kind: 'file', name: 'handoff.ts', ext: 'ts' },
            { kind: 'file', name: 'review.ts', ext: 'ts' },
            { kind: 'file', name: 'rollup.ts', ext: 'ts' },
          ]},
          { kind: 'file', name: 'index.ts', ext: 'ts' },
        ]},
        { kind: 'file', name: 'DESIGN.md', ext: 'md' },
        { kind: 'file', name: 'README.md', ext: 'md' },
        { kind: 'file', name: 'package.json', ext: 'json' },
      ]},
      { kind: 'svc', name: 'gemini-mcp', meta: 'mcp', children: [
        { kind: 'file', name: 'README.md', ext: 'md' },
      ]},
      { kind: 'svc', name: 'public', meta: 'web', open: true, children: [
        { kind: 'file', name: 'index.html', ext: 'html', active: true },
        { kind: 'file', name: 'app.js', ext: 'js' },
        { kind: 'file', name: 'style.css', ext: 'css' },
      ]},
      { kind: 'folder', name: 'tools', children: [
        { kind: 'file', name: 'codex.js', ext: 'js' },
        { kind: 'file', name: 'collab.js', ext: 'js' },
      ]},
      { kind: 'file', name: 'server.js', ext: 'js' },
      { kind: 'file', name: 'README.md', ext: 'md' },
      { kind: 'file', name: 'package.json', ext: 'json' },
    ]},
  ];

  // Default terminal sessions.
  const sessions = [
    {
      id: 's1', name: 'workspace', agent: 'bash', cwd: '~/code/frontend2',
      blocks: [
        {
          stamp: '15:14:02', duration: '0.4s', exit: 'ok',
          cmd: 'git status -sb', cwd: '~/code/frontend2',
          out: [
            ['ansi-cyan', '## main...origin/main'],
            ['ansi-yellow', ' M collab-mcp/src/tools/handoff.ts'],
            ['ansi-yellow', ' M public/app.js'],
            ['ansi-green', '?? notes/2026-05-06.md'],
          ],
        },
        {
          stamp: '15:21:48', duration: '1.2s', exit: 'ok',
          cmd: 'pnpm -C collab-mcp test',
          out: [
            ['', 'PASS  src/tools/handoff.test.ts'],
            ['', 'PASS  src/tools/review.test.ts'],
            ['ansi-green', '\nTests: 38 passed, 38 total'],
            ['ansi-dim', 'Time:  1.18 s'],
          ],
        },
      ],
    },
    {
      id: 's2', name: 'claude / T-042', agent: 'claude', cwd: '~/code/frontend2',
      activeTaskId: 'T-042',
      blocks: [
        {
          stamp: '15:24:11', duration: '—', exit: 'run', kind: 'agent',
          cmd: '/run @T-042  Wire collab MCP into agent handoff hook',
          agentLabel: 'Claude · Sonnet 4.5',
          out: [
            ['ansi-bold', 'Loading task context…'],
            ['', '✓  Read T-042 body, activity log (3 entries)'],
            ['', '✓  Pulled module card @collab-mcp (4 active tasks, 2 gotchas)'],
            ['', '✓  Mounted services: collab-mcp/, public/'],
            ['ansi-dim', '\nReading collab-mcp/src/hooks/pre-handoff.ts (171 lines)…'],
            ['ansi-dim', 'Reading collab-mcp/src/tools/handoff.ts (84 lines)…'],
            ['ansi-bold', '\n› Plan'],
            ['', '  1. Add `pendingEntries` queue to handoff context'],
            ['', '  2. Drain queue in `pre-handoff` hook before sealing'],
            ['', '  3. Surface flush errors in agent transcript'],
            ['', '  4. Write session-note entry on success'],
            ['ansi-purple', '\nApplying patch to collab-mcp/src/hooks/pre-handoff.ts…'],
            ['ansi-green', '✓ patched (+24, -3)'],
            ['ansi-purple', 'Applying patch to collab-mcp/src/tools/handoff.ts…'],
            ['ansi-green', '✓ patched (+11, -1)'],
            ['ansi-bold', '\n› Running tests'],
            ['', '$ pnpm -C collab-mcp test --filter handoff'],
            ['ansi-green', 'PASS  src/tools/handoff.test.ts (8 tests)'],
            ['ansi-green', 'PASS  src/hooks/pre-handoff.test.ts (4 tests)'],
            ['ansi-bold', '\nReady for review.'],
          ],
        },
      ],
    },
    {
      id: 's3', name: 'codex / probe', agent: 'codex', cwd: '~/code/frontend2',
      blocks: [
        {
          stamp: '15:18:00', duration: '0.8s', exit: 'ok',
          cmd: '$ codex check --all',
          out: [
            ['ansi-cyan', '[work-1]    '], ['ansi-green', 'OK '], ['', '— last_activated 4m ago'],
            ['', '\n'],
            ['ansi-cyan', '[work-2]    '], ['ansi-green', 'OK '], ['', '— last_activated 2h ago'],
            ['', '\n'],
            ['ansi-cyan', '[personal]  '], ['ansi-yellow', 'COOLDOWN '], ['', '— resets 17:42 (2h 11m)'],
            ['', '\n'],
            ['ansi-cyan', '[backup]    '], ['ansi-green', 'OK '], ['', '— last_activated 1d ago'],
          ],
        },
      ],
    },
  ];

  const services = ['collab-mcp', 'gemini-mcp', 'public', 'server.js', 'tools/codex.js'];
  const modules = ['collab-mcp', 'codex-profiles', 'dashboard', 'gemini-mcp'];

  return { tasks, tree, sessions, services, modules };
})();
