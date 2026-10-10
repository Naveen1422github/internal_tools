// file: core/src/sync/overview.ts
import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../db.js";
import { getSyncValue, isSyncEnabled } from "./state.js";
import { readOwnChanges } from "./changes.js";
import { ensureCrsqlite } from "./extension.js";
import { courierDir as defaultCourierDir, courierFiles } from "./courier-paths.js";
import { SYNC_KEYS } from "./http-allocator.js";
import { SHARED_KEY, SENT_KEY, sendContext, sendVerdictOf, type NotePlace } from "./send-filter.js";

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
 * This laptop's own changes since the sent-bookmark that the courier will send
 * (verdict "send") or that wait to be sent (verdict "hold": a pending note, or
 * a team project not learned yet). The SAME rule as the courier's push
 * (send-filter.ts), so the status can never disagree with what is sent. Team
 * notes count without any shared module.
 */
export function unsentSharedCount(db: DB): number {
  if (!isSyncEnabled(db)) return 0;
  ensureCrsqlite(db);
  const since = Number(getSyncValue(db, SENT_KEY) ?? 0);
  const ctx = sendContext(db);
  const memo = new Map<string, NotePlace>();
  let n = 0;
  for (const w of readOwnChanges(db, since)) {
    if (sendVerdictOf(db, w, ctx, memo).verdict !== "skip") n++;
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
