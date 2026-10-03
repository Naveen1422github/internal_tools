// Sharing on => E-numbers come only from the post office (spec D7, collab
// E-648/E-708). The real HTTP allocator is registered by Plan 2; tests use stubs.
export interface Allocator {
  allocate(ulid: string): Promise<number>;
}
let current: Allocator | null = null;
export function setAllocator(a: Allocator | null): void { current = a; }
export function getAllocator(): Allocator | null { return current; }

export class PostOfficeUnreachableError extends Error {
  constructor(detail: string) {
    super(`[collab-mcp] Not saved: this notes database is shared, and a note number could not be obtained from the post office (${detail}). Nothing was written. Start the post office (or reconnect), then retry.`);
    this.name = "PostOfficeUnreachableError";
  }
}
export class SyncAllocationRequiredError extends Error {
  constructor() {
    super(`[collab-mcp] This notes database is shared, so new note numbers must come from the post office. Use addEntryAsync. (rollup/archive are not available while sharing is on in v1.)`);
    this.name = "SyncAllocationRequiredError";
  }
}
