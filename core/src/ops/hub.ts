import type { DB } from "../db.js";
import { hasUlidColumns } from "../db.js";
import { liveEntry } from "../schema.js";
import { ownerOf } from "../entry-write.js";

// T-011: one main note (hub) per module (E-657). All "is it linked?" logic
// lives here. Rules:
// - Linked is decided ONLY via refs.target_ulid, never by E-number (E-648:
//   E-numbers can collide across machines).
// - A link to a deprecated note follows superseded_by_ulid to its live
//   replacement. With no live replacement the link is EXPIRED: it stops
//   counting, is reported, and is never deleted here (deleting refs would
//   fight cr-sqlite sync and erase history).
// - Reach = hub's links + their links (2 hops).

export const IMPORTANT_TYPES = ["decision", "proposal", "gotcha"] as const;
const MAX_HOPS = 10;

export interface LiveTarget {
  ulid: string;
  id: number;
  title: string;
  followed: boolean; // true when reached through a supersede chain
}

export type HubState = "unset" | "retired" | "ok";

export interface HubCoverage {
  hub: LiveTarget;
  linked_count: number;
  unlinked_count: number;
  unlinked: Array<{ id: number; type: string; title: string }>;
  expired: Array<{ from_id: number; to_id: number | null; to_ref: string }>;
}

/** Follow the supersede chain from `ulid` to a live, non-deprecated entry; null if retired, tombstoned, missing or cyclic. */
export function resolveLive(db: DB, ulid: string): LiveTarget | null {
  const stmt = db.prepare(
    `SELECT e.ulid, e.id, e.title, e.deprecated, e.superseded_by_ulid FROM entries e
      WHERE e.ulid = ? AND ${liveEntry(db, "e")}`,
  );
  const seen = new Set<string>();
  let cur = ulid;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const r = stmt.get(cur) as
      | { ulid: string; id: number; title: string; deprecated: number; superseded_by_ulid: string | null }
      | undefined;
    if (!r) return null;
    if (r.deprecated === 0) return { ulid: r.ulid, id: r.id, title: r.title, followed: hop > 0 };
    if (!r.superseded_by_ulid) return null;
    cur = r.superseded_by_ulid;
  }
  return null;
}

export function setModuleHub(
  db: DB,
  args: { slug: string; id: number | null },
): { slug: string; hub: { id: number; ulid: string; title: string } | null } {
  if (!hasUlidColumns(db)) throw new Error("main notes need migration 0005 or later");
  const mod = db.prepare(`SELECT slug FROM modules WHERE slug = ?`).get(args.slug);
  if (!mod) throw new Error(`module '${args.slug}' not found; create it with collab_module_init first`);

  if (args.id === null) {
    db.prepare(`UPDATE modules SET hub = NULL WHERE slug = ?`).run(args.slug);
    return { slug: args.slug, hub: null };
  }

  const owner = ownerOf(db, args.id);
  if (!owner || owner.ulid === null) throw new Error(`no entry found with id ${args.id}`);
  const member = db
    .prepare(`SELECT 1 FROM entry_modules WHERE entry_ulid = ? AND module = ?`)
    .get(owner.ulid, args.slug);
  if (!member) throw new Error(`E-${String(args.id).padStart(5, "0")} is not in module '${args.slug}'`);
  const live = resolveLive(db, owner.ulid);
  if (!live || live.followed) throw new Error(`E-${String(args.id).padStart(5, "0")} is deprecated; pick a live note`);

  db.prepare(`UPDATE modules SET hub = ? WHERE slug = ?`).run(owner.ulid, args.slug);
  return { slug: args.slug, hub: { id: live.id, ulid: live.ulid, title: live.title } };
}

export function getHubStatus(
  db: DB,
  slug: string,
  limit = 5,
): { state: HubState; coverage: HubCoverage | null } {
  if (!hasUlidColumns(db)) return { state: "unset", coverage: null };
  const row = db.prepare(`SELECT hub FROM modules WHERE slug = ?`).get(slug) as { hub: string | null } | undefined;
  if (!row || !row.hub) return { state: "unset", coverage: null };
  const hub = resolveLive(db, row.hub);
  if (!hub) return { state: "retired", coverage: null };

  const outLinks = db.prepare(
    `SELECT target_ulid, ref_value FROM refs
      WHERE entry_ulid = ? AND ref_type = 'entry' AND target_ulid IS NOT NULL`,
  );
  const idOf = db.prepare(`SELECT id FROM entries WHERE ulid = ?`);

  const reach = new Set<string>();
  const expired: HubCoverage["expired"] = [];
  const firstHop: string[] = [];
  for (const l of outLinks.all(hub.ulid) as Array<{ target_ulid: string; ref_value: string }>) {
    const t = resolveLive(db, l.target_ulid);
    if (!t) {
      const r = idOf.get(l.target_ulid) as { id: number | null } | undefined;
      expired.push({ from_id: hub.id, to_id: r?.id ?? null, to_ref: l.ref_value });
      continue;
    }
    if (!reach.has(t.ulid)) firstHop.push(t.ulid);
    reach.add(t.ulid);
  }
  for (const u of firstHop) {
    for (const l of outLinks.all(u) as Array<{ target_ulid: string }>) {
      const t = resolveLive(db, l.target_ulid);
      if (t) reach.add(t.ulid);
    }
  }

  const types = IMPORTANT_TYPES.map((t) => `'${t}'`).join(",");
  const candidates = db
    .prepare(
      `SELECT e.ulid, e.id, e.type, e.title FROM entries e
        WHERE e.ulid IN (SELECT entry_ulid FROM entry_modules WHERE module = ?)
          AND ${liveEntry(db, "e")} AND e.deprecated = 0
          AND e.type IN (${types}) AND e.ulid != ?
        ORDER BY e.created_at DESC, e.ulid DESC`,
    )
    .all(slug, hub.ulid) as Array<{ ulid: string; id: number; type: string; title: string }>;
  const unlinked = candidates.filter((c) => !reach.has(c.ulid));

  return {
    state: "ok",
    coverage: {
      hub,
      linked_count: candidates.length - unlinked.length,
      unlinked_count: unlinked.length,
      unlinked: unlinked.slice(0, limit).map(({ id, type, title }) => ({ id, type, title })),
      expired,
    },
  };
}
