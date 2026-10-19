// file: server/src/tools/settings.ts
// UI parity Task 11: the Settings page. This laptop (core thisLaptop), the post
// office's address (`collab sync set-address`) and start-at-login (`collab
// sync autostart`). The last two are the courier's own functions, loaded at run
// time the way the CLI loads the courier (D11): no new package dependency.
import http from 'node:http';
import { getDb, thisLaptop, postOfficeTargetFromDb, requestJson, lastResolution } from '@collab-mcp/core';
import { UNREACHABLE } from './office-errors.js';

const db = getDb();
type Send = (status: number, body: any) => void;

type CourierModule = {
  courierDir(): string;
  readCourierConfig(dir: string): { dbPath: string; autostart: boolean } | null;
  setPostOfficeAddress(dir: string, url: string, opts: { db?: unknown; dbPath?: string }):
    Promise<{ ok: true; url: string } | { ok: false; kind: 'usage' | 'setup' | 'refused'; reason: string }>;
  setAutostart(dir: string, on: boolean): string[] | null;
};
const NO_COURIER = "The sync program (courier) isn't installed with this web server. In a terminal: collab sync autostart on|off.";
async function courier(): Promise<CourierModule | null> {
  try { return (await import('@collab-mcp/courier' as string)) as CourierModule; } catch { return null; }
}

/** This device's name, as the office knows it; null and why when it can't be asked. */
async function nameAtOffice(device: string | null): Promise<{ name: string | null; error: string | null }> {
  const target = postOfficeTargetFromDb(db);
  if (!target || !device) return { name: null, error: null };
  try {
    const r = await requestJson(target, 'GET', '/v1/status', undefined, { timeoutMs: 4000 });
    if (r.status !== 200) return { name: null, error: String(r.body?.error ?? `The post office answered ${r.status}.`) };
    const me = (r.body.members as Array<{ device_id: string; name: string }>).find((m) => m.device_id === device);
    return { name: me?.name ?? null, error: null };
  } catch {
    return { name: null, error: `Name unavailable: ${UNREACHABLE[0].toLowerCase()}${UNREACHABLE.slice(1)}` };
  }
}

export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/settings': async (_req, _res, send) => {
    const me = thisLaptop(db);
    const { name, error } = await nameAtOffice(me.device_id);
    const c = await courier();
    const cfg = c ? c.readCourierConfig(c.courierDir()) : null;
    const open = lastResolution()?.path ?? null;
    send(200, {
      ...me,
      name,
      name_error: error,
      // Start-at-login belongs to the courier set up on this machine; null: not set up (or another notebook's).
      autostart: cfg ? cfg.autostart : null,
      courier_notebook: cfg ? cfg.dbPath : null,
      courier_available: !!c,
      open_notebook: open,
    });
  },

  'POST /api/settings/address': async (_req, _res, send, body) => {
    if (typeof body?.url !== 'string') return send(400, { error: 'Give the new address, like https://192.168.1.40:7443.' });
    const c = await courier();
    if (!c) return send(501, { error: NO_COURIER.replace('autostart on|off', `set-address ${body.url}`) });
    const r = await c.setPostOfficeAddress(c.courierDir(), body.url, { db, dbPath: lastResolution()?.path });
    if (!r.ok) return send(r.kind === 'usage' ? 400 : 409, { error: r.reason.charAt(0).toUpperCase() + r.reason.slice(1) });
    send(200, { url: r.url, line: `Post office address set to ${r.url} (certificate checked: it is your post office). A running courier switches on its next retry.` });
  },

  'POST /api/settings/autostart': async (_req, _res, send, body) => {
    if (typeof body?.on !== 'boolean') return send(400, { error: '"on" must be true or false.' });
    const c = await courier();
    if (!c) return send(501, { error: NO_COURIER });
    let lines: string[] | null;
    try { lines = c.setAutostart(c.courierDir(), body.on); } catch (e) { return send(500, { error: (e as Error).message }); }
    if (!lines) return send(409, { error: "This laptop isn't set up for sync yet, so there is nothing to start at login." });
    send(200, { on: body.on, lines });
  },
};
