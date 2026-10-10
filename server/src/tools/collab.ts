import http from 'node:http';
import {
  getDb, SLUG_REGEX, validateEntryInput, buildFtsMatch,
  addEntry, addEntryAsync, deleteEntry, supersede, doctor,
  editEntry, EntryNotFoundError, reassignModule, upsertModule, deleteModule,
  liveEntry, ftsJoin, readSyncOverview, NeedsMergeError, formatEntryRef,
  getEntryByUlid, isUlid, getEntryByRef, parseNoteRef, hasSeries, type NoteRef,
} from '@collab-mcp/core';

const db = getDb();

// Stage B1: a note number in a query or body. An integer (or a bare "760")
// means the E series; strings like "SH-12" name a project note.
export const REF_FORMS = '760 (= E-00760), #760, E-760, E-00760, or a project note like SH-12';
export function parseRefParam(v: unknown): NoteRef | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? { series: 'E', id: v } : null;
  if (typeof v === 'string') return parseNoteRef(v);
  return null;
}
const refKey = (r: NoteRef) => `${r.series}:${r.id}`;
/** The series column, or 'E' on a notebook from before migration 0009. */
const seriesCol = (alias = '') => (hasSeries(db) ? `${alias}series` : `'E' AS series`);

export function runSearch(db: any, { q = '', type, module, agent, kind = 'signal', category, since }: any = {}) {
  if (!db) throw new Error('Database not available');

  let query = `
    SELECT e.id, ${hasSeries(db) ? 'e.series' : `'E' AS series`}, e.type, e.kind, e.category, e.title, e.summary, e.module, e.agent, e.created_at,
           snippet(entries_fts, -1, '[[HL]]', '[[/HL]]', '...', 10) as snippet
    FROM entries_fts
    ${ftsJoin(db, 'e')}
    WHERE e.deprecated = 0 AND ${liveEntry(db, 'e')}
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
    query += ` AND e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)`;
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
      const live = liveEntry(db, 'entries');
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE deprecated = 0 AND ${live}`).get() as any).c;
      const rowsToMap = (rows: any[], key: string) => Object.fromEntries(rows.map((r) => [r[key], r.c]));
      const by_category = rowsToMap(
        db.prepare(`SELECT COALESCE(category,'(none)') AS category, COUNT(*) AS c FROM entries WHERE deprecated=0 AND ${live} GROUP BY category`).all(),
        'category'
      );
      const by_type = rowsToMap(
        db.prepare(`SELECT type, COUNT(*) AS c FROM entries WHERE deprecated=0 AND ${live} GROUP BY type`).all(),
        'type'
      );
      const by_status = rowsToMap(
        db.prepare(`SELECT status, COUNT(*) AS c FROM entries WHERE deprecated=0 AND ${live} GROUP BY status`).all(),
        'status'
      );
      const top_modules = db.prepare(`
        SELECT em.module AS module, COUNT(*) AS count
        FROM entry_modules em JOIN entries e ON e.ulid = em.entry_ulid
        WHERE ${liveEntry(db, 'e')}
        GROUP BY em.module ORDER BY count DESC, em.module ASC LIMIT 10
      `).all();
      const recent = db.prepare(`
        SELECT id, ${seriesCol()}, type, category, title, summary, agent, module, created_at
        FROM entries WHERE deprecated=0 AND ${live} ORDER BY created_at DESC LIMIT 10
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
      // From 0009 a dispatch follows its note by ULID: entry_series says which
      // series its entry_id belongs to (SH-3 vs E-00003).
      let query = hasSeries(db)
        ? `
        SELECT d.*, (SELECT e.series FROM entries e WHERE e.ulid = d.entry_ulid) AS entry_series
        FROM dispatches d
        WHERE 1=1
      `
        : `
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
    const ulid = url.searchParams.get('ulid');
    const idParam = url.searchParams.get('id');
    if (ulid === null && idParam === null) return send(400, { error: 'id or ulid is required' });
    if (ulid !== null && !isUlid(ulid)) return send(400, { error: 'ulid is not a ULID' });
    try {
      // Core read: a tombstoned entry is still returned, with deleted_at set (D5b).
      // A link is followed by its target's ULID (J17); id stays for typed numbers.
      let entry;
      if (ulid !== null) entry = getEntryByUlid(db, ulid);
      else {
        const ref = parseRefParam(idParam);
        if (!ref) return send(400, { error: `id must be a note number: ${REF_FORMS}` });
        entry = getEntryByRef(db, ref);
      }
      if (!entry) return send(404, { error: 'Not found' });
      send(200, entry);
    } catch (err: any) {
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/upsert': async (req, res, send, body) => {
    const { id, type, title, summary, description, agent, module, modules, category, task_id, refs } = body;
    const v = validateEntryInput({ type, title, summary, category });
    if (!v.ok) return send(400, { error: v.errors[0] });
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
      const normRefs = (Array.isArray(refs) ? refs : []).map((r: any) => ({
        ref_type: r.ref_type || r.type,
        ref_value: r.ref_value || r.value,
      }));

      if (!id) {
        // Create: core owns id/ulid/author/links at every schema level.
        const { id: newId, series, ulid } = await addEntryAsync(db, {
          type, title, summary, description, agent: agent || undefined,
          module: primaryModule ?? undefined, modules: orderedModules, category: resolvedCategory as any,
          task_id: task_id || undefined, refs: normRefs,
        });
        // Stage C: id null = saved pending; reach it by ulid until the courier numbers it.
        return send(200, { ok: true, id: newId, series, pending: newId === null, ulid });
      }

      // Edit: core resolves the E-number to its owner and writes by the level's
      // real key, with a revision (moved from here, collab E-720).
      const ref = parseRefParam(id);
      if (!ref) return send(400, { error: `id must be a note number: ${REF_FORMS}` });
      const r = editEntry(db, {
        id: ref.id, series: ref.series, type, title, summary, description, agent,
        modules: orderedModules, category: resolvedCategory, task_id, refs: normRefs,
      });
      send(200, { ok: true, id: r.id });
    } catch (err: any) {
      if (err instanceof EntryNotFoundError) return send(404, { error: err.message });
      if (err instanceof NeedsMergeError) return send(409, { error: err.message }); // V9: settle it on /merge/:id
      send(500, { error: err.message });
    }
  },

  'POST /api/collab/entry/delete': async (req, res, send, body) => {
    try {
      // tombstone at 0006, hard delete before (D5a). A bare number = E (stage B1).
      const ref = typeof body?.id === 'string' ? parseRefParam(body.id) : null;
      if (typeof body?.id === 'string' && !ref) return send(400, { error: `id must be a note number: ${REF_FORMS}` });
      const r = ref ? deleteEntry(db, ref.id, ref.series) : deleteEntry(db, Number(body?.id));
      send(200, { ok: true, ...r });
    } catch (err: any) {
      const status = /no entry found/.test(err.message) ? 404
        : /must be a positive integer/.test(err.message) ? 400
        : 500;
      send(status, { error: err.message });
    }
  },

  'POST /api/collab/entry/supersede': async (req, res, send, body) => {
    const { ids, by } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(400, { error: "supersede requires a non-empty 'ids' array" });
    }
    const byRef = parseRefParam(by);
    if (!byRef) {
      return send(400, { error: "'by' must be a numeric entry id" });
    }
    const idRefs = ids.map(parseRefParam);
    if (idRefs.some((r) => r === null)) {
      return send(400, { error: `every id must be a note number: ${REF_FORMS}` });
    }
    if (idRefs.some((r) => refKey(r!) === refKey(byRef))) {
      return send(400, { error: "'by' cannot be one of the superseded 'ids'" });
    }
    try {
      const uniqueIds = [...new Map(idRefs.map((r) => [refKey(r!), r!])).values()];
      const r = supersede(db, { ids: uniqueIds, by: byRef });
      send(200, { ok: true, superseded: r.superseded, by: r.by });
    } catch (err: any) {
      // Core: "'by' entry E-… does not exist" / "the following 'ids' do not exist: …".
      const status = /does not exist|do not exist|cannot be one of/.test(err.message) ? 400 : 500;
      send(status, { error: err.message });
    }
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
      // Numbers stay numbers (E); strings like "SH-12" name a project note (stage B1).
      const refs = ids.map((v: unknown) => (typeof v === 'string' ? parseRefParam(v) : v)) as Array<number | NoteRef>;
      if (refs.some((r: unknown) => r === null)) return send(400, { error: `every id must be a note number: ${REF_FORMS}` });
      const { updated } = reassignModule(db, refs, module);
      send(200, { ok: true, updated, module });
    } catch (err: any) {
      send(/does not exist/.test(err.message) ? 400 : 500, { error: err.message });
    }
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
      // Sharing on: each module says whether it goes to the team (absent when off).
      const overview = readSyncOverview(db);
      const shared = overview.enabled ? new Set(overview.sharedModules) : null;
      send(200, { results: shared ? rows.map((r: any) => ({ ...r, shared: shared.has(r.slug) })) : rows });
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
      upsertModule(db, { slug, name, summary, description, current_goal, status });
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
      // Core refuses if entries or tasks are pinned to this module (better to surface than orphan).
      const r = deleteModule(db, body.slug);
      if (!r.deleted) {
        return send(409, {
          error: `module '${body.slug}' has ${r.entry_count} entries and ${r.task_count} tasks. Reassign or delete those first.`,
          entry_count: r.entry_count, task_count: r.task_count,
        });
      }
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
        SELECT id, title, summary FROM entries
        WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${liveEntry(db, 'entries')} AND type='decision' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const top_gotchas = db.prepare(`
        SELECT id, title, summary FROM entries
        WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${liveEntry(db, 'entries')} AND type='gotcha' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      const recent_handoffs = db.prepare(`
        SELECT id, title, summary, agent, created_at FROM entries
        WHERE ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?) AND ${liveEntry(db, 'entries')} AND type='handoff' AND deprecated=0
        ORDER BY created_at DESC LIMIT 5
      `).all(slug);
      send(200, { module, active_tasks, recent_decisions, top_gotchas, recent_handoffs });
    } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- DOCTOR (core is the single implementation; E-685 #5) ---
  // fts.integrity runs an FTS 'integrity-check' INSERT, so it needs a read-write
  // connection: getDb() opens read-write (better-sqlite3 default).
  'POST /api/collab/doctor': async (req, res, send) => {
    try { send(200, doctor(db)); } catch (err: any) { send(500, { error: err.message }); }
  },

  // --- EXPORT (json | markdown) ---
  'GET /api/collab/export': async (req, res, send) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const moduleFilter = url.searchParams.get('module');
    const since = url.searchParams.get('since'); // ISO date or sqlite-friendly
    if (!['json', 'markdown'].includes(format)) return send(400, { error: 'format must be json or markdown' });
    try {
      let q = `SELECT id, ${seriesCol()}, ulid, type,`
        + ' kind, category, title, summary, description, status, agent, module, task_id, superseded_by, superseded_by_ulid, created_at FROM entries WHERE deprecated=0'
        + ` AND ${liveEntry(db, 'entries')}`;
      const params: any[] = [];
      if (moduleFilter) { q += ' AND ulid IN (SELECT entry_ulid FROM entry_modules WHERE module=?)'; params.push(moduleFilter); }
      if (since) { q += ' AND created_at >= ?'; params.push(since); }
      q += ' ORDER BY created_at DESC';
      const entries = db.prepare(q).all(...params) as any[];
      for (const e of entries) {
        e.refs = db.prepare('SELECT ref_type, ref_value FROM refs WHERE entry_ulid=?').all(e.ulid);
        e.modules = db.prepare('SELECT module FROM entry_modules WHERE entry_ulid=? ORDER BY is_primary DESC, module ASC').all(e.ulid).map((r: any) => r.module);
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
        lines.push(`## ${formatEntryRef(e.id, e.series)} — ${e.title}`);
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
