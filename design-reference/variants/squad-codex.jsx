/* global React */
const { useState, useMemo, useEffect } = React;

const SQUAD_TASKS = [
  { id:'T-042', title:'fix listing pagination off-by-one', branch:'session/fix-listing-pagi...', diff:'+124,-14', status:'running',  agent:'claude', module:'frontend2', svc:'web', ago:'2m' },
  { id:'T-039', title:'logging refactor across services',   branch:'session/logging-refa...',   diff:'+9,-9',   status:'review',   agent:'codex',  module:'platform',  svc:'api', ago:'14m' },
  { id:'T-051', title:'config tests for env loader',        branch:'session/config-tests',      diff:'+30,-5',  status:'ready',    agent:'gemini', module:'platform',  svc:'cli', ago:'1h' },
  { id:'T-058', title:'readme updates for setup flow',      branch:'session/readme-updates',    diff:'+15,-6',  status:'paused',   agent:'claude', module:'docs',      svc:'web', ago:'3h' },
  { id:'T-061', title:'crash on empty filter chip',         branch:'session/crash-empty-...',   diff:'+8,-2',   status:'pending',  agent:null,     module:'frontend2', svc:'web', ago:'1d' },
  { id:'T-024', title:'cli: --json flag for status',        branch:'session/cli-json-flag',     diff:'+88,-0',  status:'done',     agent:'codex',  module:'platform',  svc:'cli', ago:'2d' },
];

const STATUS_TINT = {
  running:  { dot:'#fbbf24', label:'Running'  },
  review:   { dot:'#f472b6', label:'Review'   },
  ready:    { dot:'#4ade80', label:'Ready'    },
  paused:   { dot:'#94a3b8', label:'Paused'   },
  pending:  { dot:'#64748b', label:'Pending'  },
  done:     { dot:'#22c55e', label:'Done'     },
};

const AGENT_COLOR = { claude:'#d97757', codex:'#5fa8ff', gemini:'#f472b6' };

const THREADS = [
  { kind:'pin',  id:'T-042', title:'fix listing pagination', meta:'+124 -14', stamp:'2m', dot:'#fbbf24' },
  { kind:'pin',  id:'T-039', title:'logging refactor',       meta:'+9 -9',    stamp:'14m', dot:'#f472b6' },
  { kind:'pin',  id:'T-051', title:'config tests',           meta:'+30 -5',   stamp:'1h',  dot:'#4ade80' },
  { kind:'pin',  id:'T-058', title:'readme updates',         meta:'+15 -6',   stamp:'3h',  dot:'#94a3b8' },
];

const FOLDERS = ['frontend2', 'platform', 'docs', 'pricing-svc', 'auth-svc', 'inbox', 'analytics-job'];

const PREVIEW_LINES = [
  ['dim','      -model ollama_chat/gemma3:1b\')'],
  ['dim','   53 ```'],
  ['',''],
  ['accent','● Bash (git diff)…'],
  ['dim','  └ diff --git a/README.md b/README.md'],
  ['dim','     index 4ed2163..dfefcb9 100644'],
  ['dim','     --- a/README.md'],
  ['dim','     +++ b/README.md'],
  ['dim','     @@ -9,6 +9,7 @@ Engineering Console manages multiple agent'],
  ['dim','     sessions across services'],
  ['',''],
  ['fade','  … +45 lines (ctrl+r to expand)'],
  ['',''],
  ['add','     +- Running  - Session is active with the assistant processing'],
  ['add','     +- Ready    - Session is available but not currently active'],
  ['add','     +- Paused   - Session has been checked out and is on hold'],
  ['',''],
  ['dim','     ### How It Works'],
  ['',''],
  ['accent','● Updated the README with previously missing menu items and features:'],
  ['',''],
  ['','     1. Added mouse support to highlights section'],
  ['','     2. Clarified "yolo mode" in the autoyes flag description'],
  ['','     3. Expanded menu section with:'],
  ['dim','        - Additional keyboard shortcuts (esc, backspace, ctrl-c)'],
  ['dim','        - Corrected \'s\' to \'p\' for pushing branches'],
  ['dim','        - Added mouse wheel scrolling option'],
  ['dim','        - Added explanation of instance status indicators'],
  ['dim','        - Clarified key alternatives and tab functionality'],
  ['',''],
  ['','  Would you like me to make any other improvements to the README?'],
];

const DIFF_LINES = [
  ['ctx','@@ README.md @@'],
  ['ctx',' Engineering Console manages multiple agent sessions across services.'],
  ['del','-Sessions can be Active or Idle.'],
  ['add','+Sessions can be Running, Ready, or Paused.'],
  ['ctx',' '],
  ['ctx',' ### Status indicators'],
  ['add','+ - **Running**  Session is active with the assistant processing'],
  ['add','+ - **Ready**    Session is available but not currently active'],
  ['add','+ - **Paused**   Session has been checked out and is on hold'],
  ['ctx',' '],
  ['ctx',' ### How It Works'],
];

function SquadCodex() {
  const [tab, setTab] = useState('preview');
  const [activeId, setActiveId] = useState('T-042');
  const [autoYes, setAutoYes] = useState(true);
  const [composer, setComposer] = useState('');
  const [activeFolder, setActiveFolder] = useState('frontend2');

  const active = SQUAD_TASKS.find(t => t.id === activeId);

  return (
    <div className="sx-root">
      <style>{SX_CSS}</style>
      {/* macOS chrome */}
      <div className="sx-chrome">
        <div className="sx-traffic">
          <span className="t r"/><span className="t y"/><span className="t g"/>
        </div>
        <div className="sx-tabs">
          <button className="sx-tab active">
            <span className="dot" style={{ background:'#8b6dff' }}/>./console
          </button>
          <button className="sx-tab">
            <span className="dot" style={{ background:'#5fa8ff' }}/>frontend2
          </button>
          <button className="sx-newtab">+ <span className="caret">▾</span></button>
        </div>
        <div className="sx-spacer"/>
        <div className="sx-toolbar">
          <button className="sx-link">Share</button>
          <button className="sx-iconbtn" title="Search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          </button>
          <button className="sx-iconbtn" title="Agent">A</button>
          <div className="sx-avatar"/>
          <button className="sx-signup">Sign up</button>
        </div>
      </div>

      <div className="sx-body">
        {/* Left: instances panel */}
        <aside className="sx-panel sx-panel--instances">
          <div className="sx-panel-head">
            <span className="sx-tag sx-tag--accent">Instances</span>
            <span className="sx-tag sx-tag--dim">{SQUAD_TASKS.length}</span>
            <div className="sx-panel-spacer"/>
            <button
              className={`sx-tag sx-tag--toggle ${autoYes ? 'on' : ''}`}
              onClick={() => setAutoYes(v => !v)}
              title="Auto-accept assistant prompts"
            >auto-yes</button>
          </div>

          <ul className="sx-instances">
            {SQUAD_TASKS.map((t, i) => {
              const sel = t.id === activeId;
              const tint = STATUS_TINT[t.status];
              return (
                <li
                  key={t.id}
                  className={`sx-instance ${sel ? 'is-selected' : ''}`}
                  onClick={() => setActiveId(t.id)}
                >
                  <span className="sx-i-num">{i + 1}.</span>
                  <div className="sx-i-body">
                    <div className="sx-i-title">
                      <span className="sx-i-text">{t.title}</span>
                      <span className="sx-i-status" style={{ background: tint.dot }} title={tint.label}/>
                    </div>
                    <div className="sx-i-meta">
                      <span className="sx-i-branch">λ-{t.branch}</span>
                      <span className="sx-diff sx-diff--add">+{t.diff.split(',')[0].replace('+','')}</span>
                      <span className="sx-diff sx-diff--del">{t.diff.split(',')[1]}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Threads (Codex-style) */}
          <div className="sx-threads">
            <div className="sx-threads-head">
              <span>Threads</span>
              <div className="sx-threads-actions">
                <button title="New folder">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4M10 13h4"/></svg>
                </button>
                <button title="Filter">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
                </button>
              </div>
            </div>
            <ul className="sx-folders">
              {FOLDERS.map(f => (
                <li
                  key={f}
                  className={`sx-folder ${activeFolder === f ? 'active' : ''}`}
                  onClick={() => setActiveFolder(f)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Right: preview/diff panel */}
        <section className="sx-panel sx-panel--preview">
          <div className="sx-tabs-row">
            <button
              className={`sx-pretab ${tab === 'preview' ? 'active' : ''}`}
              onClick={() => setTab('preview')}
            >Preview</button>
            <button
              className={`sx-pretab ${tab === 'diff' ? 'active' : ''}`}
              onClick={() => setTab('diff')}
            >Diff</button>
            <div className="sx-tabs-spacer"/>
            <span className="sx-stamp">
              <span className="dot pulse" style={{ background: AGENT_COLOR[active?.agent] || '#94a3b8' }}/>
              {active?.agent || 'shell'} · {active?.id} · {active?.ago} ago
            </span>
          </div>

          <div className="sx-stream">
            {tab === 'preview' ? (
              PREVIEW_LINES.map((line, i) => (
                <div key={i} className={`sx-line sx-line--${line[0] || 'plain'}`}>
                  {line[1]}
                </div>
              ))
            ) : (
              DIFF_LINES.map((line, i) => (
                <div key={i} className={`sx-line sx-line--${line[0]}`}>
                  {line[1]}
                </div>
              ))
            )}
          </div>

          <div className="sx-composer">
            <span className="sx-prompt">&gt;</span>
            <input
              className="sx-input"
              value={composer}
              onChange={e => setComposer(e.target.value)}
              placeholder="Send a message to claude · ⏎ to send, ? for shortcuts"
            />
            <span className="sx-input-cursor"/>
          </div>
          <div className="sx-shortcuts-mini">? for shortcuts</div>
          <div className="sx-ellipsis">…</div>
        </section>
      </div>

      {/* Bottom shortcut bar */}
      <footer className="sx-shortcuts">
        <Sk k="n" v="new"/>
        <Sk k="D" v="kill"/>
        <Sk k="↵/o" v="open"/>
        <Sk k="p" v="push branch"/>
        <Sk k="c" v="checkout"/>
        <Sk k="tab" v="switch tab"/>
        <Sk k="?" v="help"/>
        <Sk k="q" v="quit"/>
      </footer>
    </div>
  );
}

function Sk({ k, v }) {
  return (
    <span className="sk">
      <span className="sk-k">{k}</span>
      <span className="sk-v">{v}</span>
    </span>
  );
}

const SX_CSS = `
.sx-root {
  --bg-0: #0d0f14;
  --bg-1: #131720;
  --bg-2: #1a1f2b;
  --bg-3: #232938;
  --line: rgba(255,255,255,0.06);
  --line-2: rgba(255,255,255,0.10);
  --text-1: #e6e8ed;
  --text-2: #aab1c1;
  --text-3: #6c7689;
  --text-4: #4a5266;
  --accent: #8b6dff;
  --accent-soft: rgba(139,109,255,0.18);
  --add: #4ade80;
  --del: #f87171;
  --warn: #fbbf24;
  --pink: #f472b6;
  --cyan: #5fa8ff;

  position: absolute; inset: 0;
  background:
    radial-gradient(1100px 600px at 12% -10%, #1c5fbf 0%, transparent 55%),
    radial-gradient(1100px 700px at 105% 110%, #6b3ec9 0%, transparent 55%),
    linear-gradient(180deg, #1f6fb8 0%, #5b3da8 100%);
  font-family: 'Inter Tight', ui-sans-serif, system-ui;
  color: var(--text-1);
  display: flex; align-items: center; justify-content: center;
  padding: 56px 56px 88px;
  box-sizing: border-box;
  overflow: hidden;
}
.sx-root * { box-sizing: border-box; }

.sx-chrome {
  position: absolute; top: 56px; left: 56px; right: 56px; height: 38px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  display: flex; align-items: center; gap: 12px;
  padding: 0 14px;
  z-index: 2;
}
.sx-traffic { display: flex; gap: 7px; padding-right: 4px; }
.sx-traffic .t { width: 11px; height: 11px; border-radius: 50%; }
.sx-traffic .t.r { background: #ff5f57; }
.sx-traffic .t.y { background: #febc2e; }
.sx-traffic .t.g { background: #28c840; }
.sx-tabs { display: flex; gap: 4px; align-items: stretch; height: 100%; }
.sx-tab {
  background: none; border: none; color: var(--text-2);
  font-family: 'JetBrains Mono', monospace; font-size: 12px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 14px; cursor: pointer;
  border-bottom: 1.5px solid transparent;
  position: relative;
}
.sx-tab .dot { width: 6px; height: 6px; border-radius: 50%; }
.sx-tab.active { color: var(--text-1); border-bottom-color: var(--accent); }
.sx-newtab {
  background: none; border: none; color: var(--text-3);
  font-size: 14px; padding: 0 10px; cursor: pointer;
  display: flex; align-items: center; gap: 4px;
}
.sx-newtab .caret { font-size: 9px; opacity: 0.6; }
.sx-spacer { flex: 1; }
.sx-toolbar { display: flex; align-items: center; gap: 12px; }
.sx-link {
  background: none; border: none; color: var(--text-2);
  font-size: 12.5px; cursor: pointer;
}
.sx-iconbtn {
  background: none; border: none; color: var(--text-2);
  width: 24px; height: 24px; display: grid; place-items: center;
  border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;
}
.sx-iconbtn:hover { background: var(--bg-3); color: var(--text-1); }
.sx-avatar {
  width: 22px; height: 22px; border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #ff8fa3 0%, #c43d6e 70%);
  border: 1.5px solid #ff5577;
  position: relative;
}
.sx-avatar::after {
  content:''; position:absolute; top:-2px; right:-2px;
  width:7px; height:7px; border-radius:50%;
  background:#5fa8ff; border:1.5px solid var(--bg-0);
}
.sx-signup {
  background: var(--bg-2); color: var(--text-1);
  border: 1px solid var(--line-2);
  font-size: 12px; padding: 5px 14px;
  border-radius: 8px; cursor: pointer;
}

.sx-body {
  position: absolute; top: 94px; left: 56px; right: 56px; bottom: 88px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-top: none;
  border-radius: 0 0 12px 12px;
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 0;
  padding: 18px;
  overflow: hidden;
}
.sx-panel {
  display: flex; flex-direction: column;
  min-height: 0; min-width: 0;
}
.sx-panel--instances {
  padding-right: 18px;
  border-right: 1px dashed transparent;
}

/* Instances header */
.sx-panel-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px;
  padding: 0 4px;
}
.sx-panel-spacer { flex: 1; }
.sx-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; padding: 4px 9px; border-radius: 4px;
  border: 1px solid transparent;
  letter-spacing: 0.02em;
}
.sx-tag--accent {
  background: var(--accent-soft);
  color: #c8b8ff;
  border-color: rgba(139,109,255,0.4);
}
.sx-tag--dim {
  background: transparent; color: var(--text-3);
  border-color: var(--line);
}
.sx-tag--toggle {
  background: transparent; color: var(--text-3);
  border-color: var(--line);
  cursor: pointer;
}
.sx-tag--toggle.on {
  background: rgba(74,222,128,0.12);
  color: #86efac;
  border-color: rgba(74,222,128,0.4);
}

/* Instance rows */
.sx-instances {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 2px;
}
.sx-instance {
  display: grid; grid-template-columns: 28px 1fr;
  gap: 8px; padding: 12px 12px;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: background 0.12s;
}
.sx-instance:hover { background: rgba(255,255,255,0.03); }
.sx-instance.is-selected {
  background: rgba(255,255,255,0.06);
  border-color: var(--line-2);
}
.sx-i-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px; color: var(--text-3);
  padding-top: 2px;
}
.sx-i-title {
  display: flex; align-items: center; gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px; color: var(--text-1);
  margin-bottom: 4px;
}
.sx-i-status {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.sx-i-meta {
  display: flex; align-items: baseline; gap: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}
.sx-i-branch {
  color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 200px;
}
.sx-diff--add { color: var(--add); }
.sx-diff--del { color: var(--del); }

/* Threads */
.sx-threads {
  margin-top: 28px;
  padding: 0 4px;
}
.sx-threads-head {
  display: flex; align-items: center;
  font-size: 11px; color: var(--text-3);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 10px;
}
.sx-threads-actions { margin-left: auto; display: flex; gap: 4px; }
.sx-threads-actions button {
  background: none; border: none; color: var(--text-3);
  cursor: pointer; padding: 3px;
  border-radius: 4px;
}
.sx-threads-actions button:hover { color: var(--text-1); background: var(--bg-2); }
.sx-folders {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 1px;
}
.sx-folder {
  display: flex; align-items: center; gap: 9px;
  padding: 6px 8px; border-radius: 5px;
  font-size: 12.5px; color: var(--text-2);
  cursor: pointer;
}
.sx-folder:hover { background: rgba(255,255,255,0.04); color: var(--text-1); }
.sx-folder.active { color: var(--text-1); background: rgba(255,255,255,0.05); }
.sx-folder svg { color: var(--text-3); flex-shrink: 0; }

/* Preview panel */
.sx-panel--preview {
  border: 1.5px solid rgba(139,109,255,0.5);
  border-radius: 6px;
  padding: 0;
  background: rgba(13,15,20,0.5);
  position: relative;
  overflow: hidden;
}
.sx-tabs-row {
  display: flex; align-items: center;
  border-bottom: 1.5px solid rgba(139,109,255,0.5);
  padding: 0;
}
.sx-pretab {
  background: none; border: none;
  color: var(--text-3);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 14px 0;
  flex: 1;
  text-align: center;
  cursor: pointer;
  border-bottom: 1.5px solid transparent;
  margin-bottom: -1.5px;
}
.sx-pretab.active {
  color: var(--text-1);
  background: rgba(139,109,255,0.08);
}
.sx-tabs-spacer { display: none; }
.sx-stamp {
  display: none;
}

.sx-stream {
  flex: 1;
  padding: 18px 22px 8px;
  overflow: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  min-height: 0;
}
.sx-line { white-space: pre-wrap; min-height: 1.4em; }
.sx-line--dim { color: var(--text-3); }
.sx-line--accent { color: #fff; font-weight: 500; }
.sx-line--accent::first-letter { color: var(--accent); }
.sx-line--add { color: #86efac; }
.sx-line--del { color: #fca5a5; }
.sx-line--ctx { color: var(--text-3); }
.sx-line--fade { color: var(--text-4); }
.sx-line--plain { color: var(--text-2); }

.sx-composer {
  display: flex; align-items: center; gap: 8px;
  margin: 6px 16px 0;
  padding: 10px 14px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  background: rgba(255,255,255,0.02);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
}
.sx-prompt { color: var(--text-2); }
.sx-input {
  flex: 1;
  background: transparent; border: none; outline: none;
  color: var(--text-1);
  font-family: inherit; font-size: inherit;
}
.sx-input::placeholder { color: var(--text-4); }
.sx-input-cursor {
  width: 8px; height: 14px;
  background: var(--text-1);
  animation: sx-blink 1s step-end infinite;
  display: none;
}
@keyframes sx-blink { 50% { opacity: 0; } }

.sx-shortcuts-mini {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-4);
  padding: 6px 16px 14px;
}
.sx-ellipsis {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-4);
  padding: 0 22px 14px;
}

/* Bottom keyboard shortcut bar */
.sx-shortcuts {
  position: absolute; left: 56px; right: 56px; bottom: 32px;
  display: flex; justify-content: center; align-items: center;
  gap: 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-3);
  padding: 14px 0 0;
}
.sk { display: flex; align-items: center; gap: 6px; }
.sk-k {
  color: var(--text-2); font-weight: 500;
  padding: 1px 6px;
  border: 1px solid var(--line-2);
  border-radius: 3px;
  background: rgba(255,255,255,0.04);
  min-width: 14px; text-align: center;
}
.sk-v { color: var(--text-3); }
.sk + .sk::before {
  content: '·';
  color: var(--text-4);
  margin-right: 16px;
  margin-left: -16px;
}
`;

window.SquadCodex = SquadCodex;
