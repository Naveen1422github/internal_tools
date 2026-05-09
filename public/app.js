function consoleApp() {
    return {
        tab: 'profiles',
        subTab: 'entries', // For collab view: entries | tasks | modules
        loading: false,
        state: null,
        
        // Console Data
        sessions: [],
        sessionStreams: {},
        sessionStreamRetries: {},
        commandHistory: {},
        historyIndex: {},
        activeSessionId: null,
        splitWith: null,
        tasks: [],
        selectedTaskId: 'T-001',
        taskQuery: '',
        filterStatus: null,
        filterModule: null,
        filterAgent: null,
        filterPriority: null,
        showTaskDetail: false,
        cmdkOpen: false,
        dragTask: null,
        dragTargetTab: null,
        consoleTheme: 'warp',
        consoleDensity: 'cozy',
        consoleAccent: 'purple',
        workspace: { name: '', branch: null, diff: { add: 0, del: 0, files: 0 } },
        agentStatus: { claude: null, codex: null, gemini: null, jules: null },
        fileTree: { path: '', entries: [] },
        fileTreeOpen: { '': true },

        // Collab Data
        collabSearch: '',
        collabResults: [],
        collabTasks: [],

        // T2 Overlays & Modals
        cmdkQuery: '',
        cmdkGroups: [],
        cmdkSelectedIdx: 0,

        ctxMenu: null, // {x, y, items}

        dragGhost: null,

        tweaksOpen: false,
        consoleLayout: 'balanced', // 'balanced' or 'terminal-first'
        autoYes: false,

        cmdkMeta: {
            claude: { color: '#fb923c', letter: 'C' },
            codex: { color: '#38bdf8', letter: 'X' },
            gemini: { color: '#a78bfa', letter: 'G' },
            jules: { color: '#94a3b8', letter: 'J' }
        },
        activitySection: 'tasks',
        get ctxItems() { return this.ctxMenu ? this.ctxMenu.items : []; },

        collabModules: [],
        activeEntryId: null,
        activeEntry: {},
        activeTaskId: null,
        activeTask: {},
        activeModuleSlug: null,
        activeModule: {},
        activeModuleCard: null, 
        activeModuleTab: 'tasks',
        
        // Filters for entries list
        filterType: '',
        filterKind: 'any',
        
        // Doctor result
        doctorResult: null,
        showDoctor: false,
        
        // UI State
        editMode: null, // 'entry' | 'task' | 'module' | null
        dialog: null, // 'save-profile' | 'edit-profile' | null
        toasts: [],
        
        // Forms
        formData: { name: '', label: '', resetAt: '' },
        entryForm: { id: null, type: 'handoff', title: '', summary: '', description: '', agent: 'User', module: '', task_id: '', refs: [] },
        taskForm: { id: null, title: '', summary: '', description: '', status: 'pending', assignee: null, priority: 'medium', module: '' },
        moduleForm: { slug: '', name: '', summary: '', description: '', current_goal: '', status: 'active' },

        async init() {
            await this.loadState();
            await this.loadConsoleSessions();
            await this.loadConsoleTasks();
            await this.loadWorkspace();
            await this.loadAgents();
            await this.loadFiles();

        this.consoleLayout = localStorage.getItem('consoleLayout') || 'balanced';
        this.consoleAccent = localStorage.getItem('consoleAccent') || 'purple';
        this.autoYes = localStorage.getItem('autoYes') === 'true';
        this.applyConsoleTheme();

        window.addEventListener('keydown', (e) => {
            if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                this.cmdkOpen = !this.cmdkOpen;
                if (this.cmdkOpen) {
                    this.cmdkQuery = '';
                    this.cmdkUpdate();
                    this.$nextTick(() => { this.$refs.cmdkInput?.focus(); });
                }
            } else if (e.key === 'Escape') {
                this.cmdkOpen = false;
                this.ctxMenu = null;
                this.tweaksOpen = false;
            }
        });

        window.addEventListener('toggle-tweaks', () => {
            this.tweaksOpen = !this.tweaksOpen;
        });

        window.addEventListener('click', () => {
            this.ctxMenu = null;
        });

        window.updateDragGhost = (e) => {
            if (this.dragTask) {
                this.dragGhost = { x: e.clientX + 10, y: e.clientY + 10 };
            }
        };

            
            // Polling for profiles
            setInterval(() => { if (this.tab === 'profiles') this.loadState(true); }, 15000);
            setInterval(() => { if (this.tab === 'console') this.loadAgents(); }, 60000);
            setInterval(() => { if (this.tab === 'console') this.loadWorkspace(); }, 30000);
            
            // Apply console theme
            this.applyConsoleTheme();

        },


        saveTweaks() {
            localStorage.setItem('consoleTheme', this.consoleTheme);
            localStorage.setItem('consoleDensity', this.consoleDensity);
            localStorage.setItem('consoleLayout', this.consoleLayout);
            localStorage.setItem('consoleAccent', this.consoleAccent);
        },
        applyConsoleTheme() {
            const root = document.documentElement;
            root.dataset.theme = this.consoleTheme;
            root.dataset.density = this.consoleDensity;
            const accents = {
                purple: { '--accent': '#8b6dff', '--accent-2': '#5fa8ff' },
                cyan:   { '--accent': '#22d3ee', '--accent-2': '#a78bfa' },
                amber:  { '--accent': '#fbbf24', '--accent-2': '#f472b6' },
                green:  { '--accent': '#4ade80', '--accent-2': '#22d3ee' },
            };
            const accent = accents[this.consoleAccent] || accents.purple;
            Object.entries(accent).forEach(([k, v]) => root.style.setProperty(k, v));
        },

        async api(method, path, body) {
            this.loading = true;
            try {
                const res = await fetch(path, {
                    method,
                    headers: body ? { 'Content-Type': 'application/json' } : undefined,
                    body: body ? JSON.stringify(body) : undefined,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || data.stderr || res.statusText);
                return data;
            } catch (err) {
                this.showToast(err.message, 'err');
                throw err;
            } finally {
                this.loading = false;
            }
        },

        showToast(msg, type = 'info') {
            const id = Date.now();
            this.toasts.push({ id, msg, type });
            setTimeout(() => this.toasts = this.toasts.filter(t => t.id !== id), 4000);
        },

        async loadState(silent = false) {
            if (!silent) this.loading = true;
            try {
                this.state = await fetch('/api/codex/state').then(r => r.json());
                if (this.tab === 'collab') {
                    this.refreshCollabData();
                }
            } catch (e) {
                console.error(e);
            } finally {
                if (!silent) this.loading = false;
            }
        },

        refresh() { this.loadState(); },

        switchTab(t) {
            this.tab = t;
            if (t === 'collab') this.refreshCollabData();
            if (t === 'console') {
                this.loadConsoleSessions();
                this.loadConsoleTasks();
                this.loadWorkspace();
                this.loadAgents();
                this.loadFiles('');
            }
        },

        async refreshCollabData() {
            if (this.subTab === 'entries') await this.searchCollab();
            if (this.subTab === 'tasks') await this.loadTasks();
            if (this.subTab === 'modules') await this.loadModules();
        },

        // --- CONSOLE ---
        async loadConsoleSessions() {
            const data = await this.api('GET', '/api/console/sessions');
            this.sessions = data.sessions || [];
            for (const session of this.sessions) {
                this.ensureSessionStream(session.id);
                const key = `cmdHistory:${session.id}`;
                const saved = localStorage.getItem(key);
                this.commandHistory[session.id] = saved ? JSON.parse(saved) : [];
                this.historyIndex[session.id] = null;
            }
            if (this.sessions.length && !this.activeSessionId) {
                this.activeSessionId = this.sessions[0].id;
                this.focusSessionInput(this.sessions[0].id);
            }
        },
        async loadConsoleTasks() {
            const data = await this.api('GET', '/api/collab/tasks');
            this.tasks = data.results || [];
        },
        async loadWorkspace() {
            try {
                this.workspace = await this.api('GET', '/api/workspace/info');
            } catch (e) {
                console.error(e);
            }
        },
        async loadAgents() {
            try {
                this.agentStatus = await this.api('GET', '/api/workspace/agents');
            } catch (e) {
                console.error(e);
            }
        },
        async loadFiles(rel = '') {
            try {
                const data = await this.api('GET', `/api/workspace/files?path=${encodeURIComponent(rel)}&depth=2`);
                if (rel === '') {
                    this.fileTree = data;
                    return;
                }
                const node = this.findTreeNodeByPath(this.fileTree.entries || [], rel);
                if (node && node.type === 'dir') {
                    node.children = data.entries || [];
                }
            } catch (e) {
                console.error(e);
            }
        },
        findTreeNodeByPath(entries, targetPath) {
            for (const entry of entries || []) {
                if (entry.path === targetPath) return entry;
                if (entry.type === 'dir' && entry.children?.length) {
                    const found = this.findTreeNodeByPath(entry.children, targetPath);
                    if (found) return found;
                }
            }
            return null;
        },
        toggleFileNode(path) {
            this.fileTreeOpen[path] = !this.fileTreeOpen[path];
            if (!this.fileTreeOpen[path]) return;
            const node = this.findTreeNodeByPath(this.fileTree.entries || [], path);
            if (node && node.type === 'dir' && (!Array.isArray(node.children) || node.children.length === 0)) {
                this.loadFiles(path);
            }
        },
        agentLabel(agent) {
            const s = this.agentStatus?.[agent];
            if (!s) return '...';
            if (this.sessions.some((x) => String(x.agent || '').toLowerCase() === agent)) return 'active';
            if (s.label === 'cooldown' && s.cooldownEndsAt) {
                const ms = new Date(s.cooldownEndsAt).getTime() - Date.now();
                const h = Math.max(0, Math.floor(ms / 3600000));
                return `${h}h`;
            }
            return s.label || (s.ok ? 'ready' : 'missing');
        },
        rowClassForAgent(agent) {
            const label = this.agentLabel(agent);
            if (label === 'cooldown' || /^\d+h$/.test(label)) return 'cooldown';
            if (label === 'active') return '';
            return 'idle';
        },
        flattenTree(entries = [], depth = 0, out = []) {
            for (const entry of entries) {
                const isDir = entry.type === 'dir';
                const open = isDir ? Boolean(this.fileTreeOpen[entry.path]) : false;
                const childrenLoaded = isDir && Array.isArray(entry.children) && entry.children.length > 0;
                out.push({
                    name: entry.name,
                    type: entry.type,
                    path: entry.path,
                    depth,
                    open,
                    hasChildren: isDir && childrenLoaded,
                });
                if (isDir && open && childrenLoaded) {
                    this.flattenTree(entry.children, depth + 1, out);
                }
            }
            return out;
        },
        get flatTree() {
            return this.flattenTree(this.fileTree.entries || [], 0, []);
        },
        async spawnSession(agent, opts = {}) {
            const data = await this.api('POST', '/api/console/session/spawn', { agent, opts });
            if (data.ok) {
                this.sessions.push(data.session);
                this.ensureSessionStream(data.session.id);
                this.commandHistory[data.session.id] = this.commandHistory[data.session.id] || [];
                this.historyIndex[data.session.id] = null;
                this.activeSessionId = data.session.id;
                this.focusSessionInput(data.session.id);
            }
        },
        async closeSession(id) {
            await this.api('POST', '/api/console/session/close', { id });
            if (this.sessionStreams[id]) {
                this.sessionStreams[id].close();
                delete this.sessionStreams[id];
            }
            delete this.sessionStreamRetries[id];
            this.sessions = this.sessions.filter(s => s.id !== id);
            if (this.activeSessionId === id && this.sessions.length) {
                this.activeSessionId = this.sessions[0].id;
                this.focusSessionInput(this.sessions[0].id);
            }
            if (this.splitWith === id) this.splitWith = null;
        },
        ensureSessionStream(sessionId) {
            if (this.sessionStreams[sessionId]) return this.sessionStreamReady?.[sessionId] || Promise.resolve();
            const session = this.sessions.find((s) => s.id === sessionId);
            if (!session) return Promise.resolve();

            const es = new EventSource(`/api/console/session/stream?id=${sessionId}`);
            this.sessionStreams[sessionId] = es;
            this.sessionStreamRetries[sessionId] = this.sessionStreamRetries[sessionId] || 0;
            this.sessionStreamReady = this.sessionStreamReady || {};

            const ready = new Promise((resolve) => {
                const onceOpen = () => { console.debug('[sse]', sessionId, 'open'); resolve(); };
                es.addEventListener('open', onceOpen, { once: true });
            });
            this.sessionStreamReady[sessionId] = ready;

            const scrollToBottom = () => {
                this.$nextTick(() => {
                    const el = document.querySelector(`[data-session-id="${sessionId}"] .tp-body`);
                    if (el) el.scrollTop = el.scrollHeight;
                });
            };

            es.onopen = () => {
                this.sessionStreamRetries[sessionId] = 0;
            };

            es.onmessage = (e) => {
                let data;
                try {
                    data = JSON.parse(e.data);
                } catch {
                    return;
                }
                console.debug('[sse]', sessionId, data.type, data.payload);

                const current = this.sessions.find((s) => s.id === sessionId);
                if (!current) return;

                if (data.type === 'block-start') {
                    current.blocks = current.blocks || [];
                    current.blocks.push(data.payload);
                    current._currentBlockIndex = current.blocks.length - 1;
                    scrollToBottom();
                    return;
                }

                if (data.type === 'data') {
                    const idx = current._currentBlockIndex;
                    const block = Number.isInteger(idx) ? current.blocks[idx] : null;
                    if (block && block.exit === 'run') {
                        block.out = block.out || [];
                        block.out.push([data.payload?.ansiClass || '', data.payload?.line || '']);
                        scrollToBottom();
                    }
                    return;
                }

                if (data.type === 'block-end') {
                    const idx = current._currentBlockIndex;
                    const block = Number.isInteger(idx) ? current.blocks[idx] : null;
                    if (block) {
                        block.exit = data.payload?.exit || block.exit;
                        block.code = data.payload?.code;
                        block.duration = data.payload?.duration || block.duration;
                    }
                    delete current._currentBlockIndex;
                    scrollToBottom();
                    return;
                }

                if (data.type === 'exit') {
                    current.error = `Session exited (code ${data.payload?.exitCode ?? 'unknown'})`;
                }
            };

            es.onerror = () => {
                console.warn('[sse]', sessionId, 'error/closed; will reconnect');
                es.close();
                if (this.sessionStreams[sessionId] === es) delete this.sessionStreams[sessionId];
                if (this.sessionStreamReady) delete this.sessionStreamReady[sessionId];
                if (!this.sessions.find((s) => s.id === sessionId)) return;

                const retries = (this.sessionStreamRetries[sessionId] || 0) + 1;
                this.sessionStreamRetries[sessionId] = retries;
                const delay = Math.min(30000, 1000 * Math.pow(2, retries));
                setTimeout(() => {
                    if (this.sessions.find((s) => s.id === sessionId)) this.ensureSessionStream(sessionId);
                }, delay);
            };
        },

        // --- Cmd-K Palette ---
        cmdkUpdate() {
            const q = this.cmdkQuery.toLowerCase();
            let groups = [];

            // Tasks
            let tasks = this.collabTasks.filter(t => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
            if (tasks.length > 0) {
                groups.push({
                    label: 'Tasks',
                    items: tasks.slice(0, 5).map(t => ({ kind: 'task', label: t.title, sub: t.id, task: t }))
                });
            }

            // Sessions
            let sessions = this.sessions.filter(s => s.name.toLowerCase().includes(q));
            if (sessions.length > 0) {
                groups.push({
                    label: 'Active Sessions',
                    items: sessions.map(s => ({ kind: 'focus', label: 'Focus ' + s.name, agent: s.agent, sessionId: s.id }))
                });
            }

            // Agents
            let agents = ['Claude', 'Codex', 'Gemini'].filter(a => a.toLowerCase().includes(q));
            if (agents.length > 0) {
                groups.push({
                    label: 'Agents',
                    items: agents.map(a => ({ kind: 'spawn', label: 'Start session with ' + a, agent: a.toLowerCase() }))
                });
            }

            // Commands
            let cmds = ['Toggle Layout', 'Toggle Theme', 'Clear Terminals'].filter(c => c.toLowerCase().includes(q));
            if (cmds.length > 0) {
                groups.push({
                    label: 'Commands',
                    items: cmds.map(c => ({ kind: 'cmd', label: c }))
                });
            }

            this.cmdkGroups = groups;
            this.cmdkSelectedIdx = 0;
        },
        cmdkKeydown(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.cmdkSelectedIdx = Math.min(this.cmdkSelectedIdx + 1, this.cmdkGetTotalItems() - 1);
                this.cmdkScrollToSel();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.cmdkSelectedIdx = Math.max(this.cmdkSelectedIdx - 1, 0);
                this.cmdkScrollToSel();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const sel = this.cmdkGetSelectedItem();
                if (sel) this.cmdkExec(sel);
            } else {
                this.$nextTick(() => this.cmdkUpdate());
            }
        },
        cmdkGetTotalItems() {
            return this.cmdkGroups.reduce((acc, g) => acc + g.items.length, 0);
        },
        cmdkGetSelectedItem() {
            let i = 0;
            for (const g of this.cmdkGroups) {
                for (const item of g.items) {
                    if (i === this.cmdkSelectedIdx) return item;
                    i++;
                }
            }
            return null;
        },
        cmdkIsSelected(item) {
            return this.cmdkGetSelectedItem() === item;
        },
        cmdkSetSel(item) {
            let i = 0;
            for (const g of this.cmdkGroups) {
                for (const it of g.items) {
                    if (it === item) {
                        this.cmdkSelectedIdx = i;
                        return;
                    }
                    i++;
                }
            }
        },
        cmdkScrollToSel() {
            this.$nextTick(() => {
                const el = this.$refs.cmdkList?.querySelector('.cmdk-item.selected');
                if (el) el.scrollIntoView({ block: 'nearest' });
            });
        },
        cmdkExec(item) {
            if (item.kind === 'spawn') {
                this.spawnSession(item.agent);
            } else if (item.kind === 'focus') {
                this.activeSessionId = item.sessionId;
                this.activitySection = 'terminals';
                this.focusSessionInput(item.sessionId);
            } else if (item.kind === 'task') {
                this.selectedTaskId = item.task.id;
                this.showTaskDetail = true;
            } else if (item.kind === 'cmd') {
                if (item.label === 'Toggle Layout') this.consoleLayout = this.consoleLayout === 'balanced' ? 'terminal-first' : 'balanced';
                if (item.label === 'Toggle Theme') this.consoleTheme = this.consoleTheme === 'warp' ? 'vscode' : 'warp';
                if (item.label === 'Clear Terminals') this.sessions.forEach(s => s.blocks = []);
                this.applyConsoleTheme();
                this.saveTweaks();
            }
            this.cmdkOpen = false;
        },

        // --- Context Menu ---
        openCtx(e, task) {
            e.preventDefault();
            e.stopPropagation();
            this.ctxMenu = {
                x: e.clientX,
                y: e.clientY,
                task: task,
                items: [
                    { groupLabel: task.title.slice(0, 20) + '...' },
                    { sep: true },
                    { label: 'Run with Claude', agent: 'claude', color: '#fb923c', letter: 'C' },
                    { label: 'Run with Codex', agent: 'codex', color: '#38bdf8', letter: 'X' },
                    { label: 'Run with Gemini', agent: 'gemini', color: '#a78bfa', letter: 'G' },
                    { sep: true },
                    { label: 'Copy ID', action: 'copy-id', kbd: '⌘C' },
                    { label: 'Change Status...', action: 'status' },
                    { label: 'Delete Task', action: 'delete', danger: true, kbd: '⌘⌫' }
                ]
            };
        },
        ctxExec(item) {
            if (!this.ctxMenu) return;
            const task = this.ctxMenu.task;
            if (item.agent) {
                this.spawnSession(item.agent, { task: task });
            } else if (item.action === 'copy-id') {
                navigator.clipboard.writeText(task.id);
                this.showToast('Copied ' + task.id);
            } else if (item.action === 'delete') {
                this.showToast('Deleted ' + task.id); // stub
            } else if (item.action === 'status') {
                 this.selectedTaskId = task.id;
                 this.showTaskDetail = true;
            }
        },
        injectTaskIntoSession(sessionId, task) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                const el = document.querySelector(`.term-pane[data-session-id="${sessionId}"] .tp-input input`);
                if (el) { el.value = `Analyze task @${task.id}: ${task.title}`; }
                this.activeSessionId = sessionId;
                this.focusSessionInput(sessionId);
            }
        },
        focusSessionInput(sessionId) {
            this.$nextTick(() => {
                const el = document.querySelector(`.term-pane[data-session-id="${sessionId}"] .tp-input input`);
                if (el) el.focus();
            });
        },
        historyPrev(sessionId, inputEl) {
            const history = this.commandHistory[sessionId] || [];
            if (!history.length) return;
            const current = this.historyIndex[sessionId];
            if (current === null || current === undefined) {
                this.historyIndex[sessionId] = history.length - 1;
            } else {
                this.historyIndex[sessionId] = Math.max(0, current - 1);
            }
            inputEl.value = history[this.historyIndex[sessionId]] || '';
        },
        historyNext(sessionId, inputEl) {
            const history = this.commandHistory[sessionId] || [];
            if (!history.length) return;
            const current = this.historyIndex[sessionId];
            if (current === null || current === undefined) return;
            const next = Math.min(history.length, current + 1);
            if (next >= history.length) {
                this.historyIndex[sessionId] = null;
                inputEl.value = '';
                return;
            }
            this.historyIndex[sessionId] = next;
            inputEl.value = history[next] || '';
        },
        async killCurrentBlock(sessionId) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            const running = (session.blocks || []).some(b => b.exit === 'run');
            if (!running) return;
            await this.api('POST', '/api/console/session/input', { id: sessionId, data: '\x03' });
        },

        async submitCommand(sessionId, text) {
            if (!text.trim()) return;
            const cmd = text.trim();
            this.commandHistory[sessionId] = this.commandHistory[sessionId] || [];
            this.commandHistory[sessionId].push(cmd);
            if (this.commandHistory[sessionId].length > 200) this.commandHistory[sessionId].shift();
            localStorage.setItem(`cmdHistory:${sessionId}`, JSON.stringify(this.commandHistory[sessionId]));
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            await this.ensureSessionStream(sessionId);
            try {
                console.debug('[cmd]', sessionId, '→', cmd);
                const res = await fetch('/api/console/command/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, text, autoYes: this.autoYes }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.status === 409) {
                    this.showToast('Command already running', 'err');
                    return;
                }
                if (!res.ok) throw new Error(data.error || data.stderr || res.statusText);
            } catch (err) {
                this.showToast(err.message, 'err');
            }
        },
        get filteredConsoleTasks() {
            return this.tasks.filter(t => {
                if (this.taskQuery && !(t.id.toLowerCase().includes(this.taskQuery.toLowerCase()) || t.title.toLowerCase().includes(this.taskQuery.toLowerCase()))) return false;
                if (this.filterStatus && t.status !== this.filterStatus) return false;
                if (this.filterModule && t.module !== this.filterModule) return false;
                if (this.filterAgent && t.assignee !== this.filterAgent) return false;
                if (this.filterPriority && t.priority !== this.filterPriority) return false;
                return true;
            });
        },
        get activeSession() {
            return this.sessions.find(s => s.id === this.activeSessionId);
        },
        get splitSession() {
            return this.sessions.find(s => s.id === this.splitWith);
        },
        get selectedTask() {
            return this.tasks.find(t => t.id === this.selectedTaskId);
        },

        // --- PROFILES ---
        isAvailable(p) {
            if (!p.limit_resets_at) return true;
            return new Date(p.limit_resets_at).getTime() <= Date.now();
        },
        getReadyCount() { return Object.entries(this.state?.profiles || {}).filter(([n, p]) => n !== this.state.active_profile && this.isAvailable(p)).length; },
        getCooldownCount() { return Object.entries(this.state?.profiles || {}).filter(([n, p]) => !this.isAvailable(p)).length; },
        formatRelTime(iso) {
            if (!iso) return 'NEVER';
            const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
            if (s < 60) return `${s}s AGO`;
            if (s < 3600) return `${Math.floor(s/60)}m AGO`;
            return `${Math.floor(s/3600)}h AGO`;
        },
        humanReset(p) {
            const ms = new Date(p.limit_resets_at).getTime() - Date.now();
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        },
        async activate(name) {
            await this.api('POST', '/api/codex/activate', { name });
            await this.loadState();
            this.showToast(`Node ${name} ACTIVE`);
        },
        async check(name) {
            const r = await this.api('POST', '/api/codex/check', { name });
            this.state = r.state;
            const p = this.state.profiles[name] || {};
            if (r.timedOut) {
                this.showToast(`${name}: timed out — likely bad auth or network stall`, 'err');
                return;
            }
            const detail = p.check_message ? ` (${p.check_message})` : '';
            this.showToast(`${name}: ${p.check_ok ? 'Probe Valid' : 'Verification Failed'}${detail}`, p.check_ok ? 'info' : 'err');
        },
        async checkAll() {
            if (!confirm('Execute batch probe?')) return;
            await this.api('POST', '/api/codex/check', { all: true });
            await this.loadState();
        },
        pickNext() {
            const candidates = Object.entries(this.state.profiles)
                .filter(([n, p]) => n !== this.state.active_profile && this.isAvailable(p))
                .sort((a, b) => (new Date(a[1].last_activated || 0)) - (new Date(b[1].last_activated || 0)));
            if (candidates.length > 0) this.activate(candidates[0][0]);
            else this.showToast('No ready identities', 'err');
        },
        openSaveDialog() { this.formData = { name: '', label: '' }; this.dialog = 'save-profile'; },
        async saveCurrent() {
            if (!this.formData.name) return;
            await this.api('POST', '/api/codex/save', this.formData);
            await this.loadState();
            this.dialog = null;
        },
        async deleteProfile(name) {
            if (!confirm(`Purge ${name}?`)) return;
            await this.api('POST', '/api/codex/delete', { name });
            await this.loadState();
        },

        // --- COLLAB ENTRIES ---
        async searchCollab() {
            const q = this.collabSearch.trim();
            const params = new URLSearchParams({ q, kind: this.filterKind || 'any' });
            if (this.filterType) params.set('type', this.filterType);
            if (this.filterModule) params.set('module', this.filterModule);
            if (this.filterAgent) params.set('agent', this.filterAgent);
            const data = await this.api('GET', `/api/collab/search?${params.toString()}`);
            this.collabResults = data.results || [];
        },
        clearFilters() {
            this.filterType = ''; this.filterModule = ''; this.filterAgent = ''; this.filterKind = 'any';
            this.searchCollab();
        },
        async viewEntry(id) {
            this.editMode = null;
            this.activeTaskId = null;
            this.activeModuleSlug = null;
            this.activeEntryId = id;
            this.activeEntry = await this.api('GET', `/api/collab/entry?id=${id}`);
        },
        createEntry() {
            this.activeEntryId = null;
            this.editMode = 'entry';
            this.entryForm = { id: null, type: 'handoff', title: '', summary: '', description: '', agent: 'User', module: '', task_id: '', refs: [] };
        },
        editEntry() {
            this.entryForm = { ...this.activeEntry };
            this.editMode = 'entry';
        },
        async saveEntry() {
            await this.api('POST', '/api/collab/entry/upsert', this.entryForm);
            this.editMode = null;
            this.showToast('Entry Committed');
            await this.searchCollab();
        },
        async deleteEntry(id) {
            if (!confirm('Purge this entry?')) return;
            await this.api('POST', '/api/collab/entry/delete', { id });
            this.activeEntryId = null;
            await this.searchCollab();
        },

        // --- TASKS ---
        async loadTasks() {
            const data = await this.api('GET', '/api/collab/tasks');
            this.collabTasks = data.results || [];
        },
        async viewTask(task) {
            this.editMode = null;
            this.activeEntryId = null;
            this.activeModuleSlug = null;
            this.activeTaskId = task.id;
            this.activeTask = task;
        },
        createTask() {
            this.activeTaskId = null;
            this.editMode = 'task';
            this.taskForm = { id: null, title: '', summary: '', description: '', status: 'pending', assignee: null, priority: 'medium', module: '' };
        },
        editTask() {
            this.taskForm = { ...this.activeTask };
            this.editMode = 'task';
        },
        async saveTask() {
            await this.api('POST', '/api/collab/task/upsert', this.taskForm);
            this.editMode = null;
            this.showToast('Task Updated');
            await this.loadTasks();
            await this.loadConsoleTasks();
        },
        async transitionTask(id, status) {
            await this.api('POST', '/api/collab/task/transition', { id, status });
            this.showToast(`${id} → ${status}`);
            await this.loadTasks();
            await this.loadConsoleTasks();
            if (this.activeTask?.id === id) this.activeTask = { ...this.activeTask, status };
        },
        async assignTaskTo(id, assignee) {
            await this.api('POST', '/api/collab/task/assign', { id, assignee: assignee || null });
            this.showToast(`${id} assigned to ${assignee || '(unassigned)'}`);
            await this.loadTasks();
            await this.loadConsoleTasks();
            if (this.activeTask?.id === id) this.activeTask = { ...this.activeTask, assignee: assignee || null };
        },
        async deleteTask(id) {
            if (!confirm(`Purge task ${id}?`)) return;
            await this.api('POST', '/api/collab/task/delete', { id });
            this.activeTaskId = null; this.activeTask = {};
            await this.loadTasks();
            await this.loadConsoleTasks();
            this.showToast(`${id} purged`);
        },
        // status transitions allowed from current status (forward + done shortcut)
        nextStatuses(s) {
            const map = {
                pending: ['assigned', 'in-progress', 'done'],
                assigned: ['in-progress', 'review', 'done'],
                'in-progress': ['review', 'done'],
                review: ['in-progress', 'done'],
                done: ['in-progress'],
            };
            return map[s] || ['pending', 'assigned', 'in-progress', 'review', 'done'];
        },

        // --- MODULES ---
        async loadModules() {
            const data = await this.api('GET', '/api/collab/modules');
            this.collabModules = data.results || [];
        },
        async viewModule(mod) {
            this.editMode = null;
            this.activeEntryId = null;
            this.activeTaskId = null;
            this.activeModuleSlug = mod.slug;
            this.activeModule = mod;
            this.activeModuleCard = null;
            this.activeModuleTab = 'tasks';
            // Fetch the rich card (active tasks, gotchas, decisions, recent handoffs)
            this.loadModuleCard(mod.slug).catch(() => {});
        },
        createModule() {
            this.activeModuleSlug = null;
            this.editMode = 'module';
            this.moduleForm = { slug: '', name: '', summary: '', description: '', current_goal: '', status: 'active' };
        },
        editModule() {
            this.moduleForm = { ...this.activeModule };
            this.editMode = 'module';
        },
        async saveModule() {
            await this.api('POST', '/api/collab/module/upsert', this.moduleForm);
            this.editMode = null;
            this.showToast('Module Optimized');
            await this.loadModules();
        },
        async deleteModule(slug) {
            if (!confirm(`Purge module ${slug}? (only allowed if no entries/tasks reference it)`)) return;
            try {
                await this.api('POST', '/api/collab/module/delete', { slug });
                this.activeModuleSlug = null; this.activeModule = {}; this.activeModuleCard = null;
                await this.loadModules();
                this.showToast(`${slug} purged`);
            } catch {} // api() already toasts the error
        },
        async loadModuleCard(slug) {
            this.activeModuleCard = await this.api('GET', `/api/collab/module-card?slug=${encodeURIComponent(slug)}`);
        },

        // --- DOCTOR / EXPORT ---
        async runDoctor() {
            this.doctorResult = await this.api('POST', '/api/collab/doctor');
            this.showDoctor = true;
            this.showToast(this.doctorResult.ok ? 'Doctor: all green' : 'Doctor: issues found', this.doctorResult.ok ? 'info' : 'err');
        },
        exportData(format) {
            // Trigger a download via direct navigation; API sets Content-Disposition.
            const url = `/api/collab/export?format=${encodeURIComponent(format)}`;
            window.location.href = url;
        },

        // --- HELPERS ---
        formatDate(iso) { return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '---'; },
        formatDateLong(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }) : '---'; },
        formatDateShort(iso) { return iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '---'; },

        // Security: escape HTML and then restore markers
        safeHighlight(text) {
            if (!text) return '';
            // Escape HTML
            const div = document.createElement('div');
            div.textContent = text;
            let escaped = div.innerHTML;
            // Restore highlight markers
            return escaped
                .replaceAll('[[HL]]', '<mark class="bg-accent/30 text-accent px-1 rounded">')
                .replaceAll('[[/HL]]', '</mark>');
        }
    };
}

