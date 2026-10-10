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
  /** JSON list: team project ulids whose older notes were already sent (stage C: promote, or a project learned late). */
  backfilledProjects: "backfilled_projects",
  /** JSON list of {code, office_ulid, local_ulid, local_code}: team projects that clash with a local one (P10). Non-empty = pulling is paused. */
  projectClash: "project_clash",
} as const;
