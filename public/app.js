function consoleApp() {
    return {
        tab: 'profiles',
        subTab: 'entries', // For collab view: entries | tasks | modules
        loading: false,
        state: null,
        
        // Console Data
        sessions: [],
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
        activeFile: 'app.js',
        cmdkOpen: false,
        dragTask: null,
        dragTargetTab: null,
        consoleTheme: 'warp',
        consoleDensity: 'cozy',
        consoleAccent: 'purple',

        // Collab Data
        collabSearch: '',
        collabResults: [],
        collabTasks: [],
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
        filterModule: '',
        filterAgent: '',
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
            
            // Polling for profiles
            setInterval(() => { if (this.tab === 'profiles') this.loadState(true); }, 15000);
            
            // Apply console theme
            this.applyConsoleTheme();

            // Cmd-K hotkey
            window.addEventListener('keydown', e => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                    e.preventDefault(); this.cmdkOpen = true;
                }
            });
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
            if (this.sessions.length && !this.activeSessionId) {
                this.activeSessionId = this.sessions[0].id;
            }
        },
        async loadConsoleTasks() {
            const data = await this.api('GET', '/api/collab/tasks');
            this.tasks = data.results || [];
        },
        async spawnSession(agent, opts = {}) {
            const data = await this.api('POST', '/api/console/session/spawn', { agent, opts });
            if (data.ok) {
                this.sessions.push(data.session);
                this.activeSessionId = data.session.id;
            }
        },
        async closeSession(id) {
            await this.api('POST', '/api/console/session/close', { id });
            this.sessions = this.sessions.filter(s => s.id !== id);
            if (this.activeSessionId === id && this.sessions.length) {
                this.activeSessionId = this.sessions[0].id;
            }
            if (this.splitWith === id) this.splitWith = null;
        },
        async submitCommand(sessionId, text) {
            if (!text.trim()) return;
            const data = await this.api('POST', '/api/console/command/run', { sessionId, text });
            if (data.ok) {
                const session = this.sessions.find(s => s.id === sessionId);
                if (session) {
                    session.blocks.push(data.block);
                    // Scroll terminal to bottom after next tick
                    setTimeout(() => {
                        const el = document.querySelector(`[data-session-id="${sessionId}"] .tp-body`);
                        if (el) el.scrollTop = el.scrollHeight;
                    }, 50);
                }
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
        formatDateShort(iso) { return iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '---'; }
    };
}
