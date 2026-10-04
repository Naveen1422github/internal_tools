// file: core/src/sync/cert.ts
import { generateKeyPairSync, sign, randomBytes, createHash, X509Certificate } from "node:crypto";

// A self-signed certificate from node:crypto alone (no dependency): EC P-256
// key, ECDSA-SHA256 signature, a minimal X.509 v3 body without extensions.
// Trust comes from the fingerprint pinned in the join code (D13), not from a
// CA or a hostname, so it keeps working when the post office's address changes.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
function oid(dotted: string): Buffer {
  const p = dotted.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function uint(b: Buffer): Buffer {
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function time(d: Date): Buffer {
  const s = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const body = s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + "Z";
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(body.slice(2))) : tlv(0x18, Buffer.from(body));
}

export interface SelfSignedCert { certPem: string; keyPem: string; fingerprint: string }

export function normalizeFingerprint(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

export function fingerprintOfPem(certPem: string): string {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
}

export function generateSelfSignedCert(opts: { commonName?: string; days?: number } = {}): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(opts.commonName ?? "collab post office", "utf8")))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, uint(Buffer.from([2]))), // v3
    uint(serial),
    ecdsaSha256,
    name,
    seq(time(new Date(now - 24 * 3600 * 1000)), time(new Date(now + (opts.days ?? 3650) * 24 * 3600 * 1000))),
    name,
    spki,
  );
  const signature = sign("sha256", tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { certPem, keyPem, fingerprint: createHash("sha256").update(der).digest("hex") };
}
