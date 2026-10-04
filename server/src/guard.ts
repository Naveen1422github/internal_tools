import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// The web server listens on 127.0.0.1 only, but any web page open in the
// browser can still send it requests. This guard lets through only requests
// from the collab UI itself (spec: docs/superpowers/specs/2026-10-04-collab-web-lock-design.md).

export type GuardRefusal = { status: 403 | 415; reason: 'host' | 'origin' | 'key' | 'content-type' };

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Every request (static files too: index.html carries the key). Stops DNS rebinding. */
export function checkHost(headers: IncomingHttpHeaders, port: number): GuardRefusal | null {
  const host = String(headers.host ?? '').toLowerCase();
  return allowedHosts(port).includes(host) ? null : { status: 403, reason: 'host' };
}

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every /api request: Host, then Origin (if sent), then the key, then the body type. */
export function checkApiRequest(
  req: { headers: IncomingHttpHeaders; method?: string },
  opts: { port: number; key: string },
): GuardRefusal | null {
  const h = req.headers;
  const host = checkHost(h, opts.port);
  if (host) return host;
  if (h.origin !== undefined) {
    const origins = allowedHosts(opts.port).map((x) => `http://${x}`);
    if (!origins.includes(String(h.origin).toLowerCase())) return { status: 403, reason: 'origin' };
  }
  const given = h['x-collab-key'];
  if (typeof given !== 'string' || !sameKey(given, opts.key)) return { status: 403, reason: 'key' };
  const hasBody = Number(h['content-length'] ?? 0) > 0 || /chunked/i.test(String(h['transfer-encoding'] ?? ''));
  if (hasBody && !/^application\/json\b/i.test(String(h['content-type'] ?? ''))) {
    return { status: 415, reason: 'content-type' };
  }
  return null;
}
