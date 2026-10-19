// file: post-office/src/access.ts
import { keysOf, labelOf, sanitizeKeys, newUlid, STARTER_OFFICE_ROLES, STARTER_PROJECT_ROLES, type Scope } from "@collab-mcp/core";
import { StoreError, getMeta, setMeta, type Store } from "./store.js";
import { OFFICE_ORIGIN, lastSeq, prep } from "./deliveries.js";

// RnR (R1, R13): the office owns who may do what. Tables live in PO_SCHEMA.
/** The one fixed project role (S3-2): the office finds Owners by this name. */
const OWNER = "Owner";
const OFFICE_ADMIN = "Office admin";
const OFFICE_MEMBER = "Office member";

/** Stored keys -> active catalog keys only: unknown keys and inactive ones grant nothing (rule 4). */
function grant(scope: Scope, stored: string | undefined): Set<string> {
  if (stored === undefined) return new Set();
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return new Set(); }
  const active = new Set(keysOf(scope));
  return new Set(sanitizeKeys(scope, parsed).filter((k) => active.has(k)));
}
export { grant as activeKeysOfRole };

const LIVE = `EXISTS (SELECT 1 FROM po_members m WHERE m.device_id = x.device_id AND m.revoked_at IS NULL)`;

function liveMember(db: Store, deviceId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM po_members WHERE device_id = ? AND revoked_at IS NULL`).get(deviceId);
}

// ---------------------------------------------------------------- reads
export function projectKeys(db: Store, deviceId: string, projectUlid: string): Set<string> {
  // R-29: prepared once per store (classify asks once per project per batch).
  const r = prep(db,
    `SELECT r.keys FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid
      WHERE x.project_ulid = ? AND x.device_id = ? AND ${LIVE}`,
  ).get(projectUlid, deviceId) as { keys: string } | undefined;
  return grant("project", r?.keys);
}

export function officeKeys(db: Store, deviceId: string): Set<string> {
  const r = prep(db, `SELECT r.keys FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ? AND ${LIVE}`)
    .get(deviceId) as { keys: string } | undefined;
  return grant("office", r?.keys);
}

/** Projects where the device holds `key` (R7a: the others are hidden from it). */
export function memberProjects(db: Store, deviceId: string, key = "note.view"): string[] {
  const rows = db
    .prepare(`SELECT x.project_ulid, r.keys FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ? AND ${LIVE}`)
    .all(deviceId) as Array<{ project_ulid: string; keys: string }>;
  return rows.filter((r) => grant("project", r.keys).has(key)).map((r) => r.project_ulid);
}

export function requireProjectKey(db: Store, deviceId: string, projectUlid: string, key: string): void {
  if (projectKeys(db, deviceId, projectUlid).has(key)) return;
  const p = db.prepare(`SELECT code FROM po_projects WHERE ulid = ?`).get(projectUlid) as { code: string } | undefined;
  throw new StoreError(`You need "${labelOf(key)}" (${key}) in ${p?.code ?? projectUlid} to do this`, 403);
}

export function requireOfficeKey(db: Store, deviceId: string, key: string): void {
  if (officeKeys(db, deviceId).has(key)) return;
  throw new StoreError(`You need "${labelOf(key)}" (${key}) in this office to do this`, 403);
}

/**
 * The rank rule (S3-1): you manage a member only if you hold every active key
 * of their current role. Throws on the first key you lack, in the usual wording.
 */
export function requireOutranks(db: Store, actor: string, scope: Scope, projectUlid: string | null, targetKeys: Set<string>): void {
  const mine = scope === "project" ? projectKeys(db, actor, projectUlid!) : officeKeys(db, actor);
  for (const k of targetKeys) {
    if (mine.has(k)) continue;
    if (scope === "project") requireProjectKey(db, actor, projectUlid!, k);
    else requireOfficeKey(db, actor, k);
  }
}

/** The stored keys of a device's office role (revoked devices included); undefined when it has none. */
function officeRoleKeys(db: Store, deviceId: string): string | undefined {
  return (db.prepare(`SELECT r.keys FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ?`)
    .get(deviceId) as { keys: string } | undefined)?.keys;
}

// ---------------------------------------------------------------- structural counts
function liveOwners(db: Store, projectUlid: string): string[] {
  return (db
    .prepare(
      `SELECT x.device_id FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid
        WHERE x.project_ulid = ? AND r.name = '${OWNER}' AND ${LIVE}`,
    )
    .all(projectUlid) as Array<{ device_id: string }>).map((r) => r.device_id);
}

function liveOfficeAdmins(db: Store): string[] {
  return (db
    .prepare(`SELECT x.device_id FROM po_office_members x JOIN po_office_roles r ON r.ulid = x.role_ulid WHERE r.name = '${OFFICE_ADMIN}' AND ${LIVE}`)
    .all() as Array<{ device_id: string }>).map((r) => r.device_id);
}

/** Projects where `deviceId` is the only live Owner (a project needs at least one). */
export function soleOwnerOf(db: Store, deviceId: string): string[] {
  const mine = db
    .prepare(`SELECT x.project_ulid FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.device_id = ? AND r.name = '${OWNER}'`)
    .all(deviceId) as Array<{ project_ulid: string }>;
  return mine.map((r) => r.project_ulid).filter((p) => { const o = liveOwners(db, p); return o.length === 1 && o[0] === deviceId; });
}

export function isSoleOfficeAdmin(db: Store, deviceId: string): boolean {
  const a = liveOfficeAdmins(db);
  return a.length === 1 && a[0] === deviceId;
}

function codeOf(db: Store, projectUlid: string): string {
  return (db.prepare(`SELECT code FROM po_projects WHERE ulid = ?`).get(projectUlid) as { code: string } | undefined)?.code ?? projectUlid;
}

// ---------------------------------------------------------------- seeding
/** Starter roles of one project (starter name -> role ulid). Idempotent. */
export function seedProjectRoles(db: Store, projectUlid: string): Map<string, string> {
  const ins = db.prepare(`INSERT OR IGNORE INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, ?, ?, 1)`);
  const get = db.prepare(`SELECT ulid FROM po_roles WHERE project_ulid = ? AND name = ?`);
  const out = new Map<string, string>();
  for (const r of STARTER_PROJECT_ROLES) {
    ins.run(newUlid(), projectUlid, r.name, JSON.stringify(r.keys));
    out.set(r.name, (get.get(projectUlid, r.name) as { ulid: string }).ulid);
  }
  return out;
}

function seedOfficeRoles(db: Store): Map<string, string> {
  const ins = db.prepare(`INSERT OR IGNORE INTO po_office_roles (ulid, name, keys, is_starter) VALUES (?, ?, ?, 1)`);
  const get = db.prepare(`SELECT ulid FROM po_office_roles WHERE name = ?`);
  const out = new Map<string, string>();
  for (const r of STARTER_OFFICE_ROLES) {
    ins.run(newUlid(), r.name, JSON.stringify(r.keys));
    out.set(r.name, (get.get(r.name) as { ulid: string }).ulid);
  }
  return out;
}

/**
 * The upgrade (R11, R13), once per store. Office admin = the earliest-joined
 * live member (the CLI can correct it); every live member becomes Owner of
 * every existing team project; notes get the device of their first delivery.
 */
export function seedAccess(db: Store): void {
  if (getMeta(db, "access_seeded")) return;
  db.transaction(() => {
    const office = seedOfficeRoles(db);
    const live = (db
      .prepare(`SELECT device_id FROM po_members WHERE revoked_at IS NULL ORDER BY joined_at IS NULL, joined_at, created_at, rowid`)
      .all() as Array<{ device_id: string }>).map((r) => r.device_id);
    const om = db.prepare(`INSERT OR IGNORE INTO po_office_members (device_id, role_ulid) VALUES (?, ?)`);
    live.forEach((d, i) => om.run(d, office.get(i === 0 ? OFFICE_ADMIN : OFFICE_MEMBER)!));
    const pm = db.prepare(`INSERT OR IGNORE INTO po_project_members (project_ulid, device_id, role_ulid) VALUES (?, ?, ?)`);
    for (const { ulid } of db.prepare(`SELECT ulid FROM po_projects`).all() as Array<{ ulid: string }>) {
      const owner = seedProjectRoles(db, ulid).get(OWNER)!;
      for (const d of live) pm.run(ulid, d, owner);
    }
    const firsts = db
      .prepare(
        `SELECT d.pk, d.origin FROM po_deliveries d
           JOIN (SELECT pk, MIN(seq) s FROM po_deliveries WHERE tbl = 'entries' AND origin <> ? GROUP BY pk) f ON f.s = d.seq`,
      )
      .all(OFFICE_ORIGIN) as Array<{ pk: Buffer; origin: string }>;
    const unpack = db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`);
    const no = db.prepare(`INSERT OR IGNORE INTO po_note_owners (ulid, device_id) VALUES (?, ?)`);
    for (const f of firsts) {
      const cell = (unpack.get(f.pk) as { cell: unknown } | undefined)?.cell;
      if (typeof cell === "string") no.run(cell, f.origin);
    }
    setMeta(db, "access_seeded", new Date().toISOString());
  }).immediate();
}

/** A device the office just added: Office admin when no live admin exists, else Office member (ledger ruling 1). */
export function assignNewMemberOfficeRole(db: Store, deviceId: string): void {
  const role = liveOfficeAdmins(db).length === 0 ? OFFICE_ADMIN : OFFICE_MEMBER;
  const r = db.prepare(`SELECT ulid FROM po_office_roles WHERE name = ?`).get(role) as { ulid: string };
  db.prepare(`INSERT OR REPLACE INTO po_office_members (device_id, role_ulid) VALUES (?, ?)`).run(deviceId, r.ulid);
}

/** registerProject's half (R7a): starter roles + the creator as the only member, Owner. */
export function seedNewProject(db: Store, projectUlid: string, creatorDevice: string): void {
  const owner = seedProjectRoles(db, projectUlid).get(OWNER)!;
  db.prepare(`INSERT OR REPLACE INTO po_project_members (project_ulid, device_id, role_ulid) VALUES (?, ?, ?)`).run(projectUlid, creatorDevice, owner);
}

// ---------------------------------------------------------------- changes
/**
 * Give `deviceId` a role in a project, change it, or (`roleName = null`)
 * remove it. Adding needs member.invite, changing needs role.manage, removing
 * needs member.revoke; the role given may not hold a key the actor lacks
 * (S3-14, yourself included), nor may the target's current role (S3-1).
 * Lowering your own role passes both. A project always keeps one Owner.
 * R14: gaining note.view queues a replay of the history so far; losing it drops it.
 * `actor = null` = the office machine's CLI: no keys checked, the Owner rule still holds.
 */
export function setProjectMember(db: Store, actor: string | null, projectUlid: string, deviceId: string, roleName: string | null): boolean {
  return db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM po_projects WHERE ulid = ?`).get(projectUlid)) throw new StoreError(`no team project ${projectUlid} on this post office`, 404);
    const cur = db
      .prepare(`SELECT r.name, r.keys FROM po_project_members x JOIN po_roles r ON r.ulid = x.role_ulid WHERE x.project_ulid = ? AND x.device_id = ?`)
      .get(projectUlid, deviceId) as { name: string; keys: string } | undefined;
    if (actor !== null) requireProjectKey(db, actor, projectUlid, roleName === null ? "member.revoke" : cur ? "role.manage" : "member.invite");
    // S3-1: nobody changes or removes a member ranked above them (checked before the no-op answer).
    if (actor !== null && cur) requireOutranks(db, actor, "project", projectUlid, grant("project", cur.keys));
    if (roleName === null) {
      if (!cur) return false;
    } else {
      if (cur?.name === roleName) return false;
      if (!liveMember(db, deviceId)) throw new StoreError(`${deviceId} is not a member of this office`, 404);
    }
    const role = roleName === null ? undefined : db.prepare(`SELECT ulid, keys FROM po_roles WHERE project_ulid = ? AND name = ?`).get(projectUlid, roleName) as { ulid: string; keys: string } | undefined;
    if (roleName !== null && !role) throw new StoreError(`${codeOf(db, projectUlid)} has no role called "${roleName}"`, 404);
    // No one hands out a role above their own keys (ruling 4); the office CLI is exempt.
    if (role && actor !== null) for (const k of grant("project", role.keys)) requireProjectKey(db, actor, projectUlid, k);
    if (cur?.name === OWNER && soleOwnerOf(db, deviceId).includes(projectUlid)) {
      throw new StoreError(`${codeOf(db, projectUlid)} needs at least one Owner; make someone else Owner first`, 409);
    }
    const before = projectKeys(db, deviceId, projectUlid).has("note.view");
    if (role) db.prepare(`INSERT OR REPLACE INTO po_project_members (project_ulid, device_id, role_ulid) VALUES (?, ?, ?)`).run(projectUlid, deviceId, role.ulid);
    else db.prepare(`DELETE FROM po_project_members WHERE project_ulid = ? AND device_id = ?`).run(projectUlid, deviceId);
    syncReplays(db, deviceId, projectUlid, before);
    return true;
  }).immediate();
}

/**
 * R14/R15, after a change to what `deviceId` holds in a project (`before` =
 * whether it held note.view before): gaining note.view queues a replay of the
 * history so far, losing it drops a pending one. Runs inside the caller's transaction.
 */
export function syncReplays(db: Store, deviceId: string, projectUlid: string, before: boolean): void {
  const after = projectKeys(db, deviceId, projectUlid).has("note.view");
  if (!before && after) {
    db.prepare(`INSERT OR REPLACE INTO po_replays (device_id, project_ulid, upto_seq) VALUES (?, ?, ?)`).run(deviceId, projectUlid, lastSeq(db));
  } else if (before && !after) {
    db.prepare(`DELETE FROM po_replays WHERE device_id = ? AND project_ulid = ?`).run(deviceId, projectUlid);
  }
}

// ---------------------------------------------------------------- project roles (S3)
// Who may change a role, and how (all checked here, never only in the UI):
// - role.manage, and the rank rule (S3-1): you edit or delete a role only when
//   you hold every active key it holds now;
// - no escalation (S3-14): every active key a role is created with, or ends up
//   with after an edit, must be one you hold (your own role included);
// - built-ins (S3-2): Owner is fixed, because the office finds Owners by name
//   (liveOwners, soleOwnerOf) and "one Owner always" means nothing if its keys
//   could shrink. Editor, Contributor and Reader can be renamed and re-keyed,
//   but no starter role is ever deleted (S3-3); a custom one only when nobody,
//   revoked devices included, points at it (a dangling role_ulid drops out of every JOIN).
// - S3-4: a request names active keys only; the stored inactive ones (task.*) are kept.
// - S3-6: names are trimmed, 1-40 characters, unique case-insensitively in the
//   project, and never a starter name (a starter role may keep or take back one).
// `actor = null` = the office machine's CLI: no keys checked, the structural rules still hold.
const ROLE_NAME_MAX = 40;
/** One fold for every name comparison (S3-6): NFC first, so "É" and "E\u0301" meet; full Unicode case, not SQLite's ASCII-only lower(). */
const foldName = (s: string) => s.normalize("NFC").toLowerCase();
const STARTER_NAMES: Record<Scope, string[]> = {
  project: STARTER_PROJECT_ROLES.map((r) => foldName(r.name)),
  office: STARTER_OFFICE_ROLES.map((r) => foldName(r.name)),
};
const CONTROL = /[\u0000-\u001f\u007f]/;

interface RoleRow { ulid: string; name: string; keys: string; is_starter: number }

function projectRoleRow(db: Store, projectUlid: string, roleUlid: string): RoleRow {
  const r = db.prepare(`SELECT ulid, name, keys, is_starter FROM po_roles WHERE ulid = ? AND project_ulid = ?`).get(roleUlid, projectUlid) as RoleRow | undefined;
  if (!r) throw new StoreError("no such role", 404); // a role of another project is just as missing
  return r;
}

/** S3-2: the starter Owner role (a custom role can never be named "Owner", S3-6). */
export function isOwnerRole(r: { name: string; is_starter: number | boolean }): boolean {
  return (r.is_starter === 1 || r.is_starter === true) && r.name === OWNER;
}

/**
 * S3-6. `self` = the role being renamed: it may keep its own name in any case,
 * and that is the only way to hold a built-in name (a renamed Editor can't take
 * "Editor" back, and Contributor can't take it either). `projectUlid = null` = office roles.
 */
function checkRoleName(db: Store, scope: Scope, projectUlid: string | null, raw: unknown, self: RoleRow | null): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new StoreError("a role needs a name");
  if (CONTROL.test(name)) throw new StoreError("a role name can't contain control characters");
  if (name.length > ROLE_NAME_MAX) throw new StoreError(`a role name can be at most ${ROLE_NAME_MAX} characters`);
  const folded = foldName(name);
  if (STARTER_NAMES[scope].includes(folded) && !(self && foldName(self.name) === folded)) throw new StoreError(`"${name}" is the name of a built-in role`, 409);
  const others = (scope === "project"
    ? db.prepare(`SELECT ulid, name FROM po_roles WHERE project_ulid = ? AND ulid <> ?`).all(projectUlid, self?.ulid ?? "")
    : db.prepare(`SELECT ulid, name FROM po_office_roles WHERE ulid <> ?`).all(self?.ulid ?? "")) as Array<{ name: string }>;
  const clash = others.find((r) => foldName(r.name) === folded);
  if (clash) throw new StoreError(`${scope === "project" ? codeOf(db, projectUlid!) : "this office"} already has a role called "${clash.name}"`, 409);
  return name;
}

/** S3-4: the keys of a request, all active keys of the scope, in catalog order. */
function checkGivenKeys(scope: Scope, raw: unknown): Set<string> {
  if (!Array.isArray(raw)) throw new StoreError("keys must be a list of permissions");
  const active = new Set(keysOf(scope));
  const out = new Set<string>();
  for (const k of raw) {
    if (typeof k !== "string" || !active.has(k)) throw new StoreError(`"${String(k)}" is not a permission that can be given`);
    out.add(k);
  }
  return out;
}

/** A role's stored keys, sanitized (unknown ones dropped, inactive ones kept). */
function storedKeysOf(scope: Scope, stored: string): Set<string> {
  let parsed: unknown = [];
  try { parsed = JSON.parse(stored); } catch { /* grants nothing */ }
  return new Set(sanitizeKeys(scope, parsed));
}

/** Stored form: catalog order, inactive keys included. */
function storedForm(scope: Scope, keys: Set<string>): string {
  return JSON.stringify(keysOf(scope, { includeInactive: true }).filter((k) => keys.has(k)));
}

/** S3-14: the actor holds every key, checked in catalog order so the refusal names the first one. */
function requireHoldsAll(db: Store, actor: string, scope: Scope, projectUlid: string | null, keys: Set<string>): void {
  for (const k of keysOf(scope)) {
    if (!keys.has(k)) continue;
    if (scope === "project") requireProjectKey(db, actor, projectUlid!, k);
    else requireOfficeKey(db, actor, k);
  }
}

/** S3-4: the request's active keys plus the role's stored inactive ones; the stored string itself when nothing moved. */
function rekeyed(scope: Scope, storedNow: string, given: Set<string>): string {
  const active = new Set(keysOf(scope));
  const now = storedKeysOf(scope, storedNow);
  const next = new Set([...given, ...[...now].filter((k) => !active.has(k))]);
  return next.size !== now.size || [...next].some((k) => !now.has(k)) ? storedForm(scope, next) : storedNow;
}

export function createProjectRole(db: Store, actor: string | null, projectUlid: string, input: { name: unknown; keys: unknown }): { ulid: string; name: string; keys: string[] } {
  return db.transaction(() => {
    if (actor !== null) requireProjectKey(db, actor, projectUlid, "role.manage");
    const name = checkRoleName(db, "project", projectUlid, input.name, null);
    const keys = checkGivenKeys("project", input.keys);
    if (actor !== null) requireHoldsAll(db, actor, "project", projectUlid, keys);
    const ulid = newUlid();
    const stored = storedForm("project", keys);
    db.prepare(`INSERT INTO po_roles (ulid, project_ulid, name, keys, is_starter) VALUES (?, ?, ?, ?, 0)`).run(ulid, projectUlid, name, stored);
    return { ulid, name, keys: JSON.parse(stored) as string[] };
  }).immediate();
}

/** Rename and/or re-key a role; holders gain or lose replays with it (S3-5). True when something changed. */
export function updateProjectRole(db: Store, actor: string | null, projectUlid: string, roleUlid: string, input: { name?: unknown; keys?: unknown }): boolean {
  return db.transaction(() => {
    if (actor !== null) requireProjectKey(db, actor, projectUlid, "role.manage");
    const role = projectRoleRow(db, projectUlid, roleUlid);
    if (isOwnerRole(role)) throw new StoreError("The Owner role can't be renamed or changed", 409);
    if (actor !== null) requireOutranks(db, actor, "project", projectUlid, grant("project", role.keys));
    const name = input.name === undefined ? role.name : checkRoleName(db, "project", projectUlid, input.name, role);
    let stored = role.keys;
    if (input.keys !== undefined) {
      const given = checkGivenKeys("project", input.keys);
      if (actor !== null) requireHoldsAll(db, actor, "project", projectUlid, given);
      stored = rekeyed("project", role.keys, given);
    }
    if (name === role.name && stored === role.keys) return false;
    const holders = (db.prepare(`SELECT device_id FROM po_project_members WHERE project_ulid = ? AND role_ulid = ?`).all(projectUlid, roleUlid) as Array<{ device_id: string }>)
      .map((h) => ({ device: h.device_id, before: projectKeys(db, h.device_id, projectUlid).has("note.view") }));
    db.prepare(`UPDATE po_roles SET name = ?, keys = ? WHERE ulid = ?`).run(name, stored, roleUlid);
    for (const h of holders) syncReplays(db, h.device, projectUlid, h.before);
    return true;
  }).immediate();
}

export function deleteProjectRole(db: Store, actor: string | null, projectUlid: string, roleUlid: string): void {
  db.transaction(() => {
    if (actor !== null) requireProjectKey(db, actor, projectUlid, "role.manage");
    const role = projectRoleRow(db, projectUlid, roleUlid);
    if (role.is_starter) throw new StoreError(`${role.name} is a built-in role and can't be deleted`, 409);
    if (actor !== null) requireOutranks(db, actor, "project", projectUlid, grant("project", role.keys));
    const n = (db.prepare(`SELECT COUNT(*) n FROM po_project_members WHERE project_ulid = ? AND role_ulid = ?`).get(projectUlid, roleUlid) as { n: number }).n;
    if (n > 0) throw new StoreError(`${n} ${n === 1 ? "member holds" : "members hold"} ${role.name}. Give them another role first`, 409);
    db.prepare(`DELETE FROM po_roles WHERE ulid = ?`).run(roleUlid);
  }).immediate();
}

// ---------------------------------------------------------------- office roles (S3)
// The project rules above, in office scope, with office.role.manage and the office keys:
// - the rank rule (S3-1) and no escalation (S3-14), exactly as for project roles;
// - built-ins (S3-2): Office admin is fixed (name, keys, existence), because the
//   office counts admins by name (liveOfficeAdmins, isSoleOfficeAdmin) and "one
//   Office admin always" means nothing if its keys could shrink. Office member's
//   name and existence are fixed, because a new device is given the role found by
//   that exact name (assignNewMemberOfficeRole, a case-sensitive match: a rename,
//   even of case, would break every join); its keys can change.
// - S3-3/S3-4/S3-6 as for project roles; names are unique within the office.
// No replays move: no office key is note.view (replays follow project keys only).
function officeRoleRow(db: Store, roleUlid: string): RoleRow {
  const r = db.prepare(`SELECT ulid, name, keys, is_starter FROM po_office_roles WHERE ulid = ?`).get(roleUlid) as RoleRow | undefined;
  if (!r) throw new StoreError("no such role", 404);
  return r;
}

/** S3-2: "all" for Office admin (fixed), "name" for Office member (keys editable), null otherwise. */
export function officeRoleLock(r: { name: string; is_starter: number | boolean }): "all" | "name" | null {
  if (!(r.is_starter === 1 || r.is_starter === true)) return null;
  return r.name === OFFICE_ADMIN ? "all" : r.name === OFFICE_MEMBER ? "name" : null;
}

export function createOfficeRole(db: Store, actor: string | null, input: { name: unknown; keys: unknown }): { ulid: string; name: string; keys: string[] } {
  return db.transaction(() => {
    if (actor !== null) requireOfficeKey(db, actor, "office.role.manage");
    const name = checkRoleName(db, "office", null, input.name, null);
    const keys = checkGivenKeys("office", input.keys);
    if (actor !== null) requireHoldsAll(db, actor, "office", null, keys);
    const ulid = newUlid();
    const stored = storedForm("office", keys);
    db.prepare(`INSERT INTO po_office_roles (ulid, name, keys, is_starter) VALUES (?, ?, ?, 0)`).run(ulid, name, stored);
    return { ulid, name, keys: JSON.parse(stored) as string[] };
  }).immediate();
}

/** Rename and/or re-key an office role. True when something changed. */
export function updateOfficeRole(db: Store, actor: string | null, roleUlid: string, input: { name?: unknown; keys?: unknown }): boolean {
  return db.transaction(() => {
    if (actor !== null) requireOfficeKey(db, actor, "office.role.manage");
    const role = officeRoleRow(db, roleUlid);
    const lock = officeRoleLock(role);
    if (lock === "all") throw new StoreError(`The ${OFFICE_ADMIN} role can't be renamed or changed`, 409);
    if (lock === "name" && input.name !== undefined && (typeof input.name !== "string" || input.name.trim() !== role.name)) {
      throw new StoreError(`The ${OFFICE_MEMBER} role can't be renamed`, 409);
    }
    if (actor !== null) requireOutranks(db, actor, "office", null, grant("office", role.keys));
    const name = input.name === undefined || lock === "name" ? role.name : checkRoleName(db, "office", null, input.name, role);
    let stored = role.keys;
    if (input.keys !== undefined) {
      const given = checkGivenKeys("office", input.keys);
      if (actor !== null) requireHoldsAll(db, actor, "office", null, given);
      stored = rekeyed("office", role.keys, given);
    }
    if (name === role.name && stored === role.keys) return false;
    db.prepare(`UPDATE po_office_roles SET name = ?, keys = ? WHERE ulid = ?`).run(name, stored, roleUlid);
    return true;
  }).immediate();
}

export function deleteOfficeRole(db: Store, actor: string | null, roleUlid: string): void {
  db.transaction(() => {
    if (actor !== null) requireOfficeKey(db, actor, "office.role.manage");
    const role = officeRoleRow(db, roleUlid);
    if (role.is_starter) throw new StoreError(`${role.name} is a built-in role and can't be deleted`, 409);
    if (actor !== null) requireOutranks(db, actor, "office", null, grant("office", role.keys));
    const n = (db.prepare(`SELECT COUNT(*) n FROM po_office_members WHERE role_ulid = ?`).get(roleUlid) as { n: number }).n;
    if (n > 0) throw new StoreError(`${n} ${n === 1 ? "member holds" : "members hold"} ${role.name}. Give them another role first`, 409);
    db.prepare(`DELETE FROM po_office_roles WHERE ulid = ?`).run(roleUlid);
  }).immediate();
}

/** GET /v1/office/members (S3-7): live, joined devices with their office role, and every office role. */
export function listOfficeMembers(db: Store) {
  const members = db
    .prepare(
      `SELECT m.device_id, m.name, r.name AS role, x.role_ulid, m.last_seen_at FROM po_office_members x
         JOIN po_members m ON m.device_id = x.device_id AND m.revoked_at IS NULL AND m.joined_at IS NOT NULL
         JOIN po_office_roles r ON r.ulid = x.role_ulid ORDER BY m.name, m.device_id`,
    )
    .all();
  const roles = (db.prepare(`SELECT ulid, name, keys, is_starter FROM po_office_roles ORDER BY name`).all() as RoleRow[]).map((r) => ({
    ulid: r.ulid, name: r.name, keys: [...storedKeysOf("office", r.keys)], is_starter: r.is_starter === 1, locked: officeRoleLock(r),
  }));
  return { members, roles };
}

/**
 * Each device holds one office role (R13). Like a project role: the actor must
 * outrank the target's current office role (S3-1) and hold every key of the new
 * one (S3-14). `actor = null` = the office machine's CLI (unguarded).
 */
export function setOfficeRole(db: Store, actor: string | null, deviceId: string, roleName: string): void {
  db.transaction(() => {
    if (actor !== null) requireOfficeKey(db, actor, "office.role.manage");
    if (actor !== null) requireOutranks(db, actor, "office", null, grant("office", officeRoleKeys(db, deviceId)));
    if (!liveMember(db, deviceId)) throw new StoreError(`${deviceId} is not a member of this office`, 404);
    const role = db.prepare(`SELECT ulid, keys FROM po_office_roles WHERE name = ?`).get(roleName) as { ulid: string; keys: string } | undefined;
    if (!role) throw new StoreError(`this office has no role called "${roleName}"`, 404);
    // No one hands out a role above their own keys (ruling 4); the office CLI is exempt.
    if (actor !== null) for (const k of grant("office", role.keys)) requireOfficeKey(db, actor, k);
    if (roleName !== OFFICE_ADMIN && isSoleOfficeAdmin(db, deviceId)) {
      throw new StoreError("this office needs at least one Office admin; make someone else Office admin first", 409);
    }
    db.prepare(`INSERT OR REPLACE INTO po_office_members (device_id, role_ulid) VALUES (?, ?)`).run(deviceId, role.ulid);
  }).immediate();
}

/**
 * revokeMember's guard: never leave the office without an admin or a project
 * without an Owner. With an `actor` (an office member, not the office CLI), the
 * actor must also outrank the device's office role (S3-1).
 */
export function assertRevocable(db: Store, deviceId: string, actor: string | null = null): void {
  if (actor !== null) requireOutranks(db, actor, "office", null, grant("office", officeRoleKeys(db, deviceId)));
  if (isSoleOfficeAdmin(db, deviceId)) {
    throw new StoreError("this is the only Office admin; make someone else Office admin first", 409);
  }
  const sole = soleOwnerOf(db, deviceId);
  if (sole.length) {
    const codes = sole.map((p) => codeOf(db, p));
    throw new StoreError(
      `this is the only Owner of ${codes.join(", ")}; make someone else Owner first. On the office machine: ` +
        codes.map((c) => `collab office set-project-role <new owner> ${c} Owner`).join("; "),
      409,
    );
  }
}
