import type { DB } from "../db.js";
import { connectPinned } from "../sync/http.js";
import { PinMismatchError } from "../sync/errors.js";
import { postOfficeTargetFromDb, SYNC_KEYS } from "../sync/http-allocator.js";
import { getSyncValue, isSyncEnabled } from "../sync/state.js";
import { readSyncOverview } from "../sync/overview.js";
import { courierDir } from "../sync/courier-paths.js";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "sync" as const;

/** Opens a pinned TLS connection to the post office and closes it (no request is sent). */
export async function defaultProbe(db: DB): Promise<"ok" | "unreachable" | "cert-changed"> {
  const t = postOfficeTargetFromDb(db);
  if (!t) return "unreachable";
  try {
    (await connectPinned(t, 4000)).destroy();
    return "ok";
  } catch (e) {
    return e instanceof PinMismatchError ? "cert-changed" : "unreachable";
  }
}

export async function checkSync(ctx: SetupContext, st: GroupState): Promise<SetupCheck[]> {
  const db = st.db!;
  if (!isSyncEnabled(db)) return [{ group: G, id: "sync.off", mark: "skipped", text: "sharing is off for this notebook" }];
  const out: SetupCheck[] = [];
  const url = getSyncValue(db, SYNC_KEYS.url) ?? "(no address)";
  if (!ctx.probePostOffice) {
    out.push({ group: G, id: "sync.office", mark: "skipped", text: "network check not run" });
  } else {
    const p = await ctx.probePostOffice(db);
    if (p === "ok") out.push({ group: G, id: "sync.office", mark: "ok", text: "Post office reachable, certificate matches" });
    else if (p === "unreachable") out.push({ group: G, id: "sync.office", mark: "error", text: `Can't reach the post office at ${url}`, fix: "check the network, or ask whoever runs the post office" });
    else out.push({ group: G, id: "sync.office", mark: "error", text: "The post office's certificate changed. Do not continue", fix: "ask your admin before re-joining" });
  }
  const o = readSyncOverview(db, { courierDir: courierDir(ctx.env), isAlive: ctx.isAlive });
  if (o.enabled) {
    const s = o.courier.state;
    if (s === "connected") out.push({ group: G, id: "sync.courier", mark: "ok", text: `Connected, ${o.unsent} change(s) waiting` });
    else if (s === "offline") out.push({ group: G, id: "sync.courier", mark: "warn", text: `Courier offline since ${o.lastContactAt ?? "it started"}`, fix: "check the network; collab sync status shows the last error" });
    else if (s === "revoked") out.push({ group: G, id: "sync.courier", mark: "error", text: "This laptop's access was revoked", fix: "ask your admin for a new join code" });
    // needs-update is reported by version.office; stopped/starting by programs.courier.
  }
  return out;
}
