function consoleApp() {
    return {
        tab: 'collab',
        subTab: 'entries', // For collab view: entries | tasks | modules
        loading: false,
        initializing: true,
        
        // Collab Data
        collabSearch: '',
        collabResults: [],
        collabTasks: [],
        collabDispatches: [],
        dispatchStats: {},
        activeDispatchId: null,
        activeDispatch: {},

        ctxMenu: null, // {x, y, items}

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
        filterModule: null,
        filterAgent: null,
        
        // Doctor result
        doctorResult: null,
        showDoctor: false,
        
        // UI State
        editMode: null, // 'entry' | 'task' | 'module' | null
        dialog: null, 
        toasts: [],
        
        // Forms
        entryForm: { id: null, type: 'handoff', title: '', summary: '', description: '', agent: 'User', module: '', task_id: '', refs: [] },
        taskForm: { id: null, title: '', summary: '', description: '', status: 'pending', assignee: null, priority: 'medium', module: '' },
        moduleForm: { slug: '', name: '', summary: '', description: '', current_goal: '', status: 'active' },

        async init() {
            await this.searchCollab();
            this.initializing = false;

            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.ctxMenu = null;
                }
            });

            window.addEventListener('click', () => {
                this.ctxMenu = null;
            });
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

        refresh() { 
            this.refreshCollabData();
        },

        switchTab(t) {
            this.tab = t;
            if (t === 'collab') this.refreshCollabData();
        },

        async refreshCollabData() {
            if (this.subTab === 'entries') await this.searchCollab();
            if (this.subTab === 'tasks') await this.loadTasks();
            if (this.subTab === 'modules') await this.loadModules();
            if (this.subTab === 'dispatches') await this.loadDispatches();
        },

        resetActive() {
            this.activeEntryId = null;
            this.activeTaskId = null;
            this.activeModuleSlug = null;
            this.activeDispatchId = null;
            this.editMode = null;
        },
        async switchSubTab(st) {
            this.subTab = st;
            this.resetActive();
            await this.refreshCollabData();
        },

        async loadDispatches() {
            const data = await this.api('GET', '/api/collab/dispatches');
            this.collabDispatches = data.results || [];
            this.dispatchStats = data.stats || {};
        },

        async viewDispatch(id) {
            this.resetActive();
            this.activeDispatchId = id;
            this.activeDispatch = this.collabDispatches.find(d => d.id === id) || {};
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
            this.resetActive();
            this.activeEntryId = id;
            this.activeEntry = await this.api('GET', `/api/collab/entry?id=${id}`);
        },
        createEntry() {
            this.resetActive();
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
            this.resetActive();
            this.activeTaskId = task.id;
            this.activeTask = task;
        },
        createTask() {
            this.resetActive();
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
        },
        async transitionTask(id, status) {
            await this.api('POST', '/api/collab/task/transition', { id, status });
            this.showToast(`${id} → ${status}`);
            await this.loadTasks();
            if (this.activeTask?.id === id) this.activeTask = { ...this.activeTask, status };
        },
        async assignTaskTo(id, assignee) {
            await this.api('POST', '/api/collab/task/assign', { id, assignee: assignee || null });
            this.showToast(`${id} assigned to ${assignee || '(unassigned)'}`);
            await this.loadTasks();
            if (this.activeTask?.id === id) this.activeTask = { ...this.activeTask, assignee: assignee || null };
        },
        async deleteTask(id) {
            if (!confirm(`Purge task ${id}?`)) return;
            await this.api('POST', '/api/collab/task/delete', { id });
            this.activeTaskId = null; this.activeTask = {};
            await this.loadTasks();
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
            this.resetActive();
            this.activeModuleSlug = mod.slug;
            this.activeModule = mod;
            this.activeModuleCard = null;
            this.activeModuleTab = 'tasks';
            // Fetch the rich card (active tasks, gotchas, decisions, recent handoffs)
            this.loadModuleCard(mod.slug).catch(() => {});
        },
        createModule() {
            this.resetActive();
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
            } catch {} 
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
            const url = `/api/collab/export?format=${encodeURIComponent(format)}`;
            window.location.href = url;
        },

        // --- HELPERS ---
        formatDate(iso) { return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '---'; },
        formatDateLong(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }) : '---'; },
        formatDateShort(iso) { return iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '---'; },

        typeColor(t) {
            const map = {
                handoff: '#38bdf8', // Blue
                decision: '#34d399', // Emerald
                gotcha: '#fbbf24',   // Amber
                review: '#a78bfa',   // Purple
                proposal: '#f472b6', // Pink
                'session-note': '#94a3b8', // Slate
                changelog: '#818cf8', // Indigo
                rollup: '#60a5fa'    // Sky
            };
            return map[t] || '#94a3b8';
        },

        safeHighlight(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            let escaped = div.innerHTML;
            return escaped
                .replaceAll('[[HL]]', '<mark class="bg-accent/30 text-accent px-1 rounded">')
                .replaceAll('[[/HL]]', '</mark>');
        }
    };
}

