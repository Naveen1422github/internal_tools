import http from 'node:http';
import { getDb, estimateTokens, KIND_BY_TYPE, CATEGORY_BY_TYPE, SLUG_REGEX, validateEntryInput, buildFtsMatch } from '@collab-mcp/core';

const db = getDb();

export function runSearch(db: any, { q = '', type, module, agent, kind = 'signal', category, since }: any = {}) {
  if (!db) throw new Error('Database not available');

  let query = `
    SELECT e.rowid as id, e.type, e.kind, e.category, e.title, e.summary, e.module, e.agent, e.created_at,
           snippet(entries_fts, -1, '[[HL]]', '[[/HL]]', '...', 10) as snippet
    FROM entries e
    JOIN entries_fts f ON e.rowid = f.rowid
    WHERE e.deprecated = 0
  `;
  const params: any[] = [];

  if (kind !== 'any') {
    query += ` AND e.kind = ?`;
    params.push(kind);
  }
  if (type) {
    query += ` AND e.type = ?`;
    params.push(type);
  }
  if (module) {
    query += ` AND e.id IN (SELECT entry_id FROM entry_modules WHERE module = ?)`;
    params.push(module);
  }
  if (agent) {
    query += ` AND e.agent = ?`;
    params.push(agent);
  }
  if (category) {
    query += ` AND e.category = ?`;
    params.push(category);
  }
  if (since) {
    query += ` AND e.created_at >= ?`;
    params.push(since);
  }
  // Prefix-match + escape via the shared core helper so "cus" -> "cus"* recalls
  // partial words and special chars can't throw FTS5 syntax errors.
  const ftsAnd = q.trim() ? buildFtsMatch(q, 'AND') : null;
  let matchParamIndex = -1;
  if (ftsAnd) {
    matchParamIndex = params.length;
    query += ` AND entries_fts MATCH ?`;
    params.push(ftsAnd);
    query += ` ORDER BY rank`;
  } else {
    query += ` ORDER BY e.created_at DESC`;
  }

  const stmt = db.prepare(query + ' LIMIT 50');
  let rows = stmt.all(...params);

  // Recall fallback: if the precise AND match found nothing, retry OR-joined so odd
  // phrasings still surface the closest entries (single-token queries are unaffected).
  if (rows.length === 0 && ftsAnd) {
    const ftsOr = buildFtsMatch(q, 'OR');
    if (ftsOr && ftsOr !== ftsAnd) {
      params[matchParamIndex] = ftsOr;
      rows = stmt.all(...params);
    }
  }
  return rows;
}

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: (status: number, body: any) => void, body?: any) => Promise<any> | any> = {
  // --- ENTRIES ---
  'GET /api/collab/search': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const q = url.searchParams.get('q') || '';
    const type = url.searchParams.get('type');
    const module = url.searchParams.get('module');
    const agent = url.searchParams.get('agent');
    const kind = url.searchParams.get('kind') || 'signal';
    const category = url.searchParams.get('category');
    const since = url.searchParams.get('since');

    if (!db) return send(500, { error: 'Database not available' });

    try {
      const rows = runSearch(db, { q, type, module, agent, kind, category, since });
      send(200, { results: rows });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'GET /api/collab/stats': async (req, res, send) => {
    try {
      const total = (db.prepare('SELECT COUNT(*) AS c FROM entries WHERE deprecated = 0').get() as any).c;
      const rowsToMap = (rows: any[], key: string) => Object.fromEntries(rows.map((r) => [r[key], r.c]));
      const by_category = rowsToMap(
        db.prepare(`SELECT COALESCE(category,'(none)') AS category, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY category`).all(),
        'category'
      );
      const by_type = rowsToMap(
        db.prepare(`SELECT type, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY type`).all(),
        'type'
      );
      const by_status = rowsToMap(
        db.prepare(`SELECT status, COUNT(*) AS c FROM entries WHERE deprecated=0 GROUP BY status`).all(),
        'status'
      );
      const top_modules = db.prepare(`
        SELECT module, COUNT(*) AS count
        FROM entry_modules GROUP BY module ORDER BY count DESC, module ASC LIMIT 10
      `).all();
      const recent = db.prepare(`
        SELECT rowid AS id, type, category, title, summary, agent, module, created_at
        FROM entries WHERE deprecated=0 ORDER BY created_at DESC LIMIT 10
      `).all();
      send(200, { total, by_category, by_type, by_status, top_modules, recent });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  'GET /api/collab/dispatches': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const agent = url.searchParams.get('agent');
    const moduleFilter = url.searchParams.get('module');

    if (!db) return send(500, { error: 'Database not available' });

    try {
      let query = `
        SELECT * FROM dispatches
        WHERE 1=1
      `;
      const params: any[] = [];
      if (agent) {
        query += ` AND agent = ?`;
        params.push(agent);
      }
      if (moduleFilter) {
        query += ` AND module = ?`;
        params.push(moduleFilter);
      }
      query += ` ORDER BY created_at DESC LIMIT 100`;

      const rows = db.prepare(query).all(...params);
      
      // Compute totals for analytics
      const totals = db.prepare(`
        SELECT 
          COUNT(*) as count,
          SUM(prompt_tokens_est) as total_prompt,
          SUM(output_tokens) as total_output,
          SUM(total_tokens) as total_raw,
          SUM(wall_clock_ms) as total_time
        FROM dispatches
      `).get();

      send(200, { results: rows, stats: totals });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'GET /api/collab/entry': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    try {
      const entry: any = db.prepare('SELECT rowid as id, * FROM entries WHERE rowid = ?').get(id);
      if (!entry) return send(404, { error: 'Not found' });
      const refs = db.prepare('SELECT ref_type, ref_value FROM refs WHERE entry_id = ?').all(id);
      const modules = db.prepare('SELECT module FROM entry_modules WHERE entry_id = ? ORDER BY is_primary DESC, module ASC').all(id).map((r: any) => r.module);
      send(200, { ...entry, refs, modules });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/upsert': async (req, res, send, body) => {
    const { id, type, title, summary, description, agent, module, modules, category, task_id, refs } = body;
    const v = validateEntryInput({ type, title, summary, category });
    if (!v.ok) return send(400, { error: v.errors[0] });
    const kind = KIND_BY_TYPE[type as keyof typeof KIND_BY_TYPE];
    const resolvedCategory = v.category!;

    const moduleCandidates = [
      ...(module ? [module] : []),
      ...(Array.isArray(modules) ? modules : []),
    ];
    const orderedModules: string[] = [];
    for (const m of moduleCandidates) {
      const cleaned = typeof m === 'string' ? m.trim() : '';
      if (cleaned && !orderedModules.includes(cleaned)) orderedModules.push(cleaned);
    }
    const primaryModule = orderedModules.length ? orderedModules[0] : null;
    try {
      const tokens = estimateTokens(description);
      let entryId = id;

      const tx = db.transaction(() => {
        if (id) {
          db.prepare(`
            UPDATE entries SET type=?, kind=?, title=?, summary=?, description=?, agent=?, module=?, task_id=?, tokens_estimate=?, category=?
            WHERE rowid=?
          `).run(type, kind, title, summary, description, agent, primaryModule, task_id, tokens, resolvedCategory, id);
          db.prepare('DELETE FROM refs WHERE entry_id = ?').run(id);
          db.prepare('DELETE FROM entry_modules WHERE entry_id = ?').run(id);
        } else {
          const result = db.prepare(`
            INSERT INTO entries (type, kind, title, summary, description, agent, module, task_id, tokens_estimate, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(type, kind, title, summary, description, agent, primaryModule, task_id, tokens, resolvedCategory);
          entryId = result.lastInsertRowid;
        }

        if (orderedModules.length > 0) {
          const stmt = db.prepare('INSERT OR IGNORE INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, ?)');
          for (const moduleSlug of orderedModules) {
            stmt.run(entryId, moduleSlug, moduleSlug === primaryModule ? 1 : 0);
          }
        }

        if (refs && Array.isArray(refs)) {
          const stmt = db.prepare('INSERT INTO refs (entry_id, ref_type, ref_value) VALUES (?, ?, ?)');
          for (const ref of refs) {
            stmt.run(entryId, ref.ref_type || ref.type, ref.ref_value || ref.value);
          }
        }
      });
      tx();
      send(200, { ok: true, id: entryId });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/delete': async (req, res, send, body) => {
    try {
      db.prepare('DELETE FROM entries WHERE rowid = ?').run(body.id);
      send(200, { ok: true });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/supersede': async (req, res, send, body) => {
    const { ids, by } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(400, { error: "supersede requires a non-empty 'ids' array" });
    }
    if (typeof by !== 'number') {
      return send(400, { error: "'by' must be a numeric entry id" });
    }
    if (ids.includes(by)) {
      return send(400, { error: "'by' cannot be one of the superseded 'ids'" });
    }
    try {
      const byRow = db.prepare('SELECT id FROM entries WHERE id = ?').get(by);
      if (!byRow) return send(400, { error: `'by' entry ${by} does not exist` });

      const uniqueIds = [...new Set(ids)];
      const placeholders = uniqueIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM entries WHERE id IN (${placeholders})`).all(...uniqueIds);
      const foundSet = new Set(found.map((r: any) => r.id));
      const missing = uniqueIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        return send(400, { error: `these ids do not exist: ${missing.join(', ')}` });
      }

      const update = db.prepare('UPDATE entries SET superseded_by = ?, deprecated = 1 WHERE id = ?');
      const tx = db.transaction((targetIds: any[]) => { for (const id of targetIds) update.run(by, id); });
      tx(uniqueIds);
      send(200, { ok: true, superseded: uniqueIds, by });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  'POST /api/collab/entry/reassign-module': async (req, res, send, body) => {
    const { ids, module } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(400, { error: "reassign requires a non-empty 'ids' array" });
    }
    if (!module || typeof module !== 'string') {
      return send(400, { error: "'module' (target slug) is required" });
    }
    try {
      const exists = db.prepare('SELECT slug FROM modules WHERE slug = ?').get(module);
      if (!exists) return send(400, { error: `target module '${module}' does not exist` });

      const uniqueIds = [...new Set(ids)];
      const setPrimary = db.prepare('UPDATE entries SET module = ? WHERE id = ?');
      const clearOld = db.prepare('DELETE FROM entry_modules WHERE entry_id = ? AND is_primary = 1');
      // Upsert: if the entry was already a (secondary) member of the target module,
      // promote that existing row to primary instead of silently ignoring it.
      const addJoin = db.prepare(`
        INSERT INTO entry_modules (entry_id, module, is_primary) VALUES (?, ?, 1)
        ON CONFLICT(entry_id, module) DO UPDATE SET is_primary = 1
      `);
      let updated = 0;
      const tx = db.transaction((targetIds: any[]) => {
        for (const id of targetIds) {
          const r = setPrimary.run(module, id);
          if (r.changes > 0) {
            clearOld.run(id);
            addJoin.run(id, module);
            updated += 1;
          }
        }
      });
      tx(uniqueIds);
      send(200, { ok: true, updated, module });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- TASKS ---
  'GET /api/collab/tasks': async (req, res, send) => {
    try {
      const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
      send(200, { results: rows });
    } catch (err: any) {
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
          .map((r: any) => { const m = /^T-(\d+)$/.exec(r.id); return m ? parseInt(m[1], 10) : null; })
          .filter((n: any) => Number.isFinite(n)) as number[];
        const next = nums.length ? Math.max(...nums) + 1 : 1;
        const nextId = `T-${String(next).padStart(3, '0')}`;
        db.prepare(`
          INSERT INTO tasks (id, title, summary, description, status, assignee, priority, module)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(nextId, title, summary, description, status || 'pending', assignee, priority, module);
        send(200, { ok: true, id: nextId });
      }
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  // --- MODULES ---
  'GET /api/collab/modules': async (req, res, send) => {
    try {
      const rows = db.prepare('SELECT * FROM modules ORDER BY slug').all();
      send(200, { results: rows });
    } catch (err: any) {
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
    } catch (err: any) {
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
    } catch (err: any) { send(500, { error: err.message }); }
  },

  'POST /api/collab/task/assign': async (req, res, send, body) => {
    const { id, assignee } = body;
    if (!id) return send(400, { error: 'id required' });
    if (assignee !== null && assignee !== '' && !['Claude', 'Codex', 'Gemini', 'Jules', 'User'].includes(assignee)) {
      return send(400, { error: `assignee must be Claude|Codex|Gemini|Jules|User or empty` });
    }
    try {
      const r = db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(assignee || null, id);
      if (r.changes === 0) return send(404, { error: `task ${id} not found` });
      send(200, { ok: true, id, assignee: assignee || null });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  'POST /api/collab/task/delete': async (req, res, send, body) => {
    if (!body.id) return send(400, { error: 'id required' });
    try {
      db.prepare('DELETE FROM tasks WHERE id=?').run(body.id);
      send(200, { ok: true });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- MODULE ACTIONS (delete / card) ---
  'POST /api/collab/module/delete': async (req, res, send, body) => {
    if (!body.slug) return send(400, { error: 'slug required' });
    try {
      // Refuse if there are entries or tasks pinned to this module — better to surface than orphan.
      const refs: any = db.prepare(`
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
    } catch (err: any) { send(500, { error: err.message }); }
  },

  'GET /api/collab/module-card': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const slug = url.searchParams.get('slug');
    if (!slug) return send(400, { error: 'slug required' });
    try {
      const module: any = db.prepare('SELECT slug, name, summary, description, current_goal, status, created_at, updated_at FROM modules WHERE slug=?').get(slug);
      if (!module) return send(200, { module: null, active_tasks: [], recent_decisions: [], top_gotchas: [], recent_handoffs: [] });
      const active_tasks = db.prepare(`
        SELECT id, title, status, priority, assignee FROM tasks
        WHERE module=? AND status != 'done'
        ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, updated_at DESC
      `).all(slug);
      const recent_decisions = db.prepare(`
        SELECT rowid AS id, title, summary FROM entries
        WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?) AND type='decision' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const top_gotchas = db.prepare(`
        SELECT rowid AS id, title, summary FROM entries
        WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?) AND type='gotcha' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const recent_handoffs = db.prepare(`
        SELECT rowid AS id, title, summary, agent, created_at FROM entries
        WHERE id IN (SELECT entry_id FROM entry_modules WHERE module = ?) AND type='handoff' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      send(200, { module, active_tasks, recent_decisions, top_gotchas, recent_handoffs });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- DOCTOR (mirrors collab-mcp/src/tools/doctor.ts — keep in sync) ---
  'POST /api/collab/doctor': async (req, res, send) => {
    const EXPECTED_TABLES = new Set(['entries','refs','tasks','modules','dispatches','entry_modules','schema_migrations','entries_fts','entries_fts_config','entries_fts_data','entries_fts_docsize','entries_fts_idx','sqlite_sequence']);
    const EXPECTED_INDEXES = new Set(['idx_entries_created','idx_entries_deprecated','idx_entries_kind','idx_entries_module','idx_entries_status','idx_entries_task','idx_entries_type','idx_entries_category','idx_entries_superseded','idx_entry_modules_module','idx_entry_modules_entry','idx_refs_entry','idx_refs_type','idx_refs_value','idx_tasks_assignee','idx_tasks_module','idx_tasks_status','idx_dispatches_agent','idx_dispatches_created','idx_dispatches_entry','idx_dispatches_module']);
    const EXPECTED_TRIGGERS = new Set(['trg_entries_fts_ad','trg_entries_fts_ai','trg_entries_fts_au','trg_entries_updated_at','trg_modules_updated_at','trg_refs_cascade_delete','trg_tasks_updated_at','trg_entry_modules_cascade_delete','trg_dispatches_updated_at','trg_dispatches_updated_at_insert']);
    // Migration 0005 (staged): objects that exist only once 0005 has been applied.
    // trg_entries_updated_at / trg_entries_fts_au are re-created under their same
    // names by 0005, so they stay in the base EXPECTED_TRIGGERS above, not here.
    const EXPECTED_TABLES_0005 = new Set(['entry_revisions']);
    const EXPECTED_INDEXES_0005 = new Set(['idx_entries_ulid','idx_refs_entry_ulid','idx_refs_target_ulid','idx_entry_modules_entry_ulid','idx_entry_revisions_entry']);
    const EXPECTED_TRIGGERS_0005 = new Set(['trg_refs_fill_ulids','trg_entry_modules_fill_ulid','trg_entries_fill_superseded_ulid','trg_entries_revision']);
    const union = (a: Set<string>, b: Set<string>) => new Set([...a, ...b]);
    const schemaCheck = (name: string, actual: Set<string>, expected: Set<string>, label: string) => {
      const missing = [...expected].filter(x => !actual.has(x)).sort();
      const extra = [...actual].filter(x => !expected.has(x)).sort();
      const severity = missing.length ? 'error' : extra.length ? 'warn' : 'ok';
      const detail = (!missing.length && !extra.length) ? `${expected.size} expected ${label} present` : `${missing.length} missing, ${extra.length} extra ${label}`;
      const items = (!missing.length && !extra.length) ? undefined : [...missing.map(m=>`missing:${m}`), ...extra.map(e=>`extra:${e}`)];
      return { name, severity, detail, items };
    };
    try {
      let has0005 = false;
      try {
        has0005 = !!db.prepare(`SELECT 1 FROM schema_migrations WHERE version = '0005_ulid_expand'`).get();
      } catch { has0005 = false; }
      const expectedTables = has0005 ? union(EXPECTED_TABLES, EXPECTED_TABLES_0005) : EXPECTED_TABLES;
      const expectedIndexes = has0005 ? union(EXPECTED_INDEXES, EXPECTED_INDEXES_0005) : EXPECTED_INDEXES;
      const expectedTriggers = has0005 ? union(EXPECTED_TRIGGERS, EXPECTED_TRIGGERS_0005) : EXPECTED_TRIGGERS;
      const checks: any[] = [];
      const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')`).all().map((r: any)=>r.name));
      checks.push(schemaCheck('schema.tables', tables, expectedTables, 'tables'));
      const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'`).all().map((r: any)=>r.name));
      checks.push(schemaCheck('schema.indexes', indexes, expectedIndexes, 'indexes'));
      const triggers = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map((r: any)=>r.name));
      checks.push(schemaCheck('schema.triggers', triggers, expectedTriggers, 'triggers'));
      const orphanTaskRefs = db.prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type='task' AND ref_value NOT IN (SELECT id FROM tasks)`).all();
      checks.push({ name: 'data.orphan_refs.task', severity: orphanTaskRefs.length ? 'warn' : 'ok', detail: orphanTaskRefs.length ? `${orphanTaskRefs.length} orphan task ref(s)` : 'no orphan task refs', items: orphanTaskRefs.length ? orphanTaskRefs.map((r: any)=>`E-${String(r.entry_id).padStart(5,'0')} -> ${r.ref_value}`) : undefined });
      const orphanEntryRefs = db.prepare(`SELECT entry_id, ref_value FROM refs WHERE ref_type='entry' AND CAST(ref_value AS INTEGER) NOT IN (SELECT id FROM entries)`).all();
      checks.push({ name: 'data.orphan_refs.entry', severity: orphanEntryRefs.length ? 'warn' : 'ok', detail: orphanEntryRefs.length ? `${orphanEntryRefs.length} orphan entry ref(s)` : 'no orphan entry refs', items: orphanEntryRefs.length ? orphanEntryRefs.map((r: any)=>`E-${String(r.entry_id).padStart(5,'0')} -> E-${r.ref_value}`) : undefined });
      const orphanModuleEntries = db.prepare(`SELECT id FROM entries WHERE module IS NOT NULL AND module NOT IN (SELECT slug FROM modules) ORDER BY id`).all();
      checks.push({ name: 'data.orphan_module.entries', severity: orphanModuleEntries.length ? 'warn' : 'ok', detail: orphanModuleEntries.length ? `${orphanModuleEntries.length} entries with unknown module` : 'no orphan module entries', items: orphanModuleEntries.length ? orphanModuleEntries.map((r: any)=>r.id) : undefined });
      const orphanTaskEntries = db.prepare(`SELECT id FROM entries WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks) ORDER BY id`).all();
      checks.push({ name: 'data.orphan_task.entries', severity: orphanTaskEntries.length ? 'warn' : 'ok', detail: orphanTaskEntries.length ? `${orphanTaskEntries.length} entries with unknown task_id` : 'no orphan task entries', items: orphanTaskEntries.length ? orphanTaskEntries.map((r: any)=>r.id) : undefined });
      const danglingSuperseded = db.prepare(`SELECT id, superseded_by FROM entries WHERE superseded_by IS NOT NULL AND superseded_by NOT IN (SELECT id FROM entries) ORDER BY id`).all();
      checks.push({ name: 'data.dangling_superseded', severity: danglingSuperseded.length ? 'warn' : 'ok', detail: danglingSuperseded.length ? `${danglingSuperseded.length} entries with dangling superseded_by` : 'no dangling superseded_by', items: danglingSuperseded.length ? danglingSuperseded.map((r: any)=>`E-${String(r.id).padStart(5,'0')} -> E-${String(r.superseded_by).padStart(5,'0')}`) : undefined });
      const entriesWithoutModule = db.prepare(`SELECT id FROM entries WHERE deprecated = 0 AND id NOT IN (SELECT entry_id FROM entry_modules) ORDER BY id`).all();
      checks.push({ name: 'data.entries_without_module', severity: entriesWithoutModule.length ? 'warn' : 'ok', detail: entriesWithoutModule.length ? `${entriesWithoutModule.length} non-deprecated entries with no module (informational)` : 'all non-deprecated entries have at least one module', items: entriesWithoutModule.length ? entriesWithoutModule.map((r: any)=>r.id) : undefined });
      const entryCount = (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as any).c;
      const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM entries_fts').get() as any).c;
      const parityOk = entryCount === ftsCount;
      checks.push({ name: 'fts.count_parity', severity: parityOk ? 'ok' : 'error', detail: `entries=${entryCount}, entries_fts=${ftsCount}` });
      checks.push({ name: 'fts.rebuild_hint', severity: parityOk ? 'ok' : 'warn', detail: parityOk ? 'fts index in sync' : `Run: INSERT INTO entries_fts(entries_fts) VALUES('rebuild');` });
      send(200, { ok: checks.every(c => c.severity !== 'error'), checks });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- EXPORT (json | markdown) ---
  'GET /api/collab/export': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const moduleFilter = url.searchParams.get('module');
    const since = url.searchParams.get('since'); // ISO date or sqlite-friendly
    if (!['json', 'markdown'].includes(format)) return send(400, { error: 'format must be json or markdown' });
    try {
      let q = 'SELECT rowid AS id, type, kind, category, title, summary, description, status, agent, module, task_id, superseded_by, created_at FROM entries WHERE deprecated=0';
      const params: any[] = [];
      if (moduleFilter) { q += ' AND id IN (SELECT entry_id FROM entry_modules WHERE module=?)'; params.push(moduleFilter); }
      if (since) { q += ' AND created_at >= ?'; params.push(since); }
      q += ' ORDER BY created_at DESC';
      const entries = db.prepare(q).all(...params) as any[];
      for (const e of entries) {
        e.refs = db.prepare('SELECT ref_type, ref_value FROM refs WHERE entry_id=?').all(e.id);
        e.modules = db.prepare('SELECT module FROM entry_modules WHERE entry_id=? ORDER BY is_primary DESC, module ASC').all(e.id).map((r: any) => r.module);
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
        lines.push(`- type: ${e.type} | category: ${e.category || '-'} | agent: ${e.agent || '?'} | modules: ${(e.modules || []).join(', ') || e.module || '-'} | task: ${e.task_id || '-'} | ${e.created_at}`);
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
    } catch (err: any) { send(500, { error: err.message }); }
  },
};
