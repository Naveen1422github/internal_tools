/**
 * Local cache of this laptop's permissions (table access_cache, migration 0012).
 * Never synced: the courier refills it from the post office.
 */
import type { DB } from "../db.js";
import { sanitizeKeys } from "./catalog.js";

export interface AccessPayload {
  office: { role: string; keys: string[] } | null;
  projects: Array<{
    ulid: string;
    code: string;
    role: string;
    keys: string[];
    ai: Record<string, "allow" | "ask" | "deny">;
  }>;
  replays: Array<{ project_ulid: string; upto_seq: number }>;
  /** Whether the office adopted E, and whether this device holds note.view in it (absent from an older office). */
  eProject?: { adopted: boolean; member: boolean };
}

export interface CachedAccess {
  role: string;
  keys: Set<string>;
  ai: Record<string, string>;
}

/** Replace every row in one transaction; return project ULIDs cached before and absent now. */
export function writeAccessCache(db: DB, p: AccessPayload): { dropped: string[] } {
  const run = db.transaction((): { dropped: string[] } => {
    const before = (db.prepare(`SELECT project_ulid FROM access_cache WHERE project_ulid IS NOT NULL`).all() as Array<{ project_ulid: string }>)
      .map((r) => r.project_ulid);
    db.prepare(`DELETE FROM access_cache`).run();
    const ins = db.prepare(`INSERT INTO access_cache (scope_key, project_ulid, role_name, keys, ai) VALUES (?, ?, ?, ?, ?)`);
    if (p.office) ins.run("office", null, p.office.role, JSON.stringify(sanitizeKeys("office", p.office.keys)), "{}");
    const now = new Set<string>();
    for (const pr of p.projects) {
      now.add(pr.ulid);
      ins.run(pr.ulid, pr.ulid, pr.role, JSON.stringify(sanitizeKeys("project", pr.keys)), JSON.stringify(pr.ai ?? {}));
    }
    return { dropped: before.filter((u) => !now.has(u)) };
  });
  return run();
}

export function readAccessCache(db: DB): Map<string, CachedAccess> {
  const rows = db.prepare(`SELECT scope_key, role_name, keys, ai FROM access_cache`).all() as Array<{
    scope_key: string; role_name: string; keys: string; ai: string;
  }>;
  const out = new Map<string, CachedAccess>();
  for (const r of rows) {
    out.set(r.scope_key, { role: r.role_name, keys: new Set(JSON.parse(r.keys) as string[]), ai: JSON.parse(r.ai) as Record<string, string> });
  }
  return out;
}
