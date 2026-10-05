// file: core/src/ops/merge.ts
import type { DB } from "../db.js";
import { estimateTokens } from "../db.js";
import { ownerOf } from "../entry-write.js";
import { headsOf, revisionsOf, snapshotForRevision, finishRevision } from "../revisions.js";
import { ensureCrsqlite } from "../sync/extension.js";
import { formatEntryRef } from "../entry-ref.js";

// Settling a note whose edits collided (spec part 2, V4/V5). The caller says
// which versions it showed the person (expectedHeads); if another edit arrived
// meanwhile, nothing is written (VersionsChangedError -> HTTP 409).

export class VersionsChangedError extends Error {
  constructor(id: number) {
    super(`${formatEntryRef(id)} changed while you were deciding; reload the versions`);
    this.name = "VersionsChangedError";
  }
}

export class NeedsMergeError extends Error {
  constructor(readonly id: number) {
    super(`${formatEntryRef(id)} needs a merge first: open /merge/${id} in the collab web UI`);
    this.name = "NeedsMergeError";
  }
}

export interface MergeVersion { rev_id: string; title: string; summary: string; description: string | null; author: string | null; created_at: string }
export interface MergeView { id: number; current: { title: string; summary: string; description: string | null }; heads: MergeVersion[] }

export function currentHeads(db: DB, ulid: string): string[] {
  return headsOf(revisionsOf(db, ulid)).map((h) => h.rev_id).sort();
}

function flaggedUlid(db: DB, id: number): string {
  const owner = ownerOf(db, id);
  if (!owner || !owner.ulid) throw new Error(`no entry found with id ${id}`);
  const r = db.prepare(`SELECT needs_merge FROM entries WHERE ulid = ?`).get(owner.ulid) as { needs_merge: number } | undefined;
  if (!r || r.needs_merge !== 1) throw new Error(`${formatEntryRef(id)} is not waiting for a merge`);
  return owner.ulid as string;
}

/** Throws VersionsChangedError unless the note's versions are exactly `expected`. */
export function assertHeads(db: DB, id: number, ulid: string, expected: string[]): void {
  const now = currentHeads(db, ulid);
  const want = [...new Set(expected)].sort();
  if (now.length !== want.length || now.some((h, i) => h !== want[i])) throw new VersionsChangedError(id);
}

export function getMergeView(db: DB, id: number): MergeView {
  const ulid = flaggedUlid(db, id);
  const cur = db.prepare(`SELECT title, summary, description FROM entries WHERE ulid = ?`).get(ulid) as MergeView["current"];
  const heads = headsOf(revisionsOf(db, ulid)).map((h) => ({
    rev_id: h.rev_id, title: h.title, summary: h.summary, description: h.description, author: h.author ?? null, created_at: h.created_at,
  }));
  return { id, current: cur, heads };
}

/** Pick a version or save a hand-combined text. Any write here settles the flag (finishRevision folds every head). */
export function resolveWithText(
  db: DB,
  a: { id: number; expectedHeads: string[]; title: string; summary: string; description: string | null },
): { id: number } {
  ensureCrsqlite(db);
  if (!a.title?.trim()) throw new Error("title cannot be blank");
  if (!a.summary?.trim()) throw new Error("summary cannot be blank");
  if (a.summary.length > 200) throw new Error(`summary exceeds 200 chars (got ${a.summary.length})`);
  db.transaction(() => {
    const ulid = flaggedUlid(db, a.id);
    assertHeads(db, a.id, ulid, a.expectedHeads);
    const before = snapshotForRevision(db, ulid);
    db.prepare(
      `UPDATE entries SET title = ?, summary = ?, description = ?, tokens_estimate = ? WHERE ulid = ?`,
    ).run(a.title, a.summary, a.description, estimateTokens(a.description), ulid);
    finishRevision(db, before);
  })();
  return { id: a.id };
}
