/* global React, UI, Terminal */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- Task detail (slide-in overlay) ----------
function TaskDetail({ task, onClose, onAction, onTransition, onAssign }) {
  if (!task) return null;
  const meta = window.UI.AGENT_META;
  return (
    <div className="task-detail-overlay" onClick={e => e.stopPropagation()}>
      <div className="td-header">
        <div className="td-row">
          <span className="td-id">{task.id}</span>
          <span className="td-status"><span className={`status-dot ${task.status}`}/>{task.status}</span>
          <span className={`td-priority ${task.priority}`}>{task.priority}</span>
          <button className="td-close" onClick={onClose}><UI.I.x/></button>
        </div>
        <div className="td-title">{task.title}</div>
        <div className="td-summary">{task.summary}</div>
        <div className="td-meta-row">
          {task.module && <span className="module">@{task.module}</span>}
          {task.services.map(s => <span className="svc" key={s}>{s}</span>)}
          <span className="assignee">{task.assignee ? `→ ${task.assignee}` : 'unassigned'}</span>
        </div>
      </div>
      <div className="td-actions">
        <span className="label">Run with</span>
        <div className="td-action-btns">
          {['Claude','Codex','Gemini'].map(a => (
            <button
              key={a}
              className="td-action"
              data-agent={a.toLowerCase()}
              style={{ '--agent-color': meta[a].color }}
              onClick={() => onAction(task, a)}
            >
              <span className="agent-letter" style={{ background: meta[a].color }}>{meta[a].letter}</span>
              <span>{a}</span>
            </button>
          ))}
        </div>
        <div className="td-secondary-actions">
          <button className="td-sec" onClick={() => onAction(task, 'paste')}>Copy context envelope</button>
          <button className="td-sec" onClick={() => onAction(task, 'open-cwd')}>Open in terminal at @{task.module}</button>
          <select className="td-sec" value={task.status} onChange={e => onTransition(task, e.target.value)}>
            {window.UI.STATUS_LIST.map(s => <option key={s} value={s}>→ {s}</option>)}
          </select>
          <select className="td-sec" value={task.assignee || ''} onChange={e => onAssign(task, e.target.value || null)}>
            <option value="">unassigned</option>
            <option>Claude</option><option>Codex</option><option>Gemini</option><option>User</option>
          </select>
        </div>
      </div>
      <div className="td-body">
        {task.body && task.body.map((blk, i) => (
          <div key={i}>
            <h4>{blk.h}</h4>
            {blk.p && <p>{blk.p}</p>}
            {blk.list && <ul>{blk.list.map((it, j) => <li key={j}>{it}</li>)}</ul>}
            {blk.code && <pre style={{ background:'var(--bg-2)', border:'1px solid var(--line)', padding:10, borderRadius:6, fontFamily:'var(--font-mono)', fontSize:11.5, color:'var(--text-1)', overflow:'auto', margin:0 }}>{blk.code}</pre>}
          </div>
        ))}
        {(!task.body || task.body.length === 0) && <p style={{ color:'var(--text-3)' }}>No description.</p>}
        <h4>Activity</h4>
        <div className="td-activity">
          {(task.activity || []).map((a, i) => (
            <div className="td-activity-item" key={i}>
              <span className="timestamp">{a.t}</span>
              <span><span className="actor">{a.a}</span> <span className="act">{a.act}</span></span>
            </div>
          ))}
          {(!task.activity || task.activity.length === 0) && <div style={{ color:'var(--text-3)', fontSize:11.5 }}>No activity yet.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------- Right-click context menu ----------
function ContextMenu({ menu, onAction, onClose }) {
  if (!menu) return null;
  const meta = window.UI.AGENT_META;
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, []);
  const items = [
    { label: 'Open task', kbd: '↵', do: () => onAction('open', menu.task) },
    { sep: true },
    { groupLabel: 'Run with' },
    ...['Claude','Codex','Gemini'].map(a => ({
      label: `Run with ${a}`,
      iconAgent: a.toLowerCase(),
      letter: meta[a].letter,
      color: meta[a].color,
      do: () => onAction('run', menu.task, a),
    })),
    { sep: true },
    { label: 'Copy context envelope', kbd: '⌘C', do: () => onAction('copy', menu.task) },
    { label: 'Inject into focused terminal', kbd: '⌘↵', do: () => onAction('inject', menu.task) },
    { sep: true },
    { groupLabel: 'Transition' },
    ...window.UI.STATUS_LIST.filter(s => s !== menu.task.status).map(s => ({
      label: `Mark ${s}`, do: () => onAction('transition', menu.task, s),
    })),
    { sep: true },
    { label: 'Delete task', danger: true, do: () => onAction('delete', menu.task) },
  ];
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }}
         onClick={e => e.stopPropagation()}
         onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} className="sep"/>;
        if (it.groupLabel) return <div key={i} className="label">{it.groupLabel}</div>;
        return (
          <div key={i} className={`item ${it.danger ? 'danger' : ''}`} onClick={() => { it.do(); onClose(); }}>
            {it.letter ? <span className="agent-letter" style={{ background: it.color, '--agent-color': it.color }}>{it.letter}</span> : null}
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Cmd-K palette ----------
function CmdK({ open, onClose, tasks, sessions, onCommand }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);
  if (!open) return null;
  const meta = window.UI.AGENT_META;
  const ql = q.toLowerCase();

  const groups = [];
  // Quick actions when query is empty
  if (!q) {
    groups.push({ label: 'Quick actions', items: [
      { kind: 'spawn', agent: 'claude', label: 'New Claude session at workspace', sub: 'claude' },
      { kind: 'spawn', agent: 'codex', label: 'New Codex session', sub: 'codex' },
      { kind: 'spawn', agent: 'gemini', label: 'New Gemini session', sub: 'gemini' },
      { kind: 'spawn', agent: 'bash', label: 'New shell', sub: 'bash' },
    ]});
  }
  // Matching tasks
  const taskMatches = tasks.filter(t =>
    !q || t.id.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql) || (t.module || '').includes(ql)
  ).slice(0, 8);
  if (taskMatches.length) groups.push({ label: 'Tasks', items: taskMatches.map(t => ({ kind:'task', task: t, label: `${t.id}  ${t.title}`, sub: t.module ? `@${t.module}` : '' })) });
  // Run-with on first match
  if (taskMatches[0] && q) {
    const t = taskMatches[0];
    groups.push({ label: `Run "${t.id}" with`, items: ['Claude','Codex','Gemini'].map(a => ({
      kind: 'run', task: t, agent: a, color: meta[a].color, letter: meta[a].letter,
      label: `Run ${t.id} with ${a}`, sub: t.module ? `@${t.module}` : ''
    }))});
  }
  // Sessions (focus)
  const sessMatches = sessions.filter(s => !q || s.name.toLowerCase().includes(ql)).slice(0, 5);
  if (sessMatches.length) groups.push({ label: 'Sessions', items: sessMatches.map(s => ({ kind:'focus', session: s, agent: s.agent, label: `Focus → ${s.name}`, sub: s.cwd })) });
  // Settings
  if (!q || 'theme density layout'.includes(ql)) {
    groups.push({ label: 'Settings', items: [
      { kind:'theme', label: 'Toggle theme (Warp ↔ VS Code)', sub: '⌘,T' },
      { kind:'density', label: 'Cycle density', sub: 'compact / cozy / comfy' },
      { kind:'layout', label: 'Toggle terminal-first layout', sub: '⌘,L' },
    ]});
  }

  const flat = [];
  groups.forEach(g => { flat.push({ headerOf: g.label }); g.items.forEach(it => flat.push(it)); });
  const selectableIdxs = flat.map((it, i) => it.headerOf ? -1 : i).filter(i => i >= 0);
  const selIdx = selectableIdxs[Math.min(sel, selectableIdxs.length - 1)] ?? -1;

  const exec = idx => {
    const it = flat[idx]; if (!it || it.headerOf) return;
    onCommand(it);
    onClose();
  };

  const onKey = e => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { setSel(s => Math.min(s + 1, selectableIdxs.length - 1)); e.preventDefault(); }
    if (e.key === 'ArrowUp')   { setSel(s => Math.max(s - 1, 0)); e.preventDefault(); }
    if (e.key === 'Enter')     { exec(selIdx); }
  };

  return (
    <div className="cmdk-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input">
          <UI.I.search/>
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
                 placeholder="Search tasks, run with agent, focus terminal…"/>
          <span className="esc">esc</span>
        </div>
        <div className="cmdk-list">
          {flat.length === 0 && <div className="cmdk-empty">No results</div>}
          {flat.map((it, i) => {
            if (it.headerOf) return <div key={i} className="cmdk-group-label">{it.headerOf}</div>;
            const isSel = i === selIdx;
            const m = it.agent ? meta[it.agent.charAt(0).toUpperCase()+it.agent.slice(1)] : null;
            return (
              <div key={i} className={`cmdk-item ${isSel ? 'selected' : ''}`} onMouseEnter={() => setSel(selectableIdxs.indexOf(i))} onClick={() => exec(i)}>
                {it.kind === 'run' || it.kind === 'spawn' || it.kind === 'focus'
                  ? <span className="ico agent" style={{ background: it.color || (m && m.color) || 'var(--bg-2)' }}>
                      {it.letter || (m && m.letter) || '·'}
                    </span>
                  : it.kind === 'task'
                    ? <span className="ico"><UI.I.task/></span>
                    : <span className="ico"><UI.I.cog/></span>}
                <span className="label">{it.label}</span>
                {it.sub && <span className="sub">{it.sub}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

window.Overlays = { TaskDetail, ContextMenu, CmdK };
