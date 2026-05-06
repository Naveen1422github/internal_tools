/* global React, UI */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

function TerminalBlock({ block, agent, onTaskLink }) {
  const isAgent = block.kind === 'agent';
  const renderOut = () => {
    if (!block.out) return null;
    if (typeof block.out === 'string') return block.out;
    const nodes = [];
    let prevEndedNewline = true;
    block.out.forEach((seg, i) => {
      if (Array.isArray(seg)) {
        const [cls, text] = seg;
        const startsNewline = text.startsWith('\n');
        if (i > 0 && !prevEndedNewline && !startsNewline) {
          nodes.push('\n');
        }
        const parts = text.split(/(@?T-\d{3,4})/g);
        nodes.push(
          <span key={i} className={cls}>
            {parts.map((p, j) =>
              /^@?T-\d{3,4}$/.test(p)
                ? <span key={j} className="task-link" onClick={() => onTaskLink && onTaskLink(p.replace('@',''))}>{p}</span>
                : p
            )}
          </span>
        );
        prevEndedNewline = text.endsWith('\n');
      } else {
        nodes.push(seg);
        prevEndedNewline = typeof seg === 'string' && seg.endsWith('\n');
      }
    });
    return nodes;
  };
  return (
    <div className={`term-block ${isAgent ? 'agent' : ''}`} data-agent={agent}>
      <div className="block-header">
        <span className="stamp">{block.stamp}</span>
        {block.duration && <span className="duration">{block.duration}</span>}
        <span className={`exit ${block.exit}`}>{block.exit === 'run' ? '● running' : block.exit === 'ok' ? '✓ exit 0' : '✗ exit 1'}</span>
      </div>
      <div className="block-cmd">
        <span className="arrow">{isAgent ? '✦' : '›'}</span>
        {isAgent && block.agentLabel && <span className="agent-marker"><span className="blip"/>{block.agentLabel}</span>}
        <span>{block.cmd}</span>
      </div>
      <div className={`block-out ${block.muted ? 'muted' : ''}`}>{renderOut()}</div>
    </div>
  );
}

function TerminalPane({ session, onTaskLink, onPromptSubmit }) {
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [session.blocks.length]);
  const agentColor = session.agent === 'claude' ? '#d97757'
                   : session.agent === 'codex'  ? '#5fa8ff'
                   : session.agent === 'gemini' ? '#f472b6'
                   : session.agent === 'dev'    ? '#4ade80'
                   : '#94a3b8';
  return (
    <div className="term-pane" data-agent={session.agent}>
      <div className="term-header">
        <span className="session-name">{session.name}</span>
        <span className="agent-tag">{session.agent}</span>
        <span className="cwd"><UI.I.cwd/>{session.cwd}</span>
        <div className="h-actions">
          <button title="Split"><UI.I.split/></button>
          <button title="History"><UI.I.history/></button>
          <button title="Settings"><UI.I.cog/></button>
        </div>
      </div>
      <div className="term-body" ref={bodyRef}>
        {session.blocks.map((b, i) => (
          <TerminalBlock key={i} block={b} agent={session.agent} onTaskLink={onTaskLink}/>
        ))}
      </div>
      <form className="term-prompt" onSubmit={e => {
        e.preventDefault();
        if (!draft.trim()) return;
        onPromptSubmit && onPromptSubmit(session.id, draft.trim());
        setDraft('');
      }}>
        <span className="arrow">{session.agent === 'bash' ? '$' : '✦'}</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={
            session.agent === 'claude' ? 'Ask Claude — try /run @T-042 to load a task'
            : session.agent === 'codex' ? 'Codex — type a request or paste an error'
            : session.agent === 'gemini' ? 'Gemini — paste a diff or ask'
            : 'Type a command (drag a task here to inject context)'
          }
        />
        <span className="hint">
          {session.agent !== 'bash' ? <><kbd>/</kbd> commands</> : <><kbd>↵</kbd> run</>}
        </span>
      </form>
    </div>
  );
}

window.Terminal = { TerminalPane, TerminalBlock };
