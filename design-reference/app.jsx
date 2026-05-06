/* global React, ReactDOM, UI, Terminal, Overlays, MOCK_DATA, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakToggle, TweakColor */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "warp",
  "layout": "balanced",
  "density": "cozy",
  "accent": "purple"
}/*EDITMODE-END*/;

const ACCENTS = {
  purple: { '--accent': '#8b6dff', '--accent-2': '#5fa8ff' },
  cyan:   { '--accent': '#22d3ee', '--accent-2': '#a78bfa' },
  amber:  { '--accent': '#fbbf24', '--accent-2': '#f472b6' },
  green:  { '--accent': '#4ade80', '--accent-2': '#22d3ee' },
};

function App() {
  const [t, setTweak] = useTweaks(DEFAULTS);
  const data = window.MOCK_DATA;

  // Sessions state
  const [sessions, setSessions] = useState(() => data.sessions);
  const [activeSessionId, setActiveSessionId] = useState(sessions[1].id);
  const [splitWith, setSplitWith] = useState(null); // session id of secondary pane

  // Tasks
  const [tasks, setTasks] = useState(() => data.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState('T-042');
  const [taskQuery, setTaskQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterModule, setFilterModule] = useState(null);
  const [filterAgent, setFilterAgent] = useState(null);
  const [filterPriority, setFilterPriority] = useState(null);
  const [showTaskDetail, setShowTaskDetail] = useState(true);

  // Tree
  const [activeFile, setActiveFile] = useState('app.js');

  // Context menu / Cmd-K
  const [ctxMenu, setCtxMenu] = useState(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);

  // Drag state for task → terminal tab
  const [dragTask, setDragTask] = useState(null);
  const [dragTargetTab, setDragTargetTab] = useState(null);

  // Apply theme/density at root
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.density = t.density;
    const accent = ACCENTS[t.accent] || ACCENTS.purple;
    Object.entries(accent).forEach(([k, v]) => root.style.setProperty(k, v));
    return () => {
      Object.keys(accent).forEach(k => root.style.removeProperty(k));
    };
  }, [t.theme, t.density, t.accent]);

  // Cmd-K hotkey
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setCmdkOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Filtered tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      if (taskQuery && !(t.id.toLowerCase().includes(taskQuery.toLowerCase()) || t.title.toLowerCase().includes(taskQuery.toLowerCase()))) return false;
      if (filterStatus && t.status !== filterStatus) return false;
      if (filterModule && t.module !== filterModule) return false;
      if (filterAgent && t.assignee !== filterAgent) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      return true;
    });
  }, [tasks, taskQuery, filterStatus, filterModule, filterAgent, filterPriority]);

  const selectedTask = tasks.find(t => t.id === selectedTaskId);

  // ---------- Actions ----------
  const focusedSession = sessions.find(s => s.id === activeSessionId);

  const spawnSession = (agent, opts = {}) => {
    const meta = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', bash: 'shell', dev: 'dev' }[agent] || agent;
    const id = 's' + Date.now();
    const name = opts.task ? `${agent} / ${opts.task.id}` : opts.label || `${agent}`;
    const session = {
      id, name, agent,
      cwd: opts.cwd || '~/code/frontend2',
      activeTaskId: opts.task ? opts.task.id : null,
      blocks: opts.task ? [{
        stamp: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
        duration: '—', exit: 'run', kind: 'agent',
        cmd: `/run @${opts.task.id}  ${opts.task.title}`,
        agentLabel: `${meta} · ready`,
        out: [
          ['ansi-bold', `Mounted task ${opts.task.id}`],
          ['', `Module: @${opts.task.module}`],
          ['', `Services: ${opts.task.services.join(', ')}`],
          ['ansi-dim', `\nWaiting for input…`],
        ],
      }] : [{
        stamp: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
        duration: '0.0s', exit: 'ok',
        cmd: agent === 'bash' ? '$ ' : `${agent} --version`,
        out: agent === 'bash' ? [['ansi-dim', 'New shell — workspace root']] : [['ansi-cyan', `${meta}-cli 0.4.2`]],
      }],
    };
    setSessions(s => [...s, session]);
    setActiveSessionId(id);
    return session;
  };

  const closeSession = (id, e) => {
    if (e) e.stopPropagation();
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (activeSessionId === id && next.length) setActiveSessionId(next[0].id);
      return next;
    });
    if (splitWith === id) setSplitWith(null);
  };

  const runTaskWithAgent = (task, agentName) => {
    const agent = agentName.toLowerCase();
    spawnSession(agent, { task });
  };

  const transitionTask = (task, status) => {
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
  };

  const assignTask = (task, assignee) => {
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, assignee } : t));
  };

  const injectIntoFocused = (task, agentName) => {
    const session = focusedSession;
    if (!session) return;
    const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const newBlock = {
      stamp, duration: '—', exit: 'run', kind: session.agent !== 'bash' ? 'agent' : undefined,
      cmd: `/run @${task.id}  ${task.title}`,
      agentLabel: session.agent !== 'bash' ? `${session.agent} · injected from task panel` : undefined,
      out: [
        ['ansi-bold', `Mounted ${task.id}`],
        ['', `Services: ${task.services.join(', ')}`],
        ['ansi-dim', `\nReady…`],
      ],
    };
    setSessions(prev => prev.map(s => s.id === session.id ? { ...s, blocks: [...s.blocks, newBlock], activeTaskId: task.id } : s));
  };

  const onTaskAction = (task, action) => {
    if (['Claude','Codex','Gemini'].includes(action)) runTaskWithAgent(task, action);
    else if (action === 'paste') injectIntoFocused(task, focusedSession?.agent);
    else if (action === 'open-cwd') spawnSession('bash', { cwd: `~/code/frontend2/${task.module}` });
  };

  const onContextAction = (kind, task, arg) => {
    if (kind === 'open') { setSelectedTaskId(task.id); setShowTaskDetail(true); }
    else if (kind === 'run') runTaskWithAgent(task, arg);
    else if (kind === 'inject') injectIntoFocused(task);
    else if (kind === 'transition') transitionTask(task, arg);
    else if (kind === 'delete') setTasks(prev => prev.filter(t => t.id !== task.id));
  };

  const onCmdK = (item) => {
    if (item.kind === 'spawn') spawnSession(item.agent);
    else if (item.kind === 'task') { setSelectedTaskId(item.task.id); setShowTaskDetail(true); }
    else if (item.kind === 'run') runTaskWithAgent(item.task, item.agent);
    else if (item.kind === 'focus') setActiveSessionId(item.session.id);
    else if (item.kind === 'theme') setTweak('theme', t.theme === 'warp' ? 'vscode' : 'warp');
    else if (item.kind === 'density') {
      const order = ['compact','cozy','comfy'];
      setTweak('density', order[(order.indexOf(t.density) + 1) % order.length]);
    }
    else if (item.kind === 'layout') setTweak('layout', t.layout === 'balanced' ? 'terminal-first' : 'balanced');
  };

  const onPromptSubmit = (sessionId, text) => {
    const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const session = sessions.find(s => s.id === sessionId);
    let block;
    if (session.agent === 'bash') {
      block = { stamp, duration: '—', exit: 'run', cmd: text, out: [['ansi-dim', '… running']] };
    } else {
      block = {
        stamp, duration: '—', exit: 'run', kind: 'agent',
        cmd: text, agentLabel: `${session.agent} · thinking`,
        out: [['ansi-dim', '… reasoning']],
      };
    }
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, blocks: [...s.blocks, block] } : s));
  };

  // Drag handlers
  const onDragStart = (e, task) => {
    setDragTask(task);
    e.dataTransfer.setData('text/plain', task.id);
    // empty ghost
    const ghost = document.createElement('div');
    ghost.style.opacity = '0';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };
  const onDragEnd = () => { setDragTask(null); setDragTargetTab(null); };

  // ---------- Render ----------
  const visibleSessions = sessions;
  const showSplit = splitWith && sessions.find(s => s.id === splitWith);

  return (
    <div className="app" data-layout={t.layout === 'terminal-first' ? 'terminal-first' : 'balanced'}>
      {/* Title bar */}
      <header className="titlebar">
        <div className="tb-traffic"><span className="dot r"/><span className="dot y"/><span className="dot g"/></div>
        <div className="tb-workspace">
          <UI.I.cwd/>
          <span>frontend2</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-svc">{focusedSession?.activeTaskId ? `@${tasks.find(x => x.id === focusedSession.activeTaskId)?.module}` : 'workspace'}</span>
        </div>
        <div className="tb-spacer"/>
        <div className="tb-agents">
          <div className="tb-agent" data-agent="claude" style={{ '--agent-color': '#d97757' }}>
            <span className="pulse"/>Claude · work-1
          </div>
          <div className="tb-agent cooldown" data-agent="codex">
            <span className="pulse"/>Codex · 2h 11m
          </div>
          <div className="tb-agent" data-agent="gemini">
            <span className="pulse"/>Gemini · ready
          </div>
        </div>
        <button className="tb-cmdk" onClick={() => setCmdkOpen(true)}>
          <UI.I.search/>
          <span>Search tasks, run with agent…</span>
          <kbd>⌘K</kbd>
        </button>
      </header>

      {/* Activity bar */}
      <nav className="actbar">
        <button className="active" title="Files"><UI.I.file/></button>
        <button title="Tasks"><UI.I.task/><span className="badge">3</span></button>
        <button title="Modules"><UI.I.module/></button>
        <button title="Terminals"><UI.I.terminal/></button>
        <span className="spacer"/>
        <button title="Settings" onClick={() => window.dispatchEvent(new CustomEvent('toggle-tweaks'))}><UI.I.cog/></button>
      </nav>

      {/* Sidebar (file tree + tasks) */}
      <aside className="sidebar">
        <div className="sb-section tree">
          <div className="sb-header">
            <span>Workspace</span>
            <div className="actions">
              <button title="New file"><UI.I.plus/></button>
              <button title="More"><UI.I.more/></button>
            </div>
          </div>
          <div className="tree-list">
            {data.tree.map((n, i) => <UI.TreeNode key={i} node={n} onSelect={n => setActiveFile(n.name)} selected={activeFile}/>)}
          </div>
        </div>

        <div className="sb-section tasks">
          <div className="sb-header">
            <span>Tasks · {filteredTasks.length}</span>
            <div className="actions">
              <button title="New task"><UI.I.plus/></button>
              <button title="More"><UI.I.more/></button>
            </div>
          </div>
          <div className="task-filter">
            <div className="search-input">
              <UI.I.search/>
              <input placeholder="Filter tasks…" value={taskQuery} onChange={e => setTaskQuery(e.target.value)}/>
            </div>
            <div className="chip-row">
              {STATUS_CHIPS.map(s => (
                <UI.ChipFilter key={s.k} label={s.k} active={filterStatus === s.k} onClick={() => setFilterStatus(filterStatus === s.k ? null : s.k)} dot={s.color}/>
              ))}
            </div>
            <div className="chip-row">
              {data.modules.map(m => (
                <UI.ChipFilter key={m} label={`@${m}`} active={filterModule === m} onClick={() => setFilterModule(filterModule === m ? null : m)}/>
              ))}
            </div>
            <div className="chip-row">
              {['Claude','Codex','Gemini'].map(a => (
                <UI.ChipFilter key={a} label={a} active={filterAgent === a} onClick={() => setFilterAgent(filterAgent === a ? null : a)} dot={UI.AGENT_META[a].color}/>
              ))}
              {['critical','high'].map(p => (
                <UI.ChipFilter key={p} label={p} active={filterPriority === p} onClick={() => setFilterPriority(filterPriority === p ? null : p)} dot={p === 'critical' ? '#f87171' : '#fbbf24'}/>
              ))}
            </div>
          </div>
          <div className="task-list">
            {filteredTasks.map(task => (
              <UI.TaskRow
                key={task.id}
                task={task}
                active={selectedTaskId === task.id && showTaskDetail}
                onClick={t => { setSelectedTaskId(t.id); setShowTaskDetail(true); }}
                onContextMenu={(e, t) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, task: t });
                }}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ))}
            {filteredTasks.length === 0 && (
              <div style={{ padding: 24, textAlign:'center', color:'var(--text-3)', fontSize: 12 }}>No tasks match.</div>
            )}
          </div>
        </div>
      </aside>

      {/* Canvas: terminal grid */}
      <main className="canvas">
        <div className="term-tabs">
          {visibleSessions.map(s => (
            <button
              key={s.id}
              className={`term-tab ${activeSessionId === s.id ? 'active' : ''} ${dragTargetTab === s.id ? 'drag-target' : ''}`}
              data-agent={s.agent}
              style={{ '--agent-color': s.agent === 'claude' ? '#d97757' : s.agent === 'codex' ? '#5fa8ff' : s.agent === 'gemini' ? '#f472b6' : s.agent === 'dev' ? '#4ade80' : '#94a3b8' }}
              onClick={() => setActiveSessionId(s.id)}
              onDragOver={e => { if (dragTask) { e.preventDefault(); setDragTargetTab(s.id); } }}
              onDragLeave={() => setDragTargetTab(null)}
              onDrop={e => {
                e.preventDefault();
                if (dragTask) injectIntoFocused(dragTask) || (() => {
                  const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
                  setSessions(prev => prev.map(sess => sess.id === s.id ? { ...sess, blocks: [...sess.blocks, {
                    stamp, duration: '—', exit: 'run', kind: 'agent',
                    cmd: `/run @${dragTask.id}  ${dragTask.title}`,
                    agentLabel: `${s.agent} · injected via drag`,
                    out: [['ansi-bold', `Mounted ${dragTask.id}`]],
                  }] } : sess));
                })();
                // simpler: drop onto specific tab → inject into THAT session, not focused
                const stamp = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
                setSessions(prev => prev.map(sess => sess.id === s.id ? { ...sess, blocks: [...sess.blocks, {
                  stamp, duration: '—', exit: 'run', kind: sess.agent !== 'bash' ? 'agent' : undefined,
                  cmd: `/run @${dragTask.id}  ${dragTask.title}`,
                  agentLabel: sess.agent !== 'bash' ? `${sess.agent} · injected via drag` : undefined,
                  out: [
                    ['ansi-bold', `Mounted ${dragTask.id}`],
                    ['', `Services: ${dragTask.services.join(', ')}`],
                  ],
                  activeTaskId: dragTask.id,
                }] } : sess));
                setActiveSessionId(s.id);
                setDragTargetTab(null);
                setDragTask(null);
              }}
            >
              {s.agent !== 'bash' && <span className="agent-pill" style={{ '--agent-color': s.agent === 'claude' ? '#d97757' : s.agent === 'codex' ? '#5fa8ff' : s.agent === 'gemini' ? '#f472b6' : '#94a3b8' }}>{s.agent}</span>}
              <span className="name">{s.name}</span>
              <span className="close" onClick={e => closeSession(s.id, e)}><UI.I.x/></span>
            </button>
          ))}
          <button className="new-tab" onClick={() => spawnSession('bash')}>
            <UI.I.plus/><span style={{ fontSize: 11.5 }}>New</span>
          </button>
          <div className="right-actions">
            <button className="icon-btn" title="Split pane" onClick={() => setSplitWith(splitWith ? null : sessions.find(s => s.id !== activeSessionId)?.id)}><UI.I.split/></button>
            <button className="icon-btn" title="Sessions"><UI.I.more/></button>
          </div>
        </div>

        <div className={`term-grid ${showSplit ? 'split-2' : ''}`}>
          {focusedSession ? (
            <Terminal.TerminalPane
              session={focusedSession}
              onTaskLink={id => { setSelectedTaskId(id); setShowTaskDetail(true); }}
              onPromptSubmit={onPromptSubmit}
            />
          ) : (
            <div className="empty-canvas">No active terminal — press ⌘K to open one</div>
          )}
          {showSplit && (
            <Terminal.TerminalPane
              session={sessions.find(s => s.id === splitWith)}
              onTaskLink={id => { setSelectedTaskId(id); setShowTaskDetail(true); }}
              onPromptSubmit={onPromptSubmit}
            />
          )}
        </div>

        {selectedTask && showTaskDetail && (
          <Overlays.TaskDetail
            task={selectedTask}
            onClose={() => setShowTaskDetail(false)}
            onAction={onTaskAction}
            onTransition={transitionTask}
            onAssign={assignTask}
          />
        )}
      </main>

      {/* Status bar */}
      <footer className="statusbar" style={{ gridColumn: '1 / -1' }}>
        <span className="grp"><UI.I.branch/> main</span>
        <span className="grp muted">2 modified · 1 new</span>
        <span className="grp">{focusedSession?.cwd || '—'}</span>
        <span className="spacer"/>
        <span className="grp muted">{sessions.length} sessions</span>
        <span className="grp muted">{tasks.filter(t => t.status === 'in-progress').length} active tasks</span>
        <span className="grp">⌘K · palette</span>
      </footer>

      {/* Overlays */}
      <Overlays.ContextMenu menu={ctxMenu} onAction={onContextAction} onClose={() => setCtxMenu(null)}/>
      <Overlays.CmdK
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        tasks={tasks}
        sessions={sessions}
        onCommand={onCmdK}
      />

      {/* Drag ghost */}
      {dragTask && <DragGhost task={dragTask}/>}

      {/* Tweaks */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme"/>
        <TweakRadio
          label="Style"
          value={t.theme}
          onChange={v => setTweak('theme', v)}
          options={['warp', 'vscode']}
        />
        <TweakSelect
          label="Accent"
          value={t.accent}
          onChange={v => setTweak('accent', v)}
          options={['purple', 'cyan', 'amber', 'green']}
        />
        <TweakSection label="Layout"/>
        <TweakRadio
          label="Layout"
          value={t.layout}
          onChange={v => setTweak('layout', v)}
          options={['balanced', 'terminal-first']}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          onChange={v => setTweak('density', v)}
          options={['compact', 'cozy', 'comfy']}
        />
      </TweaksPanel>
    </div>
  );
}

// Map accent color (palette array) → name lookup
const _accentByPalette = (() => {
  // when TweakColor stores arrays, we want to keep `t.accent` as an array OR string
  // To keep it simple, the "accent" name in DEFAULTS stays as a string; user tweaks set raw palette arrays.
  return null;
})();

const STATUS_CHIPS = [
  { k: 'in-progress', color: '#fbbf24' },
  { k: 'review',      color: '#f472b6' },
  { k: 'pending',     color: '#7d8699' },
  { k: 'assigned',    color: '#5fa8ff' },
  { k: 'done',        color: '#4ade80' },
];

function DragGhost({ task }) {
  const [pos, setPos] = useState({ x: -100, y: -100 });
  useEffect(() => {
    const move = e => setPos({ x: e.clientX + 12, y: e.clientY + 8 });
    window.addEventListener('dragover', move);
    return () => window.removeEventListener('dragover', move);
  }, []);
  return <div className="drag-ghost" style={{ left: pos.x, top: pos.y }}>{task.id}  {task.title.slice(0, 36)}</div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
