// file: core/src/sync/errors.ts
// Errors shared by the allocator, the HTTPS client and the courier (sync v1).
// `retriable = false` stops addEntryAsync's retries at once (E-713).

export class PostOfficeUnreachableError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(
      `[collab-mcp] Not saved: this notes database is shared, and a note number could not be obtained from the post office (${detail}). Nothing was written. Start the post office (or reconnect), then retry.`,
      { cause },
    );
    this.name = "PostOfficeUnreachableError";
  }
}

export class SyncAllocationRequiredError extends Error {
  constructor() {
    super(`[collab-mcp] This notes database is shared, so new note numbers must come from the post office. Use addEntryAsync. (rollup/archive are not available while sharing is on in v1.)`);
    this.name = "SyncAllocationRequiredError";
  }
}

/** D13: the certificate is not the one the join code pinned. Possibly an impostor. */
export class PinMismatchError extends Error {
  readonly retriable = false;
  constructor(url: string, expected: string, got: string) {
    super(
      `[collab-mcp] Refusing to talk to ${url}: its certificate (${got.slice(0, 16)}…) is not the one pinned by the join code (${expected.slice(0, 16)}…). Something else may be pretending to be the post office.`,
    );
    this.name = "PinMismatchError";
  }
}

/** D12: 401. The key was revoked (or never issued). */
export class AccessRevokedError extends Error {
  readonly retriable = false;
  constructor(url: string) {
    super(`[collab-mcp] The post office at ${url} refused this machine's key: access revoked or unknown. Ask its owner for a new join code.`);
    this.name = "AccessRevokedError";
  }
}
