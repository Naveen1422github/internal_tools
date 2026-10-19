// file: server/src/tools/projects.ts
// UI parity: the Projects page. Every route calls the same core operation as
// `collab project ...` (list, create, promote, rename, bind, unbind); nothing
// is re-implemented here. A solo project never touches the post office.
import http from 'node:http';
import {
  getDb, projectListRows, createProjectOp, projectCreatedLines, promoteProject, renameProject, highestNumberOf,
  bindModule, unbindModule, bindChangeLine, findProject, notFound, getSyncValue, SYNC_KEYS,
} from '@collab-mcp/core';
import { coreFailure } from './office-errors.js';

const db = getDb();

type Send = (status: number, body: any) => void;
const NEEDS_UPDATE = 'The post office needs updating before team projects can be managed here.';

class BadRequest extends Error {}
const bad = (msg: string): never => { throw new BadRequest(msg); };
const text = (v: unknown, msg: string): string => (typeof v === 'string' ? v : bad(msg));

/** Bad input and core's refusals are plain `{ error }` answers; anything else is the server's usual 500. */
const guarded = (fn: (send: Send, body: any) => Promise<void> | void) =>
  async (_req: http.IncomingMessage, _res: http.ServerResponse, send: Send, body: any) => {
    try { await fn(send, body ?? {}); }
    catch (e) {
      if (e instanceof BadRequest) return send(400, { error: e.message });
      const f = coreFailure(e, NEEDS_UPDATE);
      if (f) return send(f.status, { error: f.error });
      throw e;
    }
  };

const modulesOf = () => (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((m) => m.slug);

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  // `collab project list`, as rows. The web server has no folder, so there is no "current" project.
  'GET /api/projects': guarded((send) => {
    const projects = projectListRows(db, null).map(({ current: _current, ...p }) => (
      p.mode === 'solo' ? { ...p, highest: highestNumberOf(db, p.code) } : p
    ));
    send(200, { projects, modules: modulesOf(), office_url: getSyncValue(db, SYNC_KEYS.url) ?? null });
  }),

  'POST /api/projects/create': guarded(async (send, b) => {
    const p = await createProjectOp(db, {
      name: text(b.name, 'Give the project a name.'), code: text(b.code, 'Give the project a code.'), team: b.team === true,
    });
    send(200, { project: p, lines: projectCreatedLines(db, p) });
  }),

  'POST /api/projects/promote': guarded(async (send, b) => {
    const code = text(b.code, 'Choose a project.');
    const before = findProject(db, code);
    if (!before) throw notFound(db, code);
    const p = await promoteProject(db, code);
    // What promoteProject sent as the office's seed: the office continues after it.
    send(200, { project: p, next: `${p.code}-${highestNumberOf(db, p.code) + 1}` });
  }),

  'POST /api/projects/rename': guarded(async (send, b) => {
    const p = await renameProject(db, text(b.code, 'Choose a project.'), text(b.name, 'Give the project a name.'));
    send(200, { project: p });
  }),

  'POST /api/projects/bind': guarded((send, b) => {
    send(200, { line: bindChangeLine(bindModule(db, text(b.module, 'Choose a module.'), text(b.code, 'Choose a project.'))) });
  }),

  'POST /api/projects/unbind': guarded((send, b) => {
    send(200, { line: bindChangeLine(unbindModule(db, text(b.module, 'Choose a module.'))) });
  }),
};
