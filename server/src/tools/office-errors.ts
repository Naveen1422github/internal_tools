// file: server/src/tools/office-errors.ts
// The web server's words for failures to talk to the post office, and the
// mapping of core's typed errors to an HTTP answer (UI parity D7). The office's
// own refusals pass through word for word; only a failure to reach it at all
// gets a sentence of ours.
import {
  AccessDeniedError, AccessRevokedError, NotConnectedError, OfficeRefusedError, OfficeUnreachableError, PinMismatchError,
  ProjectClashError, ProjectNotFoundError, ReadOnlyNoteError, SchemaMismatchError,
} from '@collab-mcp/core';

export const NOT_CONNECTED = "This notebook isn't connected to a post office.";
export const REVOKED = "This laptop's access to the post office was revoked.";
export const UNREACHABLE = "The post office can't be reached right now.";

/** Core's message without its "[collab] " / "[collab-mcp] " prefix. */
export const plain = (msg: string) => msg.replace(/^\[collab(-mcp)?\] /, '');

/**
 * An HTTP status and `{ error }` for an error thrown by a core operation, or
 * null for an unexpected one (the server's usual 500). `needsUpdate` is the
 * sentence for an office too old to have the route.
 */
export function coreFailure(e: unknown, needsUpdate: string): { status: number; error: string } | null {
  if (e instanceof OfficeUnreachableError) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof AccessRevokedError) return { status: 403, error: REVOKED };
    if (cause instanceof SchemaMismatchError) return { status: 409, error: cause.message };
    // Something else answers at the office's address: say so, never "can't be reached".
    if (cause instanceof PinMismatchError) return { status: 502, error: plain(cause.message) };
    return { status: 503, error: UNREACHABLE };
  }
  if (e instanceof OfficeRefusedError) {
    if (e.oldOffice) return { status: 501, error: needsUpdate };
    if (e.status >= 500) return { status: 502, error: e.officeError ?? plain(e.message) };
    return { status: e.status, error: e.officeError ?? plain(e.message) };
  }
  if (e instanceof ProjectClashError) return { status: 409, error: plain(e.message) };
  if (e instanceof ProjectNotFoundError) return { status: 404, error: plain(e.message) };
  if (e instanceof AccessDeniedError || e instanceof ReadOnlyNoteError) return { status: 403, error: plain(e.message) };
  if (e instanceof NotConnectedError) return { status: 409, error: NOT_CONNECTED };
  const msg = e instanceof Error ? e.message : '';
  // A notebook behind on migrations: the server's state, not the request (it migrates on start).
  if (/^\[collab\] .* needs migration \d{4}/.test(msg)) return { status: 503, error: plain(msg) };
  if (/^\[collab\] \S+ is a team project of another post office/.test(msg)) return { status: 409, error: plain(msg) };
  // Core's own refusals of bad input ("a project needs a name", "no module ...").
  if (/^\[collab(-mcp)?\] /.test(msg)) return { status: 400, error: plain(msg) };
  return null;
}
