// file: core/src/sync/allocator.ts
// Sharing on => E-numbers come only from the post office (spec D7, collab
// E-648/E-708). E-713: idempotent by ulid, retried with the SAME ulid.
import type { DB } from "../db.js";
import { PostOfficeUnreachableError } from "./errors.js";
import { httpAllocatorFromDb } from "./http-allocator.js";

export { PostOfficeUnreachableError, SyncAllocationRequiredError } from "./errors.js";

export interface Allocator {
  /** The number for `ulid` in `series` (`E`, or a team project's code; stage C). */
  allocate(ulid: string, series: string): Promise<number>;
}
let current: Allocator | null = null;
export function setAllocator(a: Allocator | null): void { current = a; }
export function getAllocator(): Allocator | null { return current; }

/** An explicitly registered allocator, else the HTTPS one this DB's sync_state configures. */
export function resolveAllocator(db: DB): Allocator | null {
  return current ?? httpAllocatorFromDb(db);
}

export interface RetryPolicy { attempts: number; timeoutMs: number; delaysMs: number[] }
/** 3 tries, 1.5 s each, pauses of 250 ms and 750 ms: about 5 s at worst (E-713). */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, timeoutMs: 1500, delaysMs: [250, 750] };
/**
 * A save asks once, briefly (stage C, E-820): saving never waits on the office.
 * Without an answer the note is saved pending and the courier retries later
 * with the same ulid.
 */
export const SAVE_ATTEMPT: RetryPolicy = { attempts: 1, timeoutMs: 1500, delaysMs: [] };
let policy: RetryPolicy = DEFAULT_RETRY;
export function setAllocationRetry(p: Partial<RetryPolicy> | null): void {
  policy = p ? { ...DEFAULT_RETRY, ...p } : DEFAULT_RETRY;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * Ask for the number for `ulid`, retrying with the SAME ulid: the post office is
 * idempotent by ulid, so if it assigned a number and the answer was lost, the
 * retry gets that same number (E-713). Throws PostOfficeUnreachableError; its
 * `cause` is the last failure (with `retriable: false` when asking again cannot help).
 */
export async function allocateWithRetry(a: Allocator, ulid: string, series = "E", p: RetryPolicy = policy): Promise<number> {
  let last: unknown = new Error("no attempt was made");
  const attempts = Math.max(1, p.attempts);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(p.delaysMs[Math.min(i - 1, p.delaysMs.length - 1)] ?? 0);
    try {
      const id = await withTimeout(Promise.resolve().then(() => a.allocate(ulid, series)), p.timeoutMs);
      if (!Number.isInteger(id) || id < 1) {
        throw Object.assign(new Error(`the post office returned an invalid number (${String(id)})`), { retriable: false });
      }
      return id;
    } catch (e) {
      last = e;
      if ((e as { retriable?: boolean } | null)?.retriable === false) break;
    }
  }
  throw new PostOfficeUnreachableError(last instanceof Error ? last.message : String(last), last);
}
