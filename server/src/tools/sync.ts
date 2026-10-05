// file: server/src/tools/sync.ts
import http from 'node:http';
import {
  getDb, readSyncOverview, getMergeView, resolveWithText, resolveNeedsMerge,
  VersionsChangedError, liveEntry, hasSeries,
} from '@collab-mcp/core';
import { parseRefParam, REF_FORMS } from './collab.js';
import { callGroq } from './ai.js';

// Web UI part 2: sync health and settling conflicts. Read-only except resolve.
const db = getDb();

type Send = (status: number, body: any) => void;
const idParam = (req: http.IncomingMessage) => new URL(req.url!, 'http://x').searchParams.get('id');

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/sync/status': async (_req, _res, send) => send(200, readSyncOverview(db)),

  'GET /api/sync/needs-merge': async (_req, _res, send) => {
    const has = db.prepare(`SELECT 1 FROM pragma_table_info('entries') WHERE name = 'needs_merge'`).get();
    if (!has) return send(200, { results: [] });
    const rows = db.prepare(
      `SELECT e.id, ${hasSeries(db) ? 'e.series' : `'E' AS series`}, e.title, e.module, e.type, e.updated_at FROM entries e
        WHERE e.needs_merge = 1 AND e.deprecated = 0 AND ${liveEntry(db, 'e')} ORDER BY e.id`,
    ).all();
    send(200, { results: rows });
  },

  'GET /api/sync/versions': async (req, _res, send) => {
    // A bare number = E; "SH-3" names a project note (stage B1).
    const ref = parseRefParam(idParam(req));
    if (!ref) return send(400, { error: `id must be a note number: ${REF_FORMS}` });
    try { send(200, getMergeView(db, ref.id, ref.series)); }
    catch (e: any) { send(404, { error: e.message }); }
  },

  'POST /api/sync/resolve': async (_req, _res, send, body) => {
    const { id, expectedHeads, choice } = body ?? {};
    if (!Number.isInteger(id) || !Array.isArray(expectedHeads) || choice === undefined) {
      // Only E notes are ever merged in stage B1: project notes are never synced.
      const ref = typeof id === 'string' ? parseRefParam(id) : null;
      if (ref && ref.series !== 'E' && Array.isArray(expectedHeads) && choice !== undefined) {
        return send(404, { error: `${id} is not waiting for a merge` });
      }
      return send(400, { error: 'body must be { id, expectedHeads: string[], choice }' });
    }
    try {
      if (choice === 'keep-current') resolveNeedsMerge(db, id, expectedHeads);
      else resolveWithText(db, { id, expectedHeads, title: choice?.title, summary: choice?.summary, description: choice?.description ?? null });
      send(200, { ok: true, id });
    } catch (e: any) {
      if (e instanceof VersionsChangedError) return send(409, { error: 'versions-changed' });
      if (/no entry found|not waiting for a merge/.test(e.message)) return send(404, { error: e.message });
      send(400, { error: e.message });
    }
  },

  'POST /api/sync/explain': async (_req, _res, send, body) => {
    let view;
    const ref = typeof body?.id === 'string' ? parseRefParam(body.id) : { series: 'E', id: Number(body?.id) };
    try { view = getMergeView(db, ref?.id ?? NaN, ref?.series); } catch (e: any) { return send(404, { error: e.message }); }
    const versions = view.heads
      .map((h, i) => `Version ${i + 1} (by ${h.author ?? 'unknown'}, ${h.created_at})\nTitle: ${h.title}\nSummary: ${h.summary}\nDescription: ${h.description ?? ''}`)
      .join('\n\n');
    try {
      const text = await callGroq([
        { role: 'system', content: 'Two or more people edited the same note at the same time. Describe, neutrally and briefly, what differs between the versions and what each one says. Never recommend, rank or choose a version; the person decides.' },
        { role: 'user', content: versions },
      ], { temperature: 0.1 });
      send(200, { text });
    } catch {
      send(503, { error: 'ai-unavailable' });
    }
  },
};
