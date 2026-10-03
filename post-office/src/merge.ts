// file: post-office/src/merge.ts
// Replaced in Task 9 (three-way merge, divergence, needs_merge).
import type { RawChange } from "@collab-mcp/core";
import type { Store } from "./store.js";
export function divergentStatusOrType(_db: Store, _raw: RawChange): string | null { return null; }
export function flagNeedsMerge(_db: Store, _ulid: string): void {}
export function mergeEntries(_db: Store, _ulids: Iterable<string>): void {}
