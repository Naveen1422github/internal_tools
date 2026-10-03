// file: core/src/sync/http-allocator.ts
import type { DB } from "../db.js";
import type { Allocator } from "./allocator.js"; // type-only: no runtime cycle
import { getSyncValue } from "./state.js";
import { requestJson, type PostOfficeTarget } from "./http.js";

// The real allocator (spec D7): POST /v1/allocate {ulid} -> {id}. Its config
// lives in the DB's LOCAL-ONLY sync_state, written by `collab sync setup`, so
// every writer process (MCP, REST, scripts, Codex runs) finds it without code.
export const SYNC_KEYS = {
  url: "po_url",
  fingerprint: "po_fingerprint",
  device: "device_id",
  key: "device_key",
} as const;

export function postOfficeTargetFromDb(db: DB): PostOfficeTarget | null {
  const url = getSyncValue(db, SYNC_KEYS.url);
  const fingerprint = getSyncValue(db, SYNC_KEYS.fingerprint);
  const device = getSyncValue(db, SYNC_KEYS.device);
  const key = getSyncValue(db, SYNC_KEYS.key);
  if (!url || !fingerprint || !device || !key) return null;
  return { url, fingerprint, auth: { device, key } };
}

export class HttpAllocator implements Allocator {
  constructor(readonly target: PostOfficeTarget, private readonly timeoutMs = 1500) {}
  async allocate(ulid: string): Promise<number> {
    const r = await requestJson(this.target, "POST", "/v1/allocate", { ulid }, { timeoutMs: this.timeoutMs });
    if (r.status === 200 && Number.isInteger(r.body?.id)) return r.body.id as number;
    const e = new Error(`the post office answered ${r.status}${r.body?.error ? `: ${r.body.error}` : ""}`);
    // A 4xx means the request itself is wrong; asking again cannot help.
    if (r.status >= 400 && r.status < 500) Object.assign(e, { retriable: false });
    throw e;
  }
}

const cache = new WeakMap<DB, { sig: string; allocator: HttpAllocator }>();

export function httpAllocatorFromDb(db: DB): HttpAllocator | null {
  const target = postOfficeTargetFromDb(db);
  if (!target) return null;
  const sig = JSON.stringify(target);
  const hit = cache.get(db);
  if (hit && hit.sig === sig) return hit.allocator;
  const allocator = new HttpAllocator(target);
  cache.set(db, { sig, allocator });
  return allocator;
}
