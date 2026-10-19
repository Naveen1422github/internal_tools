// file: server/src/tools/projects.ts
// UI parity: the Projects page. Every route calls the same core operation as
// `collab project ...` (list, create, promote, rename, bind, unbind); nothing
// is re-implemented here. A solo project never touches the post office.
import http from 'node:http';
import {
  getDb, projectListRows, createProjectOp, projectCreatedLines, promoteProject, renameProject, highestNumberOf,
  bindModule, unbindModule, bindChangeLine, findProject, notFound, getSyncValue, SYNC_KEYS,
  planCopy, applyCopy, copyPlanLines, copyResultLines, can, resolveAuthor, type CopyArgs,
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

/** `collab copy`'s arguments from a request body. */
function copyArgs(b: any): CopyArgs {
  const opt = (v: unknown, what: string) => (v === undefined || v === null || v === '' ? undefined : text(v, what));
  return {
    from: text(b.from, 'Choose where to copy from.'),
    to: text(b.to, 'Choose the project to copy into.'),
    author: opt(b.author, '"author" must be text.'),
    since: opt(b.since, '"since" must be a date.'),
  };
}
const CHANGED = 'The notes changed since the list was shown; nothing was copied. Check the list again.';

const modulesOf = () => (db.prepare(`SELECT slug FROM modules ORDER BY slug`).all() as Array<{ slug: string }>).map((m) => m.slug);
/**
 * Modules `collab copy --from <module>` can copy from: those with notes in no
 * project (E notes), whether or not the module has a modules row (core's moduleExists).
 */
const copyModulesOf = () => (db.prepare(
  `SELECT module FROM (
     SELECT e.module AS module FROM entries e WHERE e.project_ulid IS NULL AND e.deleted_at IS NULL AND e.module IS NOT NULL
     UNION SELECT m.module FROM entry_modules m JOIN entries e ON e.ulid = m.entry_ulid WHERE e.project_ulid IS NULL AND e.deleted_at IS NULL
   ) ORDER BY module`,
).all() as Array<{ module: string }>).map((r) => r.module);

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  // `collab project list`, as rows. The web server has no folder, so there is no "current" project.
  'GET /api/projects': guarded((send) => {
    const projects = projectListRows(db, null).map((row) => {
      const p: Omit<typeof row, 'current'> & { current?: boolean } = { ...row };
      delete p.current;
      return p.mode === 'solo' ? { ...p, highest: highestNumberOf(db, p.code) } : p;
    });
    send(200, {
      projects, modules: modulesOf(), copy_modules: copyModulesOf(),
      office_url: getSyncValue(db, SYNC_KEYS.url) ?? null,
      // Who "only my notes" means (collab copy --author me), as this server resolves it.
      me: resolveAuthor(),
    });
  }),

  'POST /api/projects/create': guarded(async (send, b) => {
    if (b.team !== undefined && typeof b.team !== 'boolean') bad('"team" must be true or false.');
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
    // Already a team project of this office: nothing changed, and its numbers are the office's.
    if (before.mode === 'team') return send(200, { project: p, already: true });
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

  // `collab copy` on the web (UI parity Task 7a): the same list -> ask -> copy, with core's lines.
  'POST /api/projects/copy/plan': guarded((send, b) => {
    const plan = planCopy(db, copyArgs(b));
    // The same checks applyCopy makes, asked now, so a refusal comes before the list, not after it.
    for (const [ulid, key] of [[plan.source.project_ulid ?? null, 'note.copy.out'], [plan.target.ulid, 'note.create']] as const) {
      const c = can(db, ulid, key);
      if (!c.ok) return send(403, { error: c.reason });
    }
    send(200, { source: plan.source, target: plan.target, filters: plan.filters, items: plan.items, skipped: plan.skipped, lines: copyPlanLines(plan) });
  }),

  /** `expect` is the list the person saw: if the notes changed since, nothing is copied. */
  'POST /api/projects/copy/apply': guarded(async (send, b) => {
    const args = copyArgs(b);
    if (!Array.isArray(b.expect) || !b.expect.every((u: unknown) => typeof u === 'string')) bad('Check the list first.');
    const plan = planCopy(db, args);
    const same = (b.target === undefined || plan.target.ulid === b.target)
      && plan.items.length === b.expect.length && plan.items.every((it, i) => it.ulid === b.expect[i]);
    if (!same) return send(409, { error: CHANGED });
    const r = await applyCopy(db, plan);
    send(200, { copied: r.copied, lines: copyResultLines(r) });
  }),

  'POST /api/projects/unbind': guarded((send, b) => {
    send(200, { line: bindChangeLine(unbindModule(db, text(b.module, 'Choose a module.'))) });
  }),
};
