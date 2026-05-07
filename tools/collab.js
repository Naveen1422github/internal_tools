const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'collab-mcp', 'collab.db');

// Mirrors KIND_BY_TYPE in internal-tools/collab-mcp/src/tools/add.ts.
// Keep these in sync — the dashboard derives kind server-side so the UI
// can't desync type and kind.
const KIND_BY_TYPE = {
  handoff: 'signal',
  review: 'signal',
  proposal: 'signal',
  counter: 'signal',
  decision: 'signal',
  gotcha: 'signal',
  rollup: 'signal',
  'session-note': 'log',
  changelog: 'log',
};

// Mirrors SLUG_REGEX in internal-tools/collab-mcp/src/tools/module.ts.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error('[collab] Failed to open database:', err.message);
}

const estimateTokens = (text) => Math.ceil((text || '').length / 4);

module.exports.routes = {
  // --- ENTRIES ---
  'GET /api/collab/search': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams.get('q') || '';
    const type = url.searchParams.get('type');
    const module = url.searchParams.get('module');
    const agent = url.searchParams.get('agent');
    const kind = url.searchParams.get('kind') || 'signal';

    if (!db) return send(500, { error: 'Database not available' });

    try {
      let query = `
        SELECT e.rowid as id, e.type, e.kind, e.title, e.summary, e.module, e.agent, e.created_at,
               snippet(entries_fts, -1, '[[HL]]', '[[/HL]]', '...', 10) as snippet
        FROM entries e
        JOIN entries_fts f ON e.rowid = f.rowid
        WHERE e.deprecated = 0
      `;
      const params = [];

      if (kind !== 'any') {
        query += ` AND e.kind = ?`;
        params.push(kind);
      }
      if (type) {
        query += ` AND e.type = ?`;
        params.push(type);
      }
      if (module) {
        query += ` AND e.module = ?`;
        params.push(module);
      }
      if (agent) {
        query += ` AND e.agent = ?`;
        params.push(agent);
      }
      if (q.trim()) {
        query += ` AND entries_fts MATCH ?`;
        params.push(q);
        query += ` ORDER BY rank`;
      } else {
        query += ` ORDER BY e.created_at DESC`;
      }

      const rows = db.prepare(query + ' LIMIT 50').all(...params);
      send(200, { results: rows });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  'GET /api/collab/entry': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    try {
      const entry = db.prepare('SELECT rowid as id, * FROM entries WHERE rowid = ?').get(id);
      if (!entry) return send(404, { error: 'Not found' });
      const refs = db.prepare('SELECT ref_type, ref_value FROM refs WHERE entry_id = ?').all(id);
      send(200, { ...entry, refs });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/upsert': async (req, res, send, body) => {
    const { id, type, title, summary, description, agent, module, task_id, refs } = body;
    if (!type || !KIND_BY_TYPE[type]) return send(400, { error: `invalid type: ${type}` });
    if (type === 'rollup') return send(400, { error: 'rollup entries are system-generated; use collab.rollup' });
    if (!title || !title.trim()) return send(400, { error: 'title is required' });
    if (!summary || !summary.trim()) return send(400, { error: 'summary is required' });
    if (summary.length > 200) return send(400, { error: `summary exceeds 200 chars (got ${summary.length})` });
    const kind = KIND_BY_TYPE[type];
    try {
      const tokens = estimateTokens(description);
      let entryId = id;

      const tx = db.transaction(() => {
        if (id) {
          db.prepare(`
            UPDATE entries SET type=?, kind=?, title=?, summary=?, description=?, agent=?, module=?, task_id=?, tokens_estimate=?
            WHERE rowid=?
          `).run(type, kind, title, summary, description, agent, module, task_id, tokens, id);
          db.prepare('DELETE FROM refs WHERE entry_id = ?').run(id);
        } else {
          const result = db.prepare(`
            INSERT INTO entries (type, kind, title, summary, description, agent, module, task_id, tokens_estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(type, kind, title, summary, description, agent, module, task_id, tokens);
          entryId = result.lastInsertRowid;
        }

        if (refs && Array.isArray(refs)) {
          const stmt = db.prepare('INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)');
          for (const ref of refs) {
            stmt.run(entryId, ref.type, ref.value);
          }
        }
      });
      tx();
      send(200, { ok: true, id: entryId });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/delete': async (req, res, send, body) => {
    try {
      db.prepare('DELETE FROM entries WHERE rowid = ?').run(body.id);
      send(200, { ok: true });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  // --- TASKS ---
  'GET /api/collab/tasks': async (req, res, send) => {
    try {
      const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
      send(200, { results: rows });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/task/upsert': async (req, res, send, body) => {
    const { id, title, summary, description, status, assignee, priority, module } = body;
    try {
      if (id) {
        db.prepare(`
          UPDATE tasks SET title=?, summary=?, description=?, status=?, assignee=?, priority=?, module=?
          WHERE id=?
        `).run(title, summary, description, status, assignee, priority, module, id);
        send(200, { ok: true, id });
      } else {
        // Generate next T-NNN ID. Only consider strictly-numeric T-NNN tasks
        // so non-numeric IDs (e.g. T-STEP8, CR-001) don't poison the counter.
        const rows = db.prepare("SELECT id FROM tasks WHERE id GLOB 'T-[0-9]*'").all();
        const nums = rows
          .map(r => { const m = /^T-(\d+)$/.exec(r.id); return m ? parseInt(m[1], 10) : null; })
          .filter(n => Number.isFinite(n));
        const next = nums.length ? Math.max(...nums) + 1 : 1;
        const nextId = `T-${String(next).padStart(3, '0')}`;
        db.prepare(`
          INSERT INTO tasks (id, title, summary, description, status, assignee, priority, module)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(nextId, title, summary, description, status || 'pending', assignee, priority, module);
        send(200, { ok: true, id: nextId });
      }
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  // --- MODULES ---
  'GET /api/collab/modules': async (req, res, send) => {
    try {
      const rows = db.prepare('SELECT * FROM modules ORDER BY slug').all();
      send(200, { results: rows });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/module/upsert': async (req, res, send, body) => {
    const { slug, name, summary, description, current_goal, status } = body;
    if (!slug || !SLUG_REGEX.test(slug)) {
      return send(400, { error: `invalid slug '${slug}': must be lowercase alphanumeric or hyphens, 1-60 chars, no underscores, start with alphanumeric` });
    }
    try {
      db.prepare(`
        INSERT INTO modules (slug, name, summary, description, current_goal, status)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name=excluded.name,
          summary=excluded.summary,
          description=excluded.description,
          current_goal=excluded.current_goal,
          status=excluded.status
      `).run(slug, name, summary, description, current_goal, status || 'active');
      send(200, { ok: true, slug });
    } catch (err) {
      send(500, { error: err.message });
    }
  },

  // --- TASK ACTIONS (transition / assign / delete) ---
  'POST /api/collab/task/transition': async (req, res, send, body) => {
    const { id, status } = body;
    const allowed = ['pending', 'assigned', 'in-progress', 'review', 'done'];
    if (!id) return send(400, { error: 'id required' });
    if (!allowed.includes(status)) return send(400, { error: `status must be one of ${allowed.join(', ')}` });
    try {
      const r = db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
      if (r.changes === 0) return send(404, { error: `task ${id} not found` });
      send(200, { ok: true, id, status });
    } catch (err) { send(500, { error: err.message }); }
  },

  'POST /api/collab/task/assign': async (req, res, send, body) => {
    const { id, assignee } = body;
    const allowed = ['Claude', 'Codex', 'Gemini', 'Jules', 'User', null, ''];
    if (!id) return send(400, { error: 'id required' });
    if (assignee !== null && assignee !== '' && !['Claude', 'Codex', 'Gemini', 'Jules', 'User'].includes(assignee)) {
      return send(400, { error: `assignee must be Claude|Codex|Gemini|Jules|User or empty` });
    }
    try {
      const r = db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(assignee || null, id);
      if (r.changes === 0) return send(404, { error: `task ${id} not found` });
      send(200, { ok: true, id, assignee: assignee || null });
    } catch (err) { send(500, { error: err.message }); }
  },

  'POST /api/collab/task/delete': async (req, res, send, body) => {
    if (!body.id) return send(400, { error: 'id required' });
    try {
      db.prepare('DELETE FROM tasks WHERE id=?').run(body.id);
      send(200, { ok: true });
    } catch (err) { send(500, { error: err.message }); }
  },

  // --- MODULE ACTIONS (delete / card) ---
  'POST /api/collab/module/delete': async (req, res, send, body) => {
    if (!body.slug) return send(400, { error: 'slug required' });
    try {
      // Refuse if there are entries or tasks pinned to this module — better to surface than orphan.
      const refs = db.prepare(`
        SELECT (SELECT COUNT(*) FROM entries WHERE module=?) AS entry_count,
               (SELECT COUNT(*) FROM tasks WHERE module=?) AS task_count
      `).get(body.slug, body.slug);
      if (refs.entry_count > 0 || refs.task_count > 0) {
        return send(409, {
          error: `module '${body.slug}' has ${refs.entry_count} entries and ${refs.task_count} tasks. Reassign or delete those first.`,
          ...refs,
        });
      }
      db.prepare('DELETE FROM modules WHERE slug=?').run(body.slug);
      send(200, { ok: true });
    } catch (err) { send(500, { error: err.message }); }
  },

  'GET /api/collab/module-card': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const slug = url.searchParams.get('slug');
    if (!slug) return send(400, { error: 'slug required' });
    try {
      const module = db.prepare('SELECT slug, name, summary, description, current_goal, status, created_at, updated_at FROM modules WHERE slug=?').get(slug);
      if (!module) return send(200, { module: null, active_tasks: [], recent_decisions: [], top_gotchas: [], recent_handoffs: [] });
      const active_tasks = db.prepare(`
        SELECT id, title, status, priority, assignee FROM tasks
        WHERE module=? AND status != 'done'
        ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, updated_at DESC
      `).all(slug);
      const recent_decisions = db.prepare(`
        SELECT rowid AS id, title, summary FROM entries
        WHERE module=? AND type='decision' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const top_gotchas = db.prepare(`
        SELECT rowid AS id, title, summary FROM entries
        WHERE module=? AND type='gotcha' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const recent_handoffs = db.prepare(`
        SELECT rowid AS id, title, summary, agent, created_at FROM entries
        WHERE module=? AND type='handoff' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      send(200, { module, active_tasks, recent_decisions, top_gotchas, recent_handoffs });
    } catch (err) { send(500, { error: err.message }); }
  },

  // --- DOCTOR (mirrors collab-mcp/src/tools/doctor.ts — keep in sync) ---
  'POST /api/collab/doctor': async (req, res, send) => {
    const EXPECTED_TABLES = new Set(['entries','refs','tasks','modules','schema_migrations','entries_fts','entries_fts_config','entries_fts_data','entries_fts_docsize','entries_fts_idx','sqlite_sequence']);
    const EXPECTED_INDEXES = new Set(['idx_entries_created','idx_entries_deprecated','idx_entries_kind','idx_entries_module','idx_entries_status','idx_entries_task','idx_entries_type','idx_refs_entry','idx_refs_type','idx_refs_value','idx_tasks_assignee','idx_tasks_module','idx_tasks_status']);
    const EXPECTED_TRIGGERS = new Set(['trg_entries_fts_ad','trg_entries_fts_ai','trg_entries_fts_au','trg_entries_updated_at','trg_modules_updated_at','trg_refs_cascade_delete','trg_tasks_updated_at']);
    const schemaCheck = (name, actual, expected, label) => {
      const missing = [...expected].filter(x => !actual.has(x)).sort();
      const extra = [...actual].filter(x => !expected.has(x)).sort();
      const severity = missing.length ? 'error' : extra.length ? 'warn' : 'ok';
      const detail = (!missing.length && !extra.length) ? `${expected.size} expected ${label} present` : `${missing.length} missing, ${extra.length} extra ${label}`;
      const items = (!missing.length && !extra.length) ? undefined : [...missing.map(m=>`missing:${m}`), ...extra.map(e=>`extra:${e}`)];
      return { name, severity, detail, items };
    };
    try {
      const checks = [];
      const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')`).all().map(r=>r.name));
      checks.push(schemaCheck('schema.tables', tables, EXPECTED_TABLES, 'tables'));
      const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'`).all().map(r=>r.name));
      checks.push(schemaCheck('schema.indexes', indexes, EXPECTED_INDEXES, 'indexes'));
      const triggers = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map(r=>r.name));
      checks.push(schemaCheck('schema.triggers', triggers, EXPECTED_TRIGGERS, 'triggers'));
      const orphanTaskRefs = db.prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type='task' AND ref_value NOT IN (SELECT id FROM tasks)`).all();
      checks.push({ name: 'data.orphan_refs.task', severity: orphanTaskRefs.length ? 'warn' : 'ok', detail: orphanTaskRefs.length ? `${orphanTaskRefs.length} orphan task ref(s)` : 'no orphan task refs', items: orphanTaskRefs.length ? orphanTaskRefs.map(r=>`E-${String(r.entry_id).padStart(5,'0')} -> ${r.ref_value}`) : undefined });
      const orphanEntryRefs = db.prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type='entry' AND CAST(ref_value AS INTEGER) NOT IN (SELECT id FROM entries)`).all();
      checks.push({ name: 'data.orphan_refs.entry', severity: orphanEntryRefs.length ? 'warn' : 'ok', detail: orphanEntryRefs.length ? `${orphanEntryRefs.length} orphan entry ref(s)` : 'no orphan entry refs', items: orphanEntryRefs.length ? orphanEntryRefs.map(r=>`E-${String(r.entry_id).padStart(5,'0')} -> E-${r.ref_value}`) : undefined });
      const orphanModuleEntries = db.prepare(`SELECT id FROM entries WHERE module IS NOT NULL AND module NOT IN (SELECT slug FROM modules) ORDER BY id`).all();
      checks.push({ name: 'data.orphan_module.entries', severity: orphanModuleEntries.length ? 'warn' : 'ok', detail: orphanModuleEntries.length ? `${orphanModuleEntries.length} entries with unknown module` : 'no orphan module entries', items: orphanModuleEntries.length ? orphanModuleEntries.map(r=>r.id) : undefined });
      const orphanTaskEntries = db.prepare(`SELECT id FROM entries WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks) ORDER BY id`).all();
      checks.push({ name: 'data.orphan_task.entries', severity: orphanTaskEntries.length ? 'warn' : 'ok', detail: orphanTaskEntries.length ? `${orphanTaskEntries.length} entries with unknown task_id` : 'no orphan task entries', items: orphanTaskEntries.length ? orphanTaskEntries.map(r=>r.id) : undefined });
      const entryCount = db.prepare('SELECT COUNT(*) AS c FROM entries').get().c;
      const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM entries_fts').get().c;
      const parityOk = entryCount === ftsCount;
      checks.push({ name: 'fts.count_parity', severity: parityOk ? 'ok' : 'error', detail: `entries=${entryCount}, entries_fts=${ftsCount}` });
      checks.push({ name: 'fts.rebuild_hint', severity: parityOk ? 'ok' : 'warn', detail: parityOk ? 'fts index in sync' : `Run: INSERT INTO entries_fts(entries_fts) VALUES('rebuild');` });
      send(200, { ok: checks.every(c => c.severity !== 'error'), checks });
    } catch (err) { send(500, { error: err.message }); }
  },

  // --- EXPORT (json | markdown) ---
  'GET /api/collab/export': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const moduleFilter = url.searchParams.get('module');
    const since = url.searchParams.get('since'); // ISO date or sqlite-friendly
    if (!['json', 'markdown'].includes(format)) return send(400, { error: 'format must be json or markdown' });
    try {
      let q = 'SELECT rowid AS id, type, kind, title, summary, description, status, agent, module, task_id, created_at FROM entries WHERE deprecated=0';
      const params = [];
      if (moduleFilter) { q += ' AND module=?'; params.push(moduleFilter); }
      if (since) { q += ' AND created_at >= ?'; params.push(since); }
      q += ' ORDER BY created_at DESC';
      const entries = db.prepare(q).all(...params);
      for (const e of entries) {
        e.refs = db.prepare('SELECT ref_type, ref_value FROM refs WHERE entry_id=?').all(e.id);
      }
      if (format === 'json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="collab-export-${new Date().toISOString().slice(0,10)}.json"`,
        });
        res.end(JSON.stringify({ exported_at: new Date().toISOString(), filter: { module: moduleFilter, since }, count: entries.length, entries }, null, 2));
        return;
      }
      // markdown
      const lines = [`# Collab export — ${new Date().toISOString().slice(0,16)}`, ''];
      lines.push(`**Filter:** module=${moduleFilter || '(any)'}, since=${since || '(any)'}`);
      lines.push(`**Count:** ${entries.length}`, '');
      for (const e of entries) {
        lines.push(`## E-${String(e.id).padStart(5,'0')} — ${e.title}`);
        lines.push(`- type: ${e.type} | agent: ${e.agent || '?'} | module: ${e.module || '-'} | task: ${e.task_id || '-'} | ${e.created_at}`);
        lines.push('', e.summary || '', '');
        if (e.description) lines.push(e.description, '');
        if (e.refs && e.refs.length) {
          lines.push('**Refs:**');
          for (const r of e.refs) lines.push(`- ${r.ref_type}: ${r.ref_value}`);
          lines.push('');
        }
        lines.push('---', '');
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="collab-export-${new Date().toISOString().slice(0,10)}.md"`,
      });
      res.end(lines.join('\n'));
    } catch (err) { send(500, { error: err.message }); }
  },
};
