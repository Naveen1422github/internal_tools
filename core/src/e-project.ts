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
/** sync_state: JSON {adopted, member}, the office's last /v1/access answer about E (local-first Task 7). */
export const E_ACCESS_KEY = "e_access";

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

/** Parsed never-send state. A malformed value is unsafe: callers must fail closed. */
export function neverSendState(db: DB): { ulids: Set<string>; valid: boolean } {
  const raw = getSyncValue(db, NEVER_SEND_KEY);
  if (!raw) return { ulids: new Set(), valid: true };
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return { ulids: new Set(), valid: false };
    return { ulids: new Set(v.filter((x): x is string => typeof x === "string")), valid: true };
  } catch {
    return { ulids: new Set(), valid: false };
  }
}

/** Ulids that must never be sent. Prefer neverSendState when deciding whether to send. */
export function neverSend(db: DB): Set<string> {
  return neverSendState(db).ulids;
}

/** What the office last said about E (its /v1/access eProject); an older office, or none yet, reads as not adopted. */
export function cachedEAccess(db: DB): { adopted: boolean; member: boolean } {
  const raw = getSyncValue(db, E_ACCESS_KEY);
  try {
    const v = raw ? JSON.parse(raw) : null;
    return { adopted: v?.adopted === true, member: v?.adopted === true && v?.member === true };
  } catch {
    return { adopted: false, member: false };
  }
}
