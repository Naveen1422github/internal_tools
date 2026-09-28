import { createHash, randomBytes } from "node:crypto";

// Crockford base32, the ULID alphabet (no I, L, O, U).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;
const RAND_LIMIT = 1n << 80n;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new Error(`ULID time out of range: ${ms}`);
  let out = "";
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) out = CROCKFORD[t % 32] + out;
  return out;
}

function encodeRandom(bits: bigint): string {
  let out = "";
  for (let i = 0, b = bits; i < 16; i++, b >>= 5n) out = CROCKFORD[Number(b & 31n)] + out;
  return out;
}

function randomBits80(): bigint {
  let b = 0n;
  for (const byte of randomBytes(10)) b = (b << 8n) | BigInt(byte);
  return b;
}

let lastMs = -1;
let lastRand = 0n;

/**
 * Monotonic ULID. Within one millisecond (or if the clock steps backwards)
 * the random part is incremented instead of redrawn, so ids from this process
 * always sort in creation order.
 */
export function newUlid(now: number = Date.now()): string {
  if (now <= lastMs) {
    lastRand += 1n;
    if (lastRand >= RAND_LIMIT) throw new Error("ULID random part overflowed within one millisecond");
  } else {
    lastMs = now;
    lastRand = randomBits80();
  }
  return encodeTime(lastMs) + encodeRandom(lastRand);
}

/** SQLite datetime('now') text is UTC with no zone marker; JS would read it as local time. */
export function parseSqliteUtc(createdAt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(createdAt);
  if (!m) throw new Error(`unparseable created_at: ${createdAt}`);
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/**
 * Deterministic ULID for a pre-0005 entry (decision D1).
 * Random part = id in the top 32 bits, so same-second entries sort by E-number,
 * then 48 bits of a hash so two unrelated databases don't collide.
 */
export function ulidFromLegacy(id: number, createdAt: string, title: string): string {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) throw new Error(`legacy id out of range: ${id}`);
  const h = createHash("sha256").update(`${id}|${createdAt}|${title}`).digest();
  let low = 0n;
  for (let i = 0; i < 6; i++) low = (low << 8n) | BigInt(h[i]);
  return encodeTime(parseSqliteUtc(createdAt)) + encodeRandom((BigInt(id) << 48n) | low);
}

/**
 * Legacy entry-link value -> E-number, or null. Accepts "214", "E-214",
 * "E-00214", "E214", "#116" (any case, surrounding spaces). MUST stay in
 * lockstep with the SQL parser in 0005's trg_refs_fill_ulids; a parity test
 * guards this.
 */
export function parseEntryRef(value: string): number | null {
  const m = /^(?:#|E-?)?(\d+)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
