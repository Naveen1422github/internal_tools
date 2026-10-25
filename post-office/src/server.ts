// file: post-office/src/server.ts
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  StoreError, allocate, authenticate, redeemJoin, isRevoked, sharedModules, setModuleShared, teamStatus, officeSchema,
  registerProject, renameOfficeProject, addMember, revokeMember,
  type Member, type Store,
} from "./store.js";
import {
  officeKeys, projectKeys, requireOfficeKey, requireLegacyModuleShare, requireProjectKey, setProjectMember, setOfficeRole,
  createProjectRole, updateProjectRole, deleteProjectRole, isOwnerRole, projectRoleHolders,
  createOfficeRole, updateOfficeRole, deleteOfficeRole, listOfficeMembers,
} from "./access.js";
import { sanitizeKeys, E_PROJECT_ULID, schemaCompatible, type AccessPayload } from "@collab-mcp/core";
import { acceptChanges, fetchDeliveries, fetchReplay, lastSeq } from "./deliveries.js";
import { isEAdoptedOffice } from "./e-adopt.js";

// The post office's HTTPS + SSE API (spec Components 3, D12, D13). Plain Node
// https: no framework. Every route but /v1/join authenticates against the
// store on every request, so a revoke is effective immediately.

export interface PostOfficeOptions {
  /** Extra schema peers the office tolerates (default: core's WIRE_COMPAT). */
  schemaTable?: Readonly<Record<string, readonly string[]>>;
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
    /** Answer GET /v1/access with this status instead (404 = an older office, 500 = a broken one). */
    accessStatus?: (device: string) => number | null;
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
  const adopted = isEAdoptedOffice(db);
  const eProject = { adopted, member: adopted && projectKeys(db, device, E_PROJECT_ULID).has("note.view") };
  return { office: office ? { role: office.name, keys: [...officeKeys(db, device)] } : null, projects, replays, eProject };
}

/** A path parameter, decoded; bad percent-encoding is a 400, not a crash. */
function param(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw new StoreError("the address contains an invalid character"); }
}

/** R7a: a project you are not in does not exist for you; same answer for a missing one (no code or ulid echoed). */
function requireMembership(db: Store, device: string, projectUlid: string): void {
  if (!db.prepare(`SELECT 1 FROM po_project_members WHERE project_ulid = ? AND device_id = ?`).get(projectUlid, device)) {
    throw new StoreError("no such team project", 404);
  }
}

function membersOf(db: Store, projectUlid: string) {
  const members = db
    .prepare(
      `SELECT m.device_id, m.name, r.name AS role, x.role_ulid, m.last_seen_at FROM po_project_members x
         JOIN po_members m ON m.device_id = x.device_id AND m.revoked_at IS NULL
         JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? ORDER BY m.name, m.device_id`,
    )
    .all(projectUlid);
  const held = projectRoleHolders(db, projectUlid);
  const roles = (db.prepare(`SELECT ulid, name, keys, is_starter FROM po_roles WHERE project_ulid = ? ORDER BY name`).all(projectUlid) as Array<{ ulid: string; name: string; keys: string; is_starter: number }>).map((r) => {
    let parsed: unknown = [];
    try { parsed = JSON.parse(r.keys); } catch { /* grants nothing */ }
    // S3-2: Owner's name and keys are fixed ("all"); the other project roles lock nothing.
    const locked: "all" | "name" | null = isOwnerRole(r) ? "all" : null;
    // S3-3: every holder, revoked and not-yet-joined included: the count the delete rule uses.
    const holders = held[r.ulid]?.holders ?? 0;
    return { ulid: r.ulid, name: r.name, keys: sanitizeKeys("project", parsed), is_starter: r.is_starter === 1, locked, holders };
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
  const streams = new Set<{ device: string; res: ServerResponse; stop: () => void }>();
  // Read once at start: `serve` migrated the store before it got here.
  const officeSchemaValue = officeSchema(o.store);

  function ring(event: string, data: unknown, except?: string): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) if (s.device !== except && !s.res.writableEnded) s.res.write(msg);
  }

  function fail(res: ServerResponse, e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (res.headersSent) { res.destroy(); return; }
    const status = err instanceof StoreError ? err.status : 500;
    // Refusals are logged too: a 400 from applyChanges blocked a whole backfill
    // unseen on the office (COLLAB-205). 404s are routine and stay quiet.
    if (status >= 500) log(`error: ${err.message}`);
    else if (status !== 404) log(`refused ${status}: ${err.message}`);
    send(res, status, { error: err.message });
  }

  function openStream(res: ServerResponse, me: Member): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`: collab post office\n\nevent: ready\ndata: ${JSON.stringify({ last_seq: lastSeq(o.store) })}\n\n`);
    const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, o.heartbeatMs ?? 25_000);
    const watch = setInterval(() => {
      if (!o.store.open || res.writableEnded) return; // closing: the store may already be shut
      if (isRevoked(o.store, me.device_id)) {
        res.write("event: revoked\ndata: {}\n\n");
        res.end();
      }
    }, o.revokeCheckMs ?? 2_000);
    const s = { device: me.device_id, res, stop: () => { clearInterval(ping); clearInterval(watch); } };
    streams.add(s);
    res.on("close", () => {
      s.stop();
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
    if (!schemaCompatible(officeSchemaValue, deviceSchema, o.schemaTable)) {
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
      case "GET /v1/access": {
        const forced = o.testHooks?.accessStatus?.(me.device_id);
        if (forced) return send(res, forced, { error: forced === 404 ? `no such endpoint: ${route}` : "broken" });
        return send(res, 200, accessFor(o.store, me.device_id));
      }
      case "GET /v1/projects": {
        // R7a: a project you are not in does not exist for you.
        const mine = new Set((o.store.prepare(`SELECT project_ulid FROM po_project_members WHERE device_id = ?`).all(me.device_id) as Array<{ project_ulid: string }>).map((r) => r.project_ulid));
        // Never E: laptops know E only through /v1/access eProject. A laptop on older code would
        // insert code 'E' into its projects table (CHECK code <> 'E', 0009) and its whole sync would stop.
        const all = o.store.prepare(`SELECT ulid, name, code, created_at FROM po_projects WHERE ulid <> ? AND code <> 'E' ORDER BY code`).all(E_PROJECT_ULID) as Array<{ ulid: string }>;
        return send(res, 200, { projects: all.filter((p) => mine.has(p.ulid)) });
      }
      case "POST /v1/projects": {
        const b = await readJson(req, maxBody);
        requireOfficeKey(o.store, me.device_id, "office.project.create");
        const project = registerProject(o.store, b ?? {}, me.device_id);
        ring("projects", {}); // no code: non-members must not learn it (R7a); couriers refetch GET /v1/projects
        ring("access", {});
        log(`${me.name}: team project ${project.code} (${project.name}) registered`);
        return send(res, 200, { project });
      }
      case "POST /v1/changes": {
        const b = await readJson(req, maxBody);
        // R5: a refusal is never an HTTP error; it is listed in `refused`.
        const r = acceptChanges(o.store, me.device_id, b?.changes);
        if (r.accepted > 0 || r.officeWrote) {
          // A merge or write-back (R6) written by the office must reach the sender too.
          ring("changes", { last_seq: r.lastSeq }, r.officeWrote ? undefined : me.device_id);
        }
        if (r.accepted > 0 || r.refused.length) {
          log(`${me.name}: ${r.accepted} change(s) accepted, ${r.duplicates} duplicate(s)${r.refused.length ? `, ${r.refused.length} refused` : ""}${r.officeWrote ? ", office wrote a merge/flag/write-back" : ""}`);
        }
        if (o.testHooks?.dropChangesAnswer?.(me.device_id)) { req.socket.destroy(); return; }
        return send(res, 200, { accepted: r.accepted, duplicates: r.duplicates, last_seq: r.lastSeq, refused: r.refused });
      }
      case "GET /v1/changes": {
        const r = fetchDeliveries(o.store, me.device_id, intParam(url, "after", 0), intParam(url, "limit", 2000));
        return send(res, 200, { changes: r.changes, last_seq: r.lastSeq, more: r.more });
      }
      case "GET /v1/replay": {
        // R14: a missing or foreign project is a 404 (R7a); a member without note.view gets the 403.
        const ulid = url.searchParams.get("project");
        if (!ulid) throw new StoreError("project is needed");
        requireMembership(o.store, me.device_id, ulid);
        requireProjectKey(o.store, me.device_id, ulid, "note.view");
        return send(res, 200, fetchReplay(o.store, me.device_id, ulid, intParam(url, "after", 0), intParam(url, "limit", 2000)));
      }
      case "GET /v1/modules":
        return send(res, 200, { shared: sharedModules(o.store) });
      case "POST /v1/modules": {
        // Local-first Task 5: module sharing is retired once E is adopted (GET still answers old peers).
        if (isEAdoptedOffice(o.store)) return send(res, 410, { error: "modules follow their project now: collab project bind <module> <CODE>" });
        const b = await readJson(req, maxBody);
        requireLegacyModuleShare(o.store, me.device_id); // before adoption: today's rule (the key left the catalog)
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
        // S3-14: office.member.add and every key of the role the new device gets, in addMember's transaction.
        const { deviceId, secret } = addMember(o.store, String(b?.name ?? ""), { actor: me.device_id });
        ring("access", {});
        log(`${me.name}: added member ${deviceId}`);
        // UI parity D2: when the code expires, so a page needn't hard-code it (additive; older laptops ignore it).
        const stored = (o.store.prepare(`SELECT join_expires_at FROM po_members WHERE device_id = ?`).get(deviceId) as { join_expires_at: string }).join_expires_at;
        return send(res, 200, { device_id: deviceId, secret, expires_at: `${stored.replace(" ", "T")}Z` }); // ISO 8601, UTC
      }
      case "GET /v1/office/members":
        // S3-7: any live member (authenticate already refused revoked devices).
        return send(res, 200, listOfficeMembers(o.store));
      case "POST /v1/office/roles": {
        const b = await readJson(req, maxBody);
        const role = createOfficeRole(o.store, me.device_id, { name: b?.name, keys: b?.keys });
        ring("access", {});
        return send(res, 200, { role });
      }
    }
    // Parameterised routes (one small matcher; the switch keeps the fixed ones).
    let m: RegExpExecArray | null;
    if ((m = /^PUT \/v1\/projects\/([^/]+)$/.exec(route))) {
      // UI parity D1: a team project's name is the office's; project.edit is checked here.
      const ulid = param(m[1]);
      const b = await readJson(req, maxBody);
      requireMembership(o.store, me.device_id, ulid);
      requireProjectKey(o.store, me.device_id, ulid, "project.edit");
      const project = renameOfficeProject(o.store, ulid, b?.name, me.device_id);
      ring("projects", {}); // no name in the ring: non-members must not learn it (R7a)
      log(`${me.name}: team project ${project.code} renamed`);
      return send(res, 200, { project });
    }
    if ((m = /^GET \/v1\/projects\/([^/]+)\/members$/.exec(route))) {
      const ulid = param(m[1]);
      requireMembership(o.store, me.device_id, ulid);
      return send(res, 200, membersOf(o.store, ulid));
    }
    if ((m = /^(PUT|DELETE) \/v1\/projects\/([^/]+)\/members\/([^/]+)$/.exec(route))) {
      const ulid = param(m[2]), device = param(m[3]);
      const b = m[1] === "PUT" ? await readJson(req, maxBody) : (req.resume(), {});
      requireMembership(o.store, me.device_id, ulid);
      const role = m[1] === "PUT" ? String(b?.role ?? "") : null;
      if (m[1] === "PUT" && !role) throw new StoreError("a role name is needed");
      if (setProjectMember(o.store, me.device_id, ulid, device, role)) ring("access", {});
      return send(res, 200, { ok: true });
    }
    if ((m = /^POST \/v1\/projects\/([^/]+)\/roles$/.exec(route))) {
      const ulid = param(m[1]);
      const b = await readJson(req, maxBody);
      requireMembership(o.store, me.device_id, ulid);
      const role = createProjectRole(o.store, me.device_id, ulid, { name: b?.name, keys: b?.keys });
      ring("access", {});
      return send(res, 200, { role });
    }
    if ((m = /^(PUT|DELETE) \/v1\/projects\/([^/]+)\/roles\/([^/]+)$/.exec(route))) {
      const ulid = param(m[2]), role = param(m[3]);
      const b = m[1] === "PUT" ? await readJson(req, maxBody) : (req.resume(), {});
      requireMembership(o.store, me.device_id, ulid);
      if (m[1] === "PUT") {
        if (updateProjectRole(o.store, me.device_id, ulid, role, { name: b?.name, keys: b?.keys })) ring("access", {});
      } else {
        deleteProjectRole(o.store, me.device_id, ulid, role);
        ring("access", {});
      }
      return send(res, 200, { ok: true });
    }
    if ((m = /^(PUT|DELETE) \/v1\/office\/roles\/([^/]+)$/.exec(route))) {
      const role = param(m[2]);
      const b = m[1] === "PUT" ? await readJson(req, maxBody) : (req.resume(), {});
      if (m[1] === "PUT") {
        if (updateOfficeRole(o.store, me.device_id, role, { name: b?.name, keys: b?.keys })) ring("access", {});
      } else {
        deleteOfficeRole(o.store, me.device_id, role);
        ring("access", {});
      }
      return send(res, 200, { ok: true });
    }
    if ((m = /^PUT \/v1\/office\/members\/([^/]+)$/.exec(route))) {
      const b = await readJson(req, maxBody);
      const device = param(m[1]);
      const roleOf = () => (o.store.prepare(`SELECT role_ulid FROM po_office_members WHERE device_id = ?`).get(device) as { role_ulid: string } | undefined)?.role_ulid;
      const before = roleOf();
      setOfficeRole(o.store, me.device_id, device, String(b?.role ?? ""));
      if (roleOf() !== before) ring("access", {});
      return send(res, 200, { ok: true });
    }
    if ((m = /^DELETE \/v1\/office\/members\/([^/]+)$/.exec(route))) {
      req.resume();
      requireOfficeKey(o.store, me.device_id, "office.member.revoke");
      const who = param(m[1]);
      if (!o.store.prepare(`SELECT 1 FROM po_members WHERE device_id = ?`).get(who)) throw new StoreError(`no member called ${who}`, 404);
      revokeMember(o.store, who, { deviceOnly: true, actor: me.device_id });
      ring("access", {});
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
        // Timers first: 'close' fires later, after the caller may have shut the store.
        for (const s of streams) { s.stop(); s.res.end(); }
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
