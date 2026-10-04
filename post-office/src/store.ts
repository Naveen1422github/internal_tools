// file: post-office/src/store.ts
import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { migrate, latestMigration, enableSync, loadCrsqlite, isCrsqliteLoaded, SLUG_REGEX } from "@collab-mcp/core";

// The post office's ONE SQLite file (D14). The notes schema (0007 + CRRs) is a
// replica of every shared row; the po_* tables are the office's own and never
// replicate. Every connection loads cr-sqlite (the notes tables are CRRs).
export type Store = Database.Database;

export class StoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "StoreError";
  }
}

const PO_SCHEMA = `
CREATE TABLE IF NOT EXISTS po_meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS po_members (
  device_id        TEXT NOT NULL PRIMARY KEY,
  name             TEXT NOT NULL,
  join_hash        TEXT,
  join_expires_at  TEXT,
  key_hash         TEXT,
  joined_at        TEXT,
  revoked_at       TEXT,
  last_seen_at     TEXT,
  receive_bookmark INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS po_allocations (
  ulid       TEXT    NOT NULL PRIMARY KEY,
  id         INTEGER NOT NULL UNIQUE,
  device_id  TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- One row per accepted change, in global order (spec: deliveries #1, #2, ...).
-- val has NO declared type on purpose: any affinity would coerce values.
CREATE TABLE IF NOT EXISTS po_deliveries (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  origin      TEXT    NOT NULL,
  tbl         TEXT    NOT NULL,
  pk          BLOB    NOT NULL,
  cid         TEXT    NOT NULL,
  val,
  col_version INTEGER NOT NULL,
  db_version  INTEGER NOT NULL,
  site_id     BLOB    NOT NULL,
  cl          INTEGER NOT NULL,
  ch_seq      INTEGER NOT NULL,
  received_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, db_version, ch_seq, tbl, pk, cid)
);
CREATE TABLE IF NOT EXISTS po_shared_modules (
  slug      TEXT NOT NULL PRIMARY KEY,
  shared_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function tune(db: Store): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

export function getMeta(db: Store, key: string): string | null {
  const r = db.prepare(`SELECT value FROM po_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setMeta(db: Store, key: string, value: string): void {
  db.prepare(`INSERT INTO po_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** New store. The counter starts at `seedMaxId`: the main laptop's current max(id) (spec Components 3). */
export function createStore(path: string, opts: { seedMaxId: number }): Store {
  if (existsSync(path)) throw new StoreError(`a post office store already exists at ${path}`);
  if (!Number.isInteger(opts.seedMaxId) || opts.seedMaxId < 0) throw new StoreError("the seed must be a whole number >= 0");
  const db = new Database(path);
  tune(db);
  // A new office starts on the newest released migration: the schema guard
  // only lets laptops on that same migration exchange changes with it.
  migrate(db);
  enableSync(db);
  db.exec(PO_SCHEMA);
  const v = (db.prepare(`SELECT crsql_db_version() v`).get() as { v: number }).v;
  setMeta(db, "counter", String(opts.seedMaxId));
  // The office's own writes (merges, flags) are delivered from here on; rows
  // the migrations created are not news to anyone.
  setMeta(db, "self_db_version", String(v));
  setMeta(db, "created_at", new Date().toISOString());
  return db;
}

export function openStore(path: string): Store {
  if (!existsSync(path)) throw new StoreError(`no post office store at ${path}; run \`collab-post-office init\` first`, 500);
  const db = new Database(path);
  tune(db);
  loadCrsqlite(db);
  // `serve` brings the store to the newest released migration before any
  // laptop does (core backs the file up first).
  migrate(db);
  db.exec(PO_SCHEMA);
  return db;
}

/** The office's migration, compared with each request's X-Collab-Schema. */
export function officeSchema(db: Store): string {
  return latestMigration(db) ?? "unknown";
}

export function closeStore(db: Store): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) {
    try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  }
  db.close();
}

// ---------------------------------------------------------------- numbers
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The number the next NEW ulid will get. */
export function nextNumber(db: Store): number {
  return Number(getMeta(db, "counter") ?? 0) + 1;
}

/**
 * E-number for `ulid` (D7). Idempotent by ulid: a retried request gets the same
 * number (E-713). The increment and the record commit in ONE transaction, so a
 * number is never handed out twice and never silently skipped by a failure.
 */
export function allocate(db: Store, ulid: unknown, deviceId: string | null): number {
  if (typeof ulid !== "string" || !ULID_RE.test(ulid)) throw new StoreError(`not a ULID: ${String(ulid).slice(0, 40)}`);
  return db.transaction(() => {
    const hit = db.prepare(`SELECT id FROM po_allocations WHERE ulid = ?`).get(ulid) as { id: number } | undefined;
    if (hit) return hit.id;
    const id = nextNumber(db);
    setMeta(db, "counter", String(id));
    db.prepare(`INSERT INTO po_allocations (ulid, id, device_id) VALUES (?, ?, ?)`).run(ulid, id, deviceId);
    return id;
  }).immediate();
}

// ---------------------------------------------------------------- members
export interface Member {
  device_id: string;
  name: string;
  joined_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  receive_bookmark: number;
}
export const JOIN_TTL_HOURS = 168; // a join code is valid for 7 days

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function sameHash(storedHex: string, candidate: string): boolean {
  const a = Buffer.from(storedHex, "hex");
  const b = Buffer.from(sha256(candidate), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const MEMBER_COLS = `device_id, name, joined_at, revoked_at, last_seen_at, receive_bookmark`;

/** Pre-register a device and mint its one-time join secret (only its hash is stored). */
export function addMember(db: Store, name: string, opts: { ttlHours?: number } = {}): { deviceId: string; secret: string } {
  const n = String(name ?? "").trim();
  if (!n) throw new StoreError("a member needs a name");
  const deviceId = "d-" + randomBytes(5).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const ttl = opts.ttlHours ?? JOIN_TTL_HOURS;
  db.prepare(
    `INSERT INTO po_members (device_id, name, join_hash, join_expires_at) VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(deviceId, n, sha256(secret), `${ttl >= 0 ? "+" : ""}${ttl} hours`);
  return { deviceId, secret };
}

/** Trade a one-time join secret for the device's key (D12). Only the key's hash is kept. */
export function redeemJoin(db: Store, deviceId: string, secret: string): { key: string } {
  return db.transaction(() => {
    const m = db
      .prepare(`SELECT join_hash, join_expires_at < datetime('now') AS expired, revoked_at FROM po_members WHERE device_id = ?`)
      .get(deviceId) as { join_hash: string | null; expired: number; revoked_at: string | null } | undefined;
    if (!m || !m.join_hash || m.revoked_at || !sameHash(m.join_hash, String(secret))) {
      throw new StoreError("this join code is not valid (already used, revoked, or never issued)", 403);
    }
    if (m.expired) throw new StoreError("this join code has expired; ask for a new one", 403);
    const key = randomBytes(32).toString("base64url");
    db.prepare(
      `UPDATE po_members SET key_hash = ?, join_hash = NULL, join_expires_at = NULL,
              joined_at = datetime('now'), last_seen_at = datetime('now') WHERE device_id = ?`,
    ).run(sha256(key), deviceId);
    return { key };
  }).immediate();
}

/** `Authorization: Bearer <device>:<key>` -> the member, or null (unknown, wrong key, or revoked). */
export function authenticate(db: Store, header: string | undefined): Member | null {
  const m = /^Bearer ([^:\s]+):(\S+)$/.exec(header ?? "");
  if (!m) return null;
  const row = db.prepare(`SELECT ${MEMBER_COLS}, key_hash FROM po_members WHERE device_id = ?`).get(m[1]) as
    | (Member & { key_hash: string | null })
    | undefined;
  if (!row || row.revoked_at || !row.key_hash || !sameHash(row.key_hash, m[2])) return null;
  db.prepare(`UPDATE po_members SET last_seen_at = datetime('now') WHERE device_id = ?`).run(row.device_id);
  const { key_hash: _kh, ...member } = row;
  return member;
}

export function isRevoked(db: Store, deviceId: string): boolean {
  const r = db.prepare(`SELECT revoked_at FROM po_members WHERE device_id = ?`).get(deviceId) as { revoked_at: string | null } | undefined;
  return !r || r.revoked_at !== null;
}

export function listMembers(db: Store): Member[] {
  return db.prepare(`SELECT ${MEMBER_COLS} FROM po_members ORDER BY created_at, rowid`).all() as Member[];
}

/** Revoke by device id or by name (a name must be unambiguous). Effective on the next request (D12). */
export function revokeMember(db: Store, who: string): Member {
  const rows = db.prepare(`SELECT ${MEMBER_COLS} FROM po_members WHERE device_id = ? OR name = ?`).all(who, who) as Member[];
  if (rows.length === 0) throw new StoreError(`no member called ${who}`, 404);
  if (rows.length > 1) throw new StoreError(`${rows.length} members are called ${who}; revoke by device id: ${rows.map((r) => r.device_id).join(", ")}`);
  db.prepare(`UPDATE po_members SET revoked_at = COALESCE(revoked_at, datetime('now')), join_hash = NULL WHERE device_id = ?`).run(rows[0].device_id);
  return { ...rows[0], revoked_at: rows[0].revoked_at ?? "now" };
}

export interface StatusRow {
  device_id: string;
  name: string;
  state: "waiting to join" | "revoked" | "up to date" | "behind";
  behind: number;
  last_seen_at: string | null;
}

/** "Team status" (D12): who is up to date, behind, or not seen lately. */
export function teamStatus(db: Store): StatusRow[] {
  const behindQ = db.prepare(`SELECT COUNT(*) c FROM po_deliveries WHERE seq > ? AND origin <> ?`);
  return listMembers(db).map((m) => {
    if (m.revoked_at) return { device_id: m.device_id, name: m.name, state: "revoked", behind: 0, last_seen_at: m.last_seen_at };
    if (!m.joined_at) return { device_id: m.device_id, name: m.name, state: "waiting to join", behind: 0, last_seen_at: null };
    const behind = (behindQ.get(m.receive_bookmark, m.device_id) as { c: number }).c;
    return { device_id: m.device_id, name: m.name, state: behind === 0 ? "up to date" : "behind", behind, last_seen_at: m.last_seen_at };
  });
}

// ---------------------------------------------------------------- shared modules (D10)
export function sharedModules(db: Store): string[] {
  return (db.prepare(`SELECT slug FROM po_shared_modules ORDER BY slug`).all() as Array<{ slug: string }>).map((r) => r.slug);
}

/** Opt a module in or out for the whole team. Un-sharing stops future sends only. */
export function setModuleShared(db: Store, slug: string, shared: boolean): string[] {
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) throw new StoreError(`not a module slug: ${String(slug)}`);
  if (shared) db.prepare(`INSERT OR IGNORE INTO po_shared_modules (slug) VALUES (?)`).run(slug);
  else db.prepare(`DELETE FROM po_shared_modules WHERE slug = ?`).run(slug);
  return sharedModules(db);
}
