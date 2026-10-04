// file: core/src/sync/joincode.ts
import { normalizeFingerprint } from "./cert.js";

// A one-time join code (D12, D13): where the post office is, the fingerprint
// of its certificate (the pin), and a one-time secret for one pre-registered
// device. Treat it like a password until it is used.
export interface JoinCode { url: string; fingerprint: string; device: string; secret: string }

const PREFIX = "collab1-";

export function formatJoinCode(c: JoinCode): string {
  const body = JSON.stringify({ u: c.url, f: normalizeFingerprint(c.fingerprint), d: c.device, s: c.secret });
  return PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

export function parseJoinCode(code: string): JoinCode {
  const t = code.trim();
  if (!t.startsWith(PREFIX)) throw new Error("not a collab join code (it starts with collab1-)");
  let o: { u?: unknown; f?: unknown; d?: unknown; s?: unknown };
  try {
    o = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("the join code is damaged (it could not be decoded); copy it again");
  }
  if (
    typeof o?.u !== "string" || !o.u.startsWith("https://") ||
    typeof o.f !== "string" || normalizeFingerprint(o.f).length !== 64 ||
    typeof o.d !== "string" || !o.d || typeof o.s !== "string" || !o.s
  ) {
    throw new Error("the join code is incomplete; copy it again");
  }
  return { url: o.u, fingerprint: normalizeFingerprint(o.f), device: o.d, secret: o.s };
}
