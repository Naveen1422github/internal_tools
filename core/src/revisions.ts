// file: core/src/revisions.ts
import type { DB } from "./db.js";
import { resolveAuthor } from "./author.js";

// Spec "Edits write revisions" + D8. Until 0007 a trigger wrote entry_revisions.
// It also fired when cr-sqlite applied a REMOTE edit, minting rows that exist on
// one machine only, so 0007 drops it: every text edit records its revision
// here, inside the writer's transaction.

export interface EntryText { title: string; summary: string; description: string | null }
export interface RevisionRow extends EntryText {
  rev_id: string;
  entry_ulid: string;
  parent_rev_id: string | null;
  merged_from: string | null;
  created_at: string;
  author: string | null;
}
export interface TextSnapshot extends EntryText { ulid: string; created_at: string; needs_merge: number }

/** 0007+: the trigger is gone and entry_revisions.merged_from exists. */
export function writesRevisionsInCode(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entry_revisions') WHERE name = 'merged_from'`).get();
}

/** 0008+: entry_revisions.author exists. New code must still run on a 0007 file. */
export function hasRevisionAuthor(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('entry_revisions') WHERE name = 'author'`).get();
}

/**
 * The first revision of an entry holds its text before the first edit. Its key
 * derives from the entry, so two machines making the first edit at once write
 * the SAME root row and their edits share a merge base.
 */
export const rootRevId = (ulid: string): string => `${ulid}.0`;

export function splitMerged(s: string | null): string[] {
  return s ? s.split(",").filter(Boolean) : [];
}

export function revisionsOf(db: DB, ulid: string): RevisionRow[] {
  const author = hasRevisionAuthor(db) ? "author" : "NULL AS author";
  return db
    .prepare(
      `SELECT rev_id, entry_ulid, parent_rev_id, merged_from, title, summary, description, created_at, ${author}
         FROM entry_revisions WHERE entry_ulid = ? ORDER BY created_at, rev_id`,
    )
    .all(ulid) as RevisionRow[];
}

/** Revisions nothing builds on. Two or more = edits not merged yet. */
export function headsOf(revs: RevisionRow[]): RevisionRow[] {
  const used = new Set<string>();
  for (const r of revs) {
    if (r.parent_rev_id) used.add(r.parent_rev_id);
    for (const m of splitMerged(r.merged_from)) used.add(m);
  }
  return revs.filter((r) => !used.has(r.rev_id));
}

const sameText = (a: EntryText, b: EntryText): boolean =>
  a.title === b.title && a.summary === b.summary && (a.description ?? null) === (b.description ?? null);

/** The entry's text BEFORE an edit. Null below 0007, where the trigger still records revisions. */
export function snapshotForRevision(db: DB, ulid: string): TextSnapshot | null {
  if (!writesRevisionsInCode(db)) return null;
  const r = db
    .prepare(`SELECT ulid, title, summary, description, created_at, needs_merge FROM entries WHERE ulid = ?`)
    .get(ulid) as TextSnapshot | undefined;
  return r ?? null;
}

/**
 * After an edit: append its revision. Parent = the newest revision holding the
 * text the edit started from (else the newest). If the entry was flagged
 * needs_merge, this edit is a person's resolution: it folds every other head in
 * and clears the flag. Returns the new rev_id, or null if nothing changed.
 */
export function finishRevision(db: DB, before: TextSnapshot | null): string | null {
  if (!before) return null;
  const after = db.prepare(`SELECT title, summary, description FROM entries WHERE ulid = ?`).get(before.ulid) as
    | EntryText
    | undefined;
  if (!after) return null;
  const resolving = before.needs_merge === 1;
  if (!resolving && sameText(after, before)) return null;

  const withAuthor = hasRevisionAuthor(db);
  let revs = revisionsOf(db, before.ulid);
  if (revs.length === 0) {
    if (withAuthor) {
      // The root holds the text before the first edit, so it takes the NOTE's author.
      db.prepare(
        `INSERT OR IGNORE INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, title, summary, description, created_at, author)
         VALUES (?, ?, NULL, ?, ?, ?, ?, (SELECT author FROM entries WHERE ulid = ?))`,
      ).run(rootRevId(before.ulid), before.ulid, before.title, before.summary, before.description, before.created_at, before.ulid);
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO entry_revisions (rev_id, entry_ulid, parent_rev_id, title, summary, description, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      ).run(rootRevId(before.ulid), before.ulid, before.title, before.summary, before.description, before.created_at);
    }
    revs = revisionsOf(db, before.ulid);
  }
  const newestFirst = [...revs].reverse();
  const parent = newestFirst.find((r) => sameText(r, before)) ?? newestFirst[0];
  const folded = resolving
    ? headsOf(revs).filter((h) => h.rev_id !== parent.rev_id).map((h) => h.rev_id)
    : [];
  const mergedFrom = folded.length ? folded.join(",") : null;
  const row = (withAuthor
    ? db
        .prepare(
          `INSERT INTO entry_revisions (entry_ulid, parent_rev_id, merged_from, title, summary, description, author)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rev_id`,
        )
        .get(before.ulid, parent.rev_id, mergedFrom, after.title, after.summary, after.description, resolveAuthor())
    : db
        .prepare(
          `INSERT INTO entry_revisions (entry_ulid, parent_rev_id, merged_from, title, summary, description)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING rev_id`,
        )
        .get(before.ulid, parent.rev_id, mergedFrom, after.title, after.summary, after.description)) as {
    rev_id: string;
  };
  if (resolving) db.prepare(`UPDATE entries SET needs_merge = 0 WHERE ulid = ?`).run(before.ulid);
  return row.rev_id;
}
