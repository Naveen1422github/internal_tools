// file: post-office/src/server.ts
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  StoreError, allocate, authenticate, redeemJoin, isRevoked, sharedModules, setModuleShared, teamStatus,
  type Member, type Store,
} from "./store.js";
import { acceptChanges, fetchDeliveries, lastSeq } from "./deliveries.js";

// The post office's HTTPS + SSE API (spec Components 3, D12, D13). Plain Node
// https: no framework. Every route but /v1/join authenticates against the
// store on every request, so a revoke is effective immediately.

export interface PostOfficeOptions {
  store: Store;
  certPem: string;
  keyPem: string;
  host?: string;
  port?: number;
  heartbeatMs?: number;
  revokeCheckMs?: number;
  maxBodyBytes?: number;
  log?: (line: string) => void;
  /** Tests only. */
  testHooks?: {
    dropAllocateAnswer?: (ulid: string) => boolean;
    /** Accept a push, then drop the connection instead of answering (acceptance test 8). */
    dropChangesAnswer?: (device: string) => boolean;
    /** Every request, with the device id it CLAIMS (before authentication), so tests also count refused ones. */
    onRequest?: (route: string, device: string) => void;
  };
}

export interface PostOffice {
  url: string;
  port: number;
  ring(event: string, data: unknown, except?: string): void;
  listeners(): string[];
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => {
      if (size > limit) return reject(new StoreError(`request too large (over ${limit} bytes)`, 413));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new StoreError("the request body is not JSON")); }
    });
    req.on("error", reject);
  });
}

function intParam(url: URL, name: string, dflt: number): number {
  const v = url.searchParams.get(name);
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new StoreError(`${name} must be a whole number`);
  return n;
}

export async function startPostOffice(o: PostOfficeOptions): Promise<PostOffice> {
  const log = o.log ?? (() => {});
  const maxBody = o.maxBodyBytes ?? 64 * 1024 * 1024;
  const streams = new Set<{ device: string; res: ServerResponse }>();

  function ring(event: string, data: unknown, except?: string): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) if (s.device !== except) s.res.write(msg);
  }

  function fail(res: ServerResponse, e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (res.headersSent) { res.destroy(); return; }
    const status = err instanceof StoreError ? err.status : 500;
    if (status >= 500) log(`error: ${err.message}`);
    send(res, status, { error: err.message });
  }

  function openStream(res: ServerResponse, me: Member): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`: collab post office\n\nevent: ready\ndata: ${JSON.stringify({ last_seq: lastSeq(o.store) })}\n\n`);
    const s = { device: me.device_id, res };
    streams.add(s);
    const ping = setInterval(() => res.write(": ping\n\n"), o.heartbeatMs ?? 25_000);
    const watch = setInterval(() => {
      if (isRevoked(o.store, me.device_id)) {
        res.write("event: revoked\ndata: {}\n\n");
        res.end();
      }
    }, o.revokeCheckMs ?? 2_000);
    res.on("close", () => {
      clearInterval(ping);
      clearInterval(watch);
      streams.delete(s);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://post-office.invalid");
    const route = `${req.method} ${url.pathname}`;
    o.testHooks?.onRequest?.(route, /^Bearer ([^:\s]+):/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    if (route === "POST /v1/join") {
      const b = await readJson(req, maxBody);
      const device = String(b?.device ?? "");
      const { key } = redeemJoin(o.store, device, String(b?.secret ?? ""));
      log(`member joined: ${device}`);
      return send(res, 200, { device, key });
    }
    const me = authenticate(o.store, req.headers.authorization);
    if (!me) {
      req.resume();
      return send(res, 401, { error: "access revoked or unknown device" });
    }
    switch (route) {
      case "POST /v1/allocate": {
        const b = await readJson(req, maxBody);
        const id = allocate(o.store, b?.ulid, me.device_id);
        if (o.testHooks?.dropAllocateAnswer?.(String(b?.ulid))) { req.socket.destroy(); return; }
        return send(res, 200, { id });
      }
      case "POST /v1/changes": {
        const b = await readJson(req, maxBody);
        const r = acceptChanges(o.store, me.device_id, b?.changes);
        if (r.accepted > 0) {
          // A merge written by the office must reach the sender too.
          ring("changes", { last_seq: r.lastSeq }, r.officeWrote ? undefined : me.device_id);
          log(`${me.name}: ${r.accepted} change(s) accepted, ${r.duplicates} duplicate(s)${r.officeWrote ? ", office wrote a merge/flag" : ""}`);
        }
        if (o.testHooks?.dropChangesAnswer?.(me.device_id)) { req.socket.destroy(); return; }
        return send(res, 200, { accepted: r.accepted, duplicates: r.duplicates, last_seq: r.lastSeq });
      }
      case "GET /v1/changes": {
        const r = fetchDeliveries(o.store, me.device_id, intParam(url, "after", 0), intParam(url, "limit", 2000));
        return send(res, 200, { changes: r.changes, last_seq: r.lastSeq, more: r.more });
      }
      case "GET /v1/modules":
        return send(res, 200, { shared: sharedModules(o.store) });
      case "POST /v1/modules": {
        const b = await readJson(req, maxBody);
        const shared = setModuleShared(o.store, b?.slug, b?.shared !== false);
        ring("modules", { shared });
        return send(res, 200, { shared });
      }
      case "GET /v1/status":
        return send(res, 200, { members: teamStatus(o.store), last_seq: lastSeq(o.store) });
      case "GET /v1/events":
        return openStream(res, me);
      default:
        req.resume();
        return send(res, 404, { error: `no such endpoint: ${route}` });
    }
  }

  const server = https.createServer({ cert: o.certPem, key: o.keyPem }, (req, res) => {
    handle(req, res).catch((e) => fail(res, e));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 7443, o.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = !o.host || o.host === "0.0.0.0" || o.host === "::" ? "127.0.0.1" : o.host;
  return {
    url: `https://${shown.includes(":") ? `[${shown}]` : shown}:${port}`,
    port,
    ring,
    listeners: () => [...streams].map((s) => s.device),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of streams) s.res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
