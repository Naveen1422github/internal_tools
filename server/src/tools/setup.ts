import http from 'node:http';
import { existsSync } from 'node:fs';
import {
  runSetupDoctor, fixableIds, runSafeFix, SAFE_FIXES, readNotebookConfig, lastResolution, describeResolution, samePath,
  type SafeFixId, type NotebookConfig,
} from '@collab-mcp/core';

type Send = (status: number, body: any) => void;
export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  // Same report as `collab doctor --json` and the MCP collab_doctor tool (spec P10),
  // plus which checks the Health page can fix (UI parity Task 7b).
  'GET /api/doctor/setup': async (_req, _res, send) => {
    const report = await runSetupDoctor();
    send(200, { ...report, fixable: fixableIds(report) });
  },

  // One of `collab doctor --fix`'s safe repairs (core's SAFE_FIXES), with --fix's words.
  'POST /api/doctor/fix': async (_req, _res, send, body) => {
    const id = body?.id;
    if (typeof id !== 'string' || !Object.hasOwn(SAFE_FIXES, id)) return send(400, { error: "That check can't be fixed from here." });
    const before = await runSetupDoctor();
    const what = SAFE_FIXES[id as SafeFixId];
    if (!fixableIds(before).includes(id as SafeFixId)) return send(409, { error: 'Nothing to fix: the check is fine now.' });
    let why: string | null;
    try { why = await runSafeFix(id as SafeFixId, before); } catch (e) { why = (e as Error).message; }
    const report = await runSetupDoctor();
    send(200, { ok: why === null, text: why === null ? `fixed: ${what}` : `could not fix: ${what} (${why})`, report: { ...report, fixable: fixableIds(report) } });
  },

  // `collab notebook list` and `collab notebook which`, read-only (switching needs a restart).
  'GET /api/notebooks': async (_req, _res, send) => {
    const r = lastResolution();
    if (!r) return send(503, { error: 'No notebook is open yet.' });
    const open = { name: r.name, path: r.path, described: describeResolution(r) };
    let cfg: NotebookConfig;
    try { cfg = readNotebookConfig(); } catch (e) { return send(200, { open, notebooks: [], error: (e as Error).message.replace(/^\[collab\] /, '') }); }
    const notebooks = Object.keys(cfg.notebooks).sort().map((name) => {
      const p = cfg.notebooks[name].path;
      return { name, path: p, default: cfg.default === name, open: samePath(p, r.path), missing: !existsSync(p) };
    });
    send(200, { open, notebooks });
  },
};
