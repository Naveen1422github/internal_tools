// file: core/src/sync/address.ts
// This laptop's place in the office, and moving the office's address (UI
// parity Task 11). `collab sync set-address` and the web's Settings page call
// the same check: an address where anything but this notebook's post office
// answers is refused, and nothing changes.
import type { DB } from "../db.js";
import { lastResolution, describeResolution } from "../db.js";
import { getSyncValue, setSyncValue } from "./state.js";
import { SYNC_KEYS } from "./http-allocator.js";
import { connectPinned } from "./http.js";
import { PinMismatchError } from "./errors.js";

export interface ThisLaptop {
  notebook: { name: string | null; path: string; described: string } | null;
  /** null: this notebook has never joined a post office. */
  device_id: string | null;
  post_office: { url: string; fingerprint: string } | null;
}

/** What this laptop is: its open notebook, its device id and its post office (settings, read-only). */
export function thisLaptop(db: DB): ThisLaptop {
  const r = lastResolution();
  const url = getSyncValue(db, SYNC_KEYS.url);
  const fingerprint = getSyncValue(db, SYNC_KEYS.fingerprint);
  return {
    notebook: r ? { name: r.name, path: r.path, described: describeResolution(r) } : null,
    device_id: getSyncValue(db, SYNC_KEYS.device) ?? null,
    post_office: url && fingerprint ? { url, fingerprint } : null,
  };
}

/** `https://host:port`, without a trailing slash, or null when it isn't one. */
export function normalizeOfficeUrl(raw: string): string | null {
  const url = String(raw ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/.test(url) ? url : null;
}

/**
 * Is this notebook's post office the one answering at `url`? null when it is;
 * otherwise the reason, in `collab sync set-address`'s words. The certificate
 * pinned at join is the proof.
 */
export async function checkPostOfficeAt(url: string, fingerprint: string, timeoutMs = 5000): Promise<string | null> {
  try {
    (await connectPinned({ url, fingerprint }, timeoutMs)).destroy();
    return null;
  } catch (e) {
    if (e instanceof PinMismatchError) return `${url} answers with a different certificate, so it is not your post office. Nothing changed.`;
    return `could not reach a post office at ${url} (${(e as Error).message}). Nothing changed.`;
  }
}

/**
 * Point this notebook at its post office's new address, after checkPostOfficeAt.
 * Answers null when done, else why not (nothing changed). The courier's own
 * config file is the courier's business (courier setPostOfficeAddress).
 */
export async function moveOfficeAddress(db: DB, rawUrl: string): Promise<string | null> {
  const url = normalizeOfficeUrl(rawUrl);
  if (!url) return "the address must look like https://host:port, e.g. https://192.168.1.40:7443";
  const fingerprint = getSyncValue(db, SYNC_KEYS.fingerprint);
  if (!fingerprint) return "this notes DB has no post office certificate on record; run collab sync setup <join code>";
  const why = await checkPostOfficeAt(url, fingerprint);
  if (why) return why;
  setSyncValue(db, SYNC_KEYS.url, url);
  return null;
}
