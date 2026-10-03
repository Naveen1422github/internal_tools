// file: post-office/src/merge.ts
import { randomBytes } from "node:crypto";
import { merge as diff3 } from "node-diff3";
import { revisionsOf, headsOf, splitMerged, estimateTokens, type RawChange, type RevisionRow } from "@collab-mcp/core";
import type { Store } from "./store.js";

// Spec D8: the post office alone merges. Text is never last-writer-wins.

export type FieldMerge = { ok: true; value: string | null } | { ok: false };

export function mergeText(base: string | null, a: string | null, b: string | null, multiline: boolean): FieldMerge {
  if (a === b) return { ok: true, value: a };
  if (a === base) return { ok: true, value: b };
  if (b === base) return { ok: true, value: a };
  if (!multiline) return { ok: false };
  const r = diff3((a ?? "").split("\n"), (base ?? "").split("\n"), (b ?? "").split("\n"));
  return r.conflict ? { ok: false } : { ok: true, value: r.result.join("\n") };
}

/** Newest revision that both x and y descend from (parents and merged_from both count). */
export function commonAncestor(revs: RevisionRow[], x: string, y: string): RevisionRow | null {
  const byId = new Map(revs.map((r) => [r.rev_id, r]));
  const ancestors = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = byId.get(id);
      if (!r) continue;
      if (r.parent_rev_id) stack.push(r.parent_rev_id);
      stack.push(...splitMerged(r.merged_from));
    }
    return seen;
  };
  const ax = ancestors(x);
  const ay = ancestors(y);
  let best: RevisionRow | null = null;
  for (const id of ax) {
    if (!ay.has(id)) continue;
    const r = byId.get(id);
    if (r && (!best || r.created_at > best.created_at || (r.created_at === best.created_at && r.rev_id > best.rev_id))) best = r;
  }
  return best;
}

export function flagNeedsMerge(db: Store, ulid: string): void {
  db.prepare(`UPDATE entries SET needs_merge = 1 WHERE ulid = ? AND needs_merge = 0`).run(ulid);
}

export type MergeOutcome = "single" | "merged" | "needs_merge";

export function mergeEntry(db: Store, ulid: string): MergeOutcome {
  const entry = db.prepare(`SELECT title, summary, description, needs_merge FROM entries WHERE ulid = ?`).get(ulid) as
    | { title: string; summary: string; description: string | null; needs_merge: number }
    | undefined;
  if (!entry) return "single";
  const revs = revisionsOf(db, ulid);
  const heads = headsOf(revs);
  if (heads.length < 2) return "single";
  if (entry.needs_merge === 1) return "needs_merge"; // waiting for a person
  const insert = db.prepare(
    `INSERT INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description, created_at`,
  );
  let cur = heads[0];
  for (const h of heads.slice(1)) {
    const base = commonAncestor(revs, cur.rev_id, h.rev_id);
    const title = mergeText(base?.title ?? "", cur.title, h.title, false);
    const summary = mergeText(base?.summary ?? "", cur.summary, h.summary, false);
    const description = mergeText(base?.description ?? null, cur.description, h.description, true);
    if (!base || !title.ok || !summary.ok || !description.ok) {
      flagNeedsMerge(db, ulid);
      return "needs_merge";
    }
    const merged = insert.get(
      randomBytes(16).toString("hex"), ulid, cur.rev_id, h.rev_id, title.value, summary.value, description.value,
    ) as RevisionRow;
    revs.push(merged);
    cur = merged;
  }
  if (entry.title !== cur.title || entry.summary !== cur.summary || (entry.description ?? null) !== (cur.description ?? null)) {
    db.prepare(`UPDATE entries SET title = ?, summary = ?, description = ?, tokens_estimate = ? WHERE ulid = ?`).run(
      cur.title, cur.summary, cur.description, estimateTokens(cur.description ?? undefined), ulid,
    );
  }
  return "merged";
}

export function mergeEntries(db: Store, ulids: Iterable<string>): void {
  for (const u of ulids) mergeEntry(db, u);
}

/**
 * status/type have no revisions (fixed choices). An incoming change at a column
 * version <= the store's, with a different value, was made without seeing the
 * store's value: two machines chose differently => needs_merge (D8).
 */
export function divergentStatusOrType(db: Store, raw: RawChange): string | null {
  if (raw.table !== "entries" || (raw.cid !== "status" && raw.cid !== "type")) return null;
  const first = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(raw.pk) as { cell: string } | undefined;
  if (!first) return null;
  const cur = db
    .prepare(
      `SELECT c.col_version AS v, e.${raw.cid} AS held
         FROM entries__crsql_pks p
         JOIN entries__crsql_clock c ON c.key = p.__crsql_key AND c.col_name = ?
         JOIN entries e ON e.ulid = p.ulid
        WHERE p.ulid = ?`,
    )
    .get(raw.cid, first.cell) as { v: number; held: string } | undefined;
  if (!cur) return null;
  return raw.col_version <= cur.v && cur.held !== raw.val ? String(first.cell) : null;
}
