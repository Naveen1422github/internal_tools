// file: post-office/src/server.ts
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  StoreError, allocate, authenticate, redeemJoin, isRevoked, sharedModules, setModuleShared, teamStatus, officeSchema,
  registerProject, addMember, revokeMember,
  type Member, type Store,
} from "./store.js";
import { officeKeys, projectKeys, memberProjects, requireOfficeKey, requireProjectKey, setProjectMember, setOfficeRole } from "./access.js";
import { sanitizeKeys, type AccessPayload } from "@collab-mcp/core";
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

// RnR: what `device` may do, in the shape the laptop caches (R3).
function accessFor(db: Store, device: string): AccessPayload {
  const office = db.prepare(`SELECT r.name FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ?`).get(device) as { name: string } | undefined;
  const projects = (db
    .prepare(
      `SELECT p.ulid, p.code, r.name AS role FROM po_project_members x
         JOIN po_projects p ON p.ulid = x.project_ulid JOIN po_roles r ON r.ulid = x.role_ulid
        WHERE x.device_id = ? ORDER BY p.code`,
    )
    .all(device) as Array<{ ulid: string; code: string; role: string }>).map((p) => {
    const ai: Record<string, "allow" | "ask" | "deny"> = {};
    for (const a of db.prepare(`SELECT key, state FROM po_project_ai WHERE project_ulid = ?`).all(p.ulid) as Array<{ key: string; state: "allow" | "ask" | "deny" }>) ai[a.key] = a.state;
    return { ...p, keys: [...projectKeys(db, device, p.ulid)], ai };
  });
  const replays = db.prepare(`SELECT project_ulid, upto_seq FROM po_replays WHERE device_id = ?`).all(device) as AccessPayload["replays"];
  return { office: office ? { role: office.name, keys: [...officeKeys(db, device)] } : null, projects, replays };
}

function membersOf(db: Store, projectUlid: string) {
  const members = db
    .prepare(
      `SELECT m.device_id, m.name, r.name AS role, m.last_seen_at FROM po_project_members x
         JOIN po_members m ON m.device_id = x.device_id AND m.revoked_at IS NULL
         JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? ORDER BY m.name, m.device_id`,
    )
    .all(projectUlid);
  const roles = (db.prepare(`SELECT ulid, name, keys FROM po_roles WHERE project_ulid = ? ORDER BY name`).all(projectUlid) as Array<{ ulid: string; name: string; keys: string }>).map((r) => {
    let parsed: unknown = [];
    try { parsed = JSON.parse(r.keys); } catch { /* grants nothing */ }
    return { ulid: r.ulid, name: r.name, keys: sanitizeKeys("project", parsed) };
  });
  return { members, roles };
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
  // Read once at start: `serve` migrated the store before it got here.
  const officeSchemaValue = officeSchema(o.store);

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
    // Schema guard (spec V7): a laptop on another migration would receive or send
    // columns the other side does not have. Refuse; its courier pauses.
    const deviceSchema = String(req.headers["x-collab-schema"] ?? "unknown");
    if (deviceSchema !== officeSchemaValue) {
      req.resume();
      log(`${me.name}: refused, schema ${deviceSchema} (office ${officeSchemaValue})`);
      return send(res, 409, { error: "schema", office: officeSchemaValue, device: deviceSchema });
    }
    switch (route) {
      case "POST /v1/allocate": {
        const b = await readJson(req, maxBody);
        // No series = an older laptop: E, exactly as before. The answer echoes the
        // series so a newer laptop can refuse a number from an older office (stage C).
        const series = b?.series === undefined ? "E" : String(b.series);
        const id = allocate(o.store, b?.ulid, me.device_id, series);
        if (o.testHooks?.dropAllocateAnswer?.(String(b?.ulid))) { req.socket.destroy(); return; }
        return send(res, 200, { id, series });
      }
      case "GET /v1/access":
        return send(res, 200, accessFor(o.store, me.device_id));
      case "GET /v1/projects": {
        // R7a: a project you are not in does not exist for you.
        const mine = new Set(memberProjects(o.store, me.device_id));
        const all = o.store.prepare(`SELECT ulid, name, code, created_at FROM po_projects ORDER BY code`).all() as Array<{ ulid: string }>;
        return send(res, 200, { projects: all.filter((p) => mine.has(p.ulid)) });
      }
      case "POST /v1/projects": {
        const b = await readJson(req, maxBody);
        requireOfficeKey(o.store, me.device_id, "office.project.create");
        const project = registerProject(o.store, b ?? {}, me.device_id);
        ring("projects", { code: project.code });
        ring("access", { project: project.code });
        log(`${me.name}: team project ${project.code} (${project.name}) registered`);
        return send(res, 200, { project });
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
        requireOfficeKey(o.store, me.device_id, "office.module.share");
        const shared = setModuleShared(o.store, b?.slug, b?.shared !== false);
        ring("modules", { shared });
        return send(res, 200, { shared });
      }
      case "GET /v1/status":
        return send(res, 200, { members: teamStatus(o.store), last_seq: lastSeq(o.store) });
      case "GET /v1/events":
        return openStream(res, me);
      case "POST /v1/office/members": {
        const b = await readJson(req, maxBody);
        requireOfficeKey(o.store, me.device_id, "office.member.add");
        const { deviceId, secret } = addMember(o.store, String(b?.name ?? ""));
        ring("access", { office: true });
        log(`${me.name}: added member ${deviceId}`);
        return send(res, 200, { device_id: deviceId, secret });
      }
    }
    // Parameterised routes (one small matcher; the switch keeps the fixed ones).
    let m: RegExpExecArray | null;
    if ((m = /^GET \/v1\/projects\/([^/]+)\/members$/.exec(route))) {
      requireProjectKey(o.store, me.device_id, m[1], "note.view");
      return send(res, 200, membersOf(o.store, m[1]));
    }
    if ((m = /^(PUT|DELETE) \/v1\/projects\/([^/]+)\/members\/([^/]+)$/.exec(route))) {
      const b = m[1] === "PUT" ? await readJson(req, maxBody) : (req.resume(), {});
      const role = m[1] === "PUT" ? String(b?.role ?? "") : null;
      if (m[1] === "PUT" && !role) throw new StoreError("a role name is needed");
      setProjectMember(o.store, me.device_id, m[2], decodeURIComponent(m[3]), role);
      ring("access", { project: m[2] });
      return send(res, 200, { ok: true });
    }
    if ((m = /^PUT \/v1\/office\/members\/([^/]+)$/.exec(route))) {
      const b = await readJson(req, maxBody);
      setOfficeRole(o.store, me.device_id, decodeURIComponent(m[1]), String(b?.role ?? ""));
      ring("access", { office: true });
      return send(res, 200, { ok: true });
    }
    if ((m = /^DELETE \/v1\/office\/members\/([^/]+)$/.exec(route))) {
      req.resume();
      requireOfficeKey(o.store, me.device_id, "office.member.revoke");
      const who = decodeURIComponent(m[1]);
      if (!o.store.prepare(`SELECT 1 FROM po_members WHERE device_id = ?`).get(who)) throw new StoreError(`no member called ${who}`, 404);
      revokeMember(o.store, who);
      ring("access", { office: true });
      return send(res, 200, { ok: true });
    }
    req.resume();
    return send(res, 404, { error: `no such endpoint: ${route}` });
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
