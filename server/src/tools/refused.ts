// file: server/src/tools/refused.ts
import http from 'node:http';
import {
  getDb, listRefused, describeRefused, copyRefused, discardRefused, listProjects, isTeamProject, formatEntryRef,
  RefusedNotFoundError, TeamTargetError, ProjectNotFoundError,
} from '@collab-mcp/core';

// RnR S3 (R6, S3-10): changes the post office refused, on the web. The same core
// calls as `collab refused list|copy|delete` (Review Focus 6), so the page and the
// CLI say the same thing; core's errors keep their words, without "[collab] ".
const db = getDb();

type Send = (status: number, body: any) => void;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const plain = (e: Error) => e.message.replace(/^\[collab\] /, '');

class BadRequest extends Error {}
const bad = (msg: string): never => { throw new BadRequest(msg); };

/** Bad input and core's refusals get their status; anything else is the server's usual 500. */
const guarded = (fn: (send: Send, body: any) => Promise<void>) =>
  async (_req: http.IncomingMessage, _res: http.ServerResponse, send: Send, body: any) => {
    try { await fn(send, body ?? {}); }
    catch (e) {
      if (e instanceof BadRequest) return send(400, { error: e.message });
      if (e instanceof RefusedNotFoundError) return send(404, { error: plain(e) });
      if (e instanceof TeamTargetError || e instanceof ProjectNotFoundError) return send(400, { error: plain(e) });
      throw e;
    }
  };

function idOf(b: any): string {
  if (!isText(b.id)) bad('Choose a refused change.');
  return b.id;
}

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/refused': guarded(async (send) => {
    const results = listRefused(db).map((r) => ({
      id: r.ulid, at: r.at, ...describeRefused(db, r), kind: r.kind, key: r.key, reason: r.reason,
    }));
    // Only this notebook's solo projects can take a copy (S3-10).
    const solo_projects = listProjects(db).filter((p) => !isTeamProject(p)).map((p) => ({ code: p.code, name: p.name }));
    send(200, { results, solo_projects });
  }),

  'POST /api/refused/copy': guarded(async (send, b) => {
    const id = idOf(b);
    if (!isText(b.to)) bad('Choose a solo project.');
    const r = await copyRefused(db, id, b.to);
    send(200, { ref: formatEntryRef(r.id, r.series) });
  }),

  'POST /api/refused/delete': guarded(async (send, b) => {
    discardRefused(db, idOf(b));
    send(200, { ok: true });
  }),
};
