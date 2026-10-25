// file: core/src/e-project.ts
// E as a project (local-first refactor, Task 1). The legacy "E" series becomes
// the shared project "emp1st", but its notes stay `project_ulid NULL, series
// 'E'` forever and `projects` never holds an E row (CHECK code <> 'E', 0009).
// So E is VIRTUAL: a fixed ulid and a Project built on demand. Anything that
// stores a note's project must go through writeProjectUlid, so E writes NULL.
import type { DB } from "./db.js";
import type { Project } from "./projects.js";
import { getSyncValue } from "./sync/state.js";
import { SYNC_KEYS } from "./sync/http-allocator.js";

export const E_PROJECT_ULID = "0000000000000000000000000E";
/** sync_state: "1" once this notebook has adopted E as the shared project. */
export const E_ADOPTED_KEY = "e_project";
/** sync_state: JSON list of ulids that must never be sent. */
export const NEVER_SEND_KEY = "never_send";
/** sync_state: the project new notes go to when none is named. */
export const DEFAULT_PROJECT_KEY = "default_project";

export function isEAdopted(db: DB): boolean {
  return getSyncValue(db, E_ADOPTED_KEY) === "1";
}

/** E as a Project: "team" once adopted (its team is the connected office), else "solo". */
export function eProject(db: DB): Project {
  return {
    ulid: E_PROJECT_ULID,
    code: "E",
    name: "emp1st",
    mode: isEAdopted(db) ? "team" : "solo",
    team: getSyncValue(db, SYNC_KEYS.fingerprint) || null,
    created_at: "1970-01-01 00:00:00",
    left_at: null,
  };
}

export function isEProject(p: Project | null): boolean {
  return !!p && (p.ulid === E_PROJECT_ULID || p.code === "E");
}

/** The value for `entries.project_ulid`: NULL for E (and for no project), else the project's ulid. */
export function writeProjectUlid(p: Project | null): string | null {
  return !p || isEProject(p) ? null : p.ulid;
}

/** Ulids that must never be sent (a JSON array in sync_state; a bad value reads as empty). */
export function neverSend(db: DB): Set<string> {
  const raw = getSyncValue(db, NEVER_SEND_KEY);
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
