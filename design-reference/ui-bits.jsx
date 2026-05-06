/* global React */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- Icons ----------
const I = {
  chev: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 6l6 6-6 6"/></svg>,
  folder: () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>,
  file: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/></svg>,
  svc: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="6" rx="1.5"/><rect x="3" y="13" width="18" height="6" rx="1.5"/><circle cx="7" cy="6" r="0.8" fill="currentColor"/><circle cx="7" cy="16" r="0.8" fill="currentColor"/></svg>,
  search: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/></svg>,
  plus: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>,
  x: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M6 18L18 6"/></svg>,
  split: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>,
  more: () => <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>,
  copy: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></svg>,
  cog: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>,
  terminal: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>,
  task: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>,
  module: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
  send: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  cwd: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7l9-4 9 4M3 7v10l9 4 9-4V7M3 7l9 4 9-4M12 11v10"/></svg>,
  branch: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 8v8M6 12c0 4 4 4 6 4 4 0 6-2 6-6"/></svg>,
  history: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
};

const AGENT_META = {
  Claude: { color: '#d97757', letter: 'C', cmd: 'claude' },
  Codex:  { color: '#5fa8ff', letter: 'X', cmd: 'codex' },
  Gemini: { color: '#f472b6', letter: 'G', cmd: 'gemini' },
};

const STATUS_LIST = ['pending','assigned','in-progress','review','done'];

// ---------- File tree ----------
function TreeNode({ node, depth = 0, onSelect, selected }) {
  const [open, setOpen] = useState(node.open || depth < 1);
  const hasChildren = node.children && node.children.length;
  const isActive = selected === node.name && !hasChildren;
  return (
    <>
      <div
        className={`tree-row ${node.kind === 'svc' ? 'svc' : ''} ${!hasChildren ? 'leaf' : ''} ${open ? 'open' : ''} ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => {
          if (hasChildren) setOpen(o => !o);
          else onSelect && onSelect(node);
        }}
      >
        <span className="chev"><I.chev/></span>
        <span className="icon">
          {node.kind === 'svc' ? <I.svc/> : hasChildren ? <I.folder/> : <I.file/>}
        </span>
        <span className="name">{node.name}</span>
        {node.meta && <span className="meta">{node.meta}</span>}
      </div>
      {hasChildren && open && node.children.map((c, i) => (
        <TreeNode key={i} node={c} depth={depth+1} onSelect={onSelect} selected={selected}/>
      ))}
    </>
  );
}

// ---------- Task row + filters ----------
function TaskRow({ task, active, onClick, onContextMenu, onDragStart, onDragEnd }) {
  return (
    <div
      className={`task-row p-${task.priority} ${active ? 'active' : ''}`}
      onClick={() => onClick(task)}
      onContextMenu={e => onContextMenu(e, task)}
      draggable="true"
      onDragStart={e => onDragStart(e, task)}
      onDragEnd={onDragEnd}
    >
      <div className="top">
        <span className={`status-dot ${task.status}`}/>
        <span className="id">{task.id}</span>
        <span className="title">{task.title}</span>
      </div>
      <div className="meta">
        {task.services.slice(0,2).map(s => <span key={s} className="svc-chip">{s}</span>)}
        {task.services.length > 2 && <span style={{ color:'var(--text-3)', fontSize:10 }}>+{task.services.length - 2}</span>}
        <span style={{ flex:1 }}/>
        <span className="priority"><span className="bars"><span/><span/><span/></span></span>
        <span style={{ color:'var(--text-3)' }}>{task.assignee || '—'}</span>
      </div>
    </div>
  );
}

function ChipFilter({ label, active, onClick, dot }) {
  return (
    <button className={`chip ${active ? 'active' : ''}`} onClick={onClick}>
      {dot && <span className="dot" style={{ background: dot }}/>}
      {label}
    </button>
  );
}

window.UI = { I, AGENT_META, STATUS_LIST, TreeNode, TaskRow, ChipFilter };
