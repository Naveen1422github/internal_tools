// file: core/src/sync/http.ts
import tls from "node:tls";
import http from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PinMismatchError, AccessRevokedError, SchemaMismatchError } from "./errors.js";
import { normalizeFingerprint } from "./cert.js";

// HTTPS to the post office with certificate PINNING (D13): the server's
// certificate must hash to the fingerprint from the join code. The check runs
// on secureConnect, before the HTTP request exists, so an impostor never sees
// a byte of it (not even the key in the Authorization header). Hostnames are
// not checked: the pin is the trust, so a changed LAN address still works.

export interface PostOfficeTarget {
  url: string;
  fingerprint: string;
  auth?: { device: string; key: string };
  /** Latest applied migration of this notes DB, sent as X-Collab-Schema (the office refuses a different one). */
  schema?: string;
}
export interface JsonResponse { status: number; body: any }

function hostPort(url: string): { host: string; port: number } {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a post office URL: ${url}`); }
  if (u.protocol !== "https:") throw new Error(`the post office URL must start with https:// (got ${url})`);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : 443 };
}

export function connectPinned(target: PostOfficeTarget, timeoutMs = 5000): Promise<tls.TLSSocket> {
  let where: { host: string; port: number };
  try { where = hostPort(target.url); } catch (e) { return Promise.reject(e); }
  const want = normalizeFingerprint(target.fingerprint);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: where.host, port: where.port,
      servername: isIP(where.host) ? undefined : where.host,
      rejectUnauthorized: false, // replaced by the pin check below
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`could not reach the post office at ${target.url} within ${timeoutMs} ms`));
    }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = sock.getPeerX509Certificate();
      const got = cert ? createHash("sha256").update(cert.raw).digest("hex") : "";
      if (got !== want) {
        sock.destroy();
        reject(new PinMismatchError(target.url, want, got || "none"));
        return;
      }
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not reach the post office at ${target.url}: ${e.message}`));
    });
  });
}

function headers(target: PostOfficeTarget, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (target.auth) h.authorization = `Bearer ${target.auth.device}:${target.auth.key}`;
  if (target.schema) h["x-collab-schema"] = target.schema;
  return h;
}

export async function requestJson(
  target: PostOfficeTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const { host, port } = hostPort(target.url);
  const sock = await connectPinned(target, timeoutMs);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method, path, host, port,
        headers: headers(target, {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        }),
        createConnection: () => sock,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          sock.destroy();
          if (res.statusCode === 401) return reject(new AccessRevokedError(target.url));
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text.slice(0, 200) }; }
          if (res.statusCode === 409 && parsed?.error === "schema") {
            return reject(new SchemaMismatchError(String(parsed.office), String(parsed.device)));
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from the post office at ${target.url} within ${timeoutMs} ms`)));
    req.on("error", (e) => { sock.destroy(); reject(e); });
    req.end(payload);
  });
}

export interface EventStream { close(): void }

/**
 * Server-sent events (the doorbell). `close(err)` fires exactly once: with an
 * error when the stream drops or is refused (AccessRevokedError on 401), with
 * no argument when the caller closed it.
 */
export function openEventStream(
  target: PostOfficeTarget,
  path: string,
  on: { event(name: string, data: string): void; close(err?: Error): void },
): EventStream {
  let req: http.ClientRequest | null = null;
  let done = false;
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    try { req?.destroy(); } catch { /* already gone */ }
    on.close(err);
  };
  connectPinned(target).then(
    (sock) => {
      if (done) { sock.destroy(); return; }
      const { host, port } = hostPort(target.url);
      req = http.request(
        { method: "GET", path, host, port, headers: headers(target, { accept: "text/event-stream" }), createConnection: () => sock },
        (res) => {
          if (res.statusCode === 401) { res.resume(); return finish(new AccessRevokedError(target.url)); }
          if (res.statusCode === 409) {
            // Read the small JSON body: a schema refusal names both migrations.
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              let b: any = null;
              try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
              if (b?.error === "schema") return finish(new SchemaMismatchError(String(b.office ?? "unknown"), String(b.device ?? "unknown")));
              finish(new Error(`the post office refused the event stream (409)`));
            });
            res.on("error", (e) => finish(e));
            return;
          }
          if (res.statusCode !== 200) { res.resume(); return finish(new Error(`the post office refused the event stream (${res.statusCode})`)); }
          res.setEncoding("utf8");
          let buf = "";
          res.on("data", (chunk: string) => {
            buf += chunk.replace(/\r\n/g, "\n");
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let name = "message";
              const data: string[] = [];
              for (const line of block.split("\n")) {
                if (line.startsWith(":")) continue;
                if (line.startsWith("event:")) name = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
              }
              if (data.length > 0 || name !== "message") on.event(name, data.join("\n"));
            }
          });
          res.on("end", () => finish(new Error("the event stream ended")));
          res.on("error", (e) => finish(e));
        },
      );
      req.on("error", (e) => finish(e));
      req.end();
    },
    (e) => finish(e),
  );
  return { close: () => finish() };
}
