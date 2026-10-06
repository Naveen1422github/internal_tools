// file: core/src/sync/overview.ts
import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../db.js";
import { getSyncValue, isSyncEnabled } from "./state.js";
import { readOwnChanges, entryUlidOf } from "./changes.js";
import { ensureCrsqlite } from "./extension.js";
import { hasSeries } from "../schema.js";
import { courierDir as defaultCourierDir, courierFiles } from "./courier-paths.js";
import { SYNC_KEYS } from "./http-allocator.js";

// The courier's own sync_state keys (courier/src/keys.ts COURIER_KEYS; core cannot import the courier).
const SHARED_KEY = "shared_modules";
const SENT_KEY = "sent_db_version";

// What the web UI's status bar shows (spec part 2, V1): read from THIS laptop
// only. Never returns the device key or any sync_state value not listed below.

export type SyncHealth = "ok" | "behind" | "not-syncing" | "needs-update" | "revoked" | "unknown";
export type SyncOverview =
  | { enabled: false }
  | {
      enabled: true;
      postOffice: string;
      deviceId: string;
      sharedModules: string[];
      unsent: number;
      courier: { running: boolean; state: string; lastError: string | null; lastPushAt: string | null; lastPullAt: string | null };
      lastContactAt: string | null;
      health: SyncHealth;
    };

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

function sharedSet(db: DB): Set<string> {
  try { return new Set(JSON.parse(getSyncValue(db, SHARED_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

/**
 * This laptop's own changes since the sent-bookmark whose note's PRIMARY module
 * is shared. A note in a project is never sent by this path (stage B1), so it
 * never waits either (same filter as the courier's push).
 */
export function unsentSharedCount(db: DB): number {
  if (!isSyncEnabled(db)) return 0;
  ensureCrsqlite(db);
  const shared = sharedSet(db);
  if (shared.size === 0) return 0;
  const since = Number(getSyncValue(db, SENT_KEY) ?? 0);
  const moduleOf = new Map<string, string | null>();
  const projectCol = hasSeries(db) ? "project_ulid" : "NULL";
  let n = 0;
  for (const w of readOwnChanges(db, since)) {
    const pk = Buffer.from(w.pk, "base64");
    let module: string | null;
    if (w.table === "modules") {
      const r = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
      module = r ? String(r.cell) : null;
    } else {
      const ulid = entryUlidOf(db, w.table, pk);
      if (!ulid) continue;
      if (!moduleOf.has(ulid)) {
        const e = db.prepare(`SELECT module, ${projectCol} AS project FROM entries WHERE ulid = ?`)
          .get(ulid) as { module: string | null; project: string | null } | undefined;
        moduleOf.set(ulid, e?.project ? null : e?.module ?? null); // a project note: no module to send under
      }
      module = moduleOf.get(ulid) ?? null;
    }
    if (module && shared.has(module)) n++;
  }
  return n;
}

export function readSyncOverview(
  db: DB,
  opts: { courierDir?: string; isAlive?: (pid: number) => boolean } = {},
): SyncOverview {
  if (!isSyncEnabled(db)) return { enabled: false };
  const files = courierFiles(opts.courierDir ?? defaultCourierDir());
  const isAlive = opts.isAlive ?? defaultIsAlive;
  let st: any = null;
  try { st = existsSync(files.status) ? JSON.parse(readFileSync(files.status, "utf8")) : null; } catch { st = null; }
  let pid: number | null = null;
  try { pid = Number(readFileSync(files.pid, "utf8").trim()) || null; } catch { pid = st?.pid ?? null; }
  const running = pid !== null && isAlive(pid);
  const unsent = unsentSharedCount(db);
  const lastPushAt: string | null = st?.lastPushAt ?? null;
  const lastPullAt: string | null = st?.lastPullAt ?? null;
  const lastContactAt = [lastPushAt, lastPullAt].filter(Boolean).sort().pop() ?? null;
  const state: string = st?.state ?? "unknown";
  let health: SyncHealth;
  if (!st) health = "unknown";
  else if (!running) health = "not-syncing";
  else if (state === "needs-update") health = "needs-update";
  else if (state === "revoked") health = "revoked";
  else if (state === "offline" || state === "starting" || unsent > 0) health = "behind";
  else health = "ok";
  return {
    enabled: true,
    postOffice: getSyncValue(db, SYNC_KEYS.url) ?? "",
    deviceId: getSyncValue(db, SYNC_KEYS.device) ?? "",
    sharedModules: [...sharedSet(db)].sort(),
    unsent,
    courier: { running, state, lastError: st?.lastError ?? null, lastPushAt, lastPullAt },
    lastContactAt,
    health,
  };
}
