import http from 'node:http';
import { runSetupDoctor } from '@collab-mcp/core';

type Send = (status: number, body: any) => void;
// Same report as `collab doctor --json` and the MCP collab_doctor tool (spec P10).
export const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, send: Send, body: any) => Promise<any>> = {
  'GET /api/doctor/setup': async (_req, _res, send) => send(200, await runSetupDoctor()),
};
