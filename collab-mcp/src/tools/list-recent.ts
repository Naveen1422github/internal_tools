import type { DB } from "../db.js";
import { searchEntries, type SearchResult } from "./search.js";
import type { EntryType } from "./add.js";

export interface ListRecentArgs {
  type?: EntryType;
  module?: string;
  task?: string;
  since?: string;                       // default '7d'
  limit?: number;                       // default 10, max 50
  kind?: "signal" | "log" | "any";      // default 'signal'
  include_deprecated?: boolean;         // default false
}

/**
 * Thin wrapper over searchEntries with an empty query.
 * searchEntries already does filter-only mode (no FTS) when query is empty,
 * orders by created_at DESC, and applies the same auto-expand rule.
 */
export function listRecent(db: DB, args: ListRecentArgs): SearchResult {
  return searchEntries(db, {
    query: "",
    module: args.module,
    task: args.task,
    type: args.type,
    kind: args.kind ?? "signal",
    status: undefined,
    since: args.since ?? "7d",
    include_deprecated: args.include_deprecated ?? false,
    limit: args.limit ?? 10,
  });
}
