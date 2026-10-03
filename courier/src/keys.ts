// file: courier/src/keys.ts
// The courier's bookmarks live in the notes DB's LOCAL-ONLY sync_state, next
// to the post office config (core SYNC_KEYS). Never shared.
export const COURIER_KEYS = {
  /** Own changes up to this db_version are acknowledged by the post office. */
  sent: "sent_db_version",
  /** Deliveries up to this seq are applied here. */
  recv: "recv_seq",
  /** JSON list: the team's shared modules, as last heard from the post office (D10). */
  shared: "shared_modules",
  /** JSON list: shared modules whose older notes were already sent (backfill done). */
  backfilled: "backfilled_modules",
} as const;
