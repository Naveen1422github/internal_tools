// file: server/src/tools/team.ts
import http from 'node:http';
import {
  getDb, postOfficeTargetFromDb, requestJson, listProjects, isUlid, formatJoinCode, rememberSharedModules, E_PROJECT_ULID,
  AccessRevokedError, SchemaMismatchError, PinMismatchError,
} from '@collab-mcp/core';
import { NOT_CONNECTED, REVOKED, UNREACHABLE } from './office-errors.js';

// RnR S3 (team admin): the web UI asks the post office as this laptop's device;
// the office decides. Its status and wording pass through unchanged (Review
// Focus 4); only failures to talk to it at all get a sentence of ours. Fresh
// answers every time, never access_cache (S3-12).
const db = getDb();

type Send = (status: number, body: any) => void;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const NEEDS_UPDATE = 'The post office needs updating before roles can be managed here.';

const enc = encodeURIComponent;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
// A device id is one path segment: "." and ".." survive encodeURIComponent and the office's URL parser collapses them.
const isDevice = (v: unknown): v is string => isText(v) && v !== '.' && v !== '..';
const isId = (v: unknown): v is string => typeof v === 'string' && isUlid(v);

class BadRequest extends Error {}
const bad = (msg: string): never => { throw new BadRequest(msg); };

/** True while the office can't be reached: the outage is logged once, not on every poll; any answer ends it. */
let outage = false;

/** The office's answer, or the error to send instead. Read the target per request: setup may run while the server is up. */
export async function ask(method: Method, path: string, body?: unknown): Promise<{ ok: true; body: any } | { ok: false; status: number; error: string }> {
  const target = postOfficeTargetFromDb(db);
  if (!target) return { ok: false, status: 409, error: NOT_CONNECTED };
  try {
    const r = await requestJson(target, method, path, body);
    outage = false;
    if (r.status === 404 && /^no such endpoint/.test(String(r.body?.error ?? ''))) return { ok: false, status: 501, error: NEEDS_UPDATE };
    if (r.status >= 400) return { ok: false, status: r.status, error: String(r.body?.error ?? `The post office answered ${r.status}.`) };
    return { ok: true, body: r.body };
  } catch (e: any) {
    if (e instanceof AccessRevokedError) return { ok: false, status: 403, error: REVOKED };
    if (e instanceof SchemaMismatchError) return { ok: false, status: 409, error: e.message };
    // Something answers at the office's address with another certificate: say so, never "can't be reached".
    if (e instanceof PinMismatchError) return { ok: false, status: 502, error: e.message.replace(/^\[collab-mcp\] /, '') };
    if (!outage) console.error('[team] post office unreachable:', e?.message ?? e);
    outage = true;
    return { ok: false, status: 503, error: UNREACHABLE };
  }
}

async function forward(send: Send, method: Method, path: string, body?: unknown) {
  const r = await ask(method, path, body);
  if (!r.ok) return send(r.status, { error: r.error });
  send(200, r.body);
}

/** Bad input is a 400 with a plain message; anything else is the server's usual 500. */
const guarded = (fn: (req: http.IncomingMessage, send: Send, body: any) => Promise<void>) =>
  async (req: http.IncomingMessage, _res: http.ServerResponse, send: Send, body: any) => {
    try { await fn(req, send, body ?? {}); }
    catch (e) { if (e instanceof BadRequest) return send(400, { error: e.message }); throw e; }
  };

function scopeOf(b: any): 'project' | 'office' {
  if (b.scope !== 'project' && b.scope !== 'office') bad('The scope must be "project" or "office".');
  return b.scope;
}
function projectOf(b: any): string {
  if (!isId(b.project)) bad('Choose a team project.');
  return b.project;
}
/** Where a scope's roles live at the office. */
const rolesPath = (b: any) => (scopeOf(b) === 'office' ? '/v1/office/roles' : `/v1/projects/${enc(projectOf(b))}/roles`);
function keysOf(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) bad('Permissions must be a list of permission keys.');
  return v as string[];
}
function roleIdOf(b: any): string {
  if (!isId(b.role)) bad('Choose a role.');
  return b.role;
}

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/team/overview': guarded(async (_req, send) => {
    const target = postOfficeTargetFromDb(db);
    if (!target) return send(200, { connected: false });
    const r = await ask('GET', '/v1/access');
    if (!r.ok) return send(r.status, { error: r.error });
    // Names are this notebook's; a project not yet pulled here has none.
    const names = new Map(listProjects(db).map((p) => [p.ulid, p.name]));
    if (!names.has(E_PROJECT_ULID)) names.set(E_PROJECT_ULID, 'emp1st'); // E is listed here only once this laptop adopted it
    const projects = ((r.body?.projects ?? []) as Array<{ ulid: string; code: string; role: string; keys: string[] }>).map((p) => ({
      ulid: p.ulid, code: p.code, name: names.get(p.ulid) ?? null, role: p.role, keys: p.keys,
    }));
    const office = r.body?.office ? { role: r.body.office.role, keys: r.body.office.keys } : null;
    send(200, { connected: true, me: { device_id: target.auth!.device }, office, projects });
  }),

  'GET /api/team/project': guarded(async (req, send) => {
    const ulid = new URL(req.url!, 'http://x').searchParams.get('ulid');
    if (!isId(ulid)) bad('Choose a team project.');
    await forward(send, 'GET', `/v1/projects/${enc(ulid!)}/members`);
  }),

  'GET /api/team/office': guarded(async (_req, send) => forward(send, 'GET', '/v1/office/members')),

  'POST /api/team/member/set': guarded(async (_req, send, b) => {
    const scope = scopeOf(b);
    const project = scope === 'project' ? projectOf(b) : null;
    if (!isDevice(b.device)) bad('Choose a member.');
    if (!isText(b.role)) bad('Choose a role.');
    const path = project ? `/v1/projects/${enc(project)}/members/${enc(b.device)}` : `/v1/office/members/${enc(b.device)}`;
    await forward(send, 'PUT', path, { role: b.role });
  }),

  // Project scope only: revoking a device from the office is POST /api/team/revoke (UI parity D4).
  'POST /api/team/member/remove': guarded(async (_req, send, b) => {
    const project = projectOf(b);
    if (!isDevice(b.device)) bad('Choose a member.');
    await forward(send, 'DELETE', `/v1/projects/${enc(project)}/members/${enc(b.device)}`);
  }),

  // UI parity D2: `collab team invite` on the web. The office checks office.member.add and
  // no escalation; the join code is made by core's formatJoinCode, exactly as the CLI does.
  // The secret is in this answer only: never logged, never stored here.
  'POST /api/team/invite': guarded(async (_req, send, b) => {
    const name = isText(b.name) ? b.name.trim() : bad('Give the person a name.');
    const target = postOfficeTargetFromDb(db);
    if (!target) return send(409, { error: NOT_CONNECTED });
    const r = await ask('POST', '/v1/office/members', { name });
    if (!r.ok) return send(r.status, { error: r.error });
    const join_code = formatJoinCode({ url: target.url, fingerprint: target.fingerprint, device: r.body.device_id, secret: r.body.secret });
    send(200, { device_id: r.body.device_id, name, join_code, ...(r.body.expires_at ? { expires_at: r.body.expires_at } : {}) });
  }),

  // UI parity D4: `collab team revoke` on the web (replaces S3-7). The office checks
  // office.member.revoke and the rank rule.
  'POST /api/team/revoke': guarded(async (_req, send, b) => {
    if (!isDevice(b.device)) bad('Choose a member.');
    await forward(send, 'DELETE', `/v1/office/members/${enc(b.device)}`);
  }),

  // UI parity Task 7c: `collab sync share|unshare <module>` on the web. The office checks office.module.share.
  'POST /api/sync/share': guarded(async (_req, send, b) => {
    if (!isText(b.slug)) bad('Choose a module.');
    if (typeof b.shared !== 'boolean') bad('"shared" must be true or false.');
    const r = await ask('POST', '/v1/modules', { slug: b.slug, shared: b.shared });
    if (!r.ok) return send(r.status, { error: r.error });
    // This laptop shows the change at once; the courier's next `modules` ring writes the same list.
    if (Array.isArray(r.body?.shared)) rememberSharedModules(db, r.body.shared);
    send(200, r.body);
  }),

  'POST /api/team/role/create': guarded(async (_req, send, b) => {
    const path = rolesPath(b);
    if (typeof b.name !== 'string') bad('Give the role a name.');
    await forward(send, 'POST', path, { name: b.name, keys: keysOf(b.keys) });
  }),

  'POST /api/team/role/update': guarded(async (_req, send, b) => {
    const path = `${rolesPath(b)}/${enc(roleIdOf(b))}`;
    const change: { name?: string; keys?: string[] } = {};
    if (b.name !== undefined) { if (typeof b.name !== 'string') bad('Give the role a name.'); change.name = b.name; }
    if (b.keys !== undefined) change.keys = keysOf(b.keys);
    if (change.name === undefined && change.keys === undefined) bad('Nothing to change: give a new name or permissions.');
    await forward(send, 'PUT', path, change);
  }),

  'POST /api/team/role/delete': guarded(async (_req, send, b) => {
    await forward(send, 'DELETE', `${rolesPath(b)}/${enc(roleIdOf(b))}`);
  }),
};
