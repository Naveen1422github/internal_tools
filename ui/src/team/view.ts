import type { TeamMember, TeamProjectAccess, TeamRole, TeamRoster, TeamScope } from '../api/client';
import { activeKeys, labelOf } from './catalog';

/** What every Team tab (Members, Roles, Who can do what) is given by the Team page. */
export interface TeamTabProps {
  scope: TeamScope;
  /** The chosen team project; null in the office scope. */
  project: TeamProjectAccess | null;
  /** This device's id, to mark the viewer's own row. */
  me: string;
  /** The viewer's own active keys in this scope, read fresh from the office (S3-12). */
  viewerKeys: string[];
  /** Members and roles of this scope, as the office answered. */
  roster: TeamRoster;
  /**
   * Runs one change. On success the page reads everything again; on failure it
   * shows the office's refusal word for word. Resolves true on success.
   */
  act: (change: () => Promise<unknown>) => Promise<boolean>;
}

/** "SH" for a project, "this office" for the office: the end of the standard sentence. */
export const whereOf = (p: TeamTabProps) => (p.project ? p.project.code : 'this office');

/** The standard sentence for a missing key, as the office words it (S1). */
export function needSentence(key: string, where: string): string {
  return `You need "${labelOf(key)}" (${key}) in ${where} to do this`;
}

/** S3-13 (R7b): the note on keys checked on this laptop rather than by the office. */
export const LAPTOP_NOTE = 'Checked on this laptop. It limits your AI, but it is not a security boundary.';

/** Built-in roles in catalog order: project first, then office. */
const BUILT_IN_ORDER = ['Owner', 'Editor', 'Contributor', 'Reader', 'Office admin', 'Office member'];
const byName = (a: TeamRole, b: TeamRole) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * The order the Roles tab and the matrix share: built-in roles first, in catalog
 * order (a renamed built-in after the others, by name), then custom roles by name.
 */
export function orderRoles(roles: TeamRole[]): TeamRole[] {
  const rank = (r: TeamRole) => {
    const i = BUILT_IN_ORDER.indexOf(r.name);
    return i === -1 ? BUILT_IN_ORDER.length : i;
  };
  const builtIn = roles.filter((r) => r.is_starter).sort((a, b) => rank(a) - rank(b) || byName(a, b));
  const custom = roles.filter((r) => !r.is_starter).sort(byName);
  return [...builtIn, ...custom];
}

/** A member's display name. */
export const memberName = (m: TeamMember) => m.name ?? m.device_id;

/** How many hold a role: the office's count when it sends one (removed devices included), else the members listed. */
export function holderCount(role: TeamRole, members: TeamMember[]): number {
  return role.holders ?? holdersOf(role, members).length;
}

/** The members holding a role, by name. */
export function holdersOf(role: TeamRole, members: TeamMember[]): TeamMember[] {
  return members.filter((m) => m.role_ulid === role.ulid);
}

/**
 * The first active key of `keys` the viewer lacks, in catalog order, or null.
 * The office's rank and no-escalation rules (S3-1, S3-14) refuse naming this key;
 * the page uses it only to grey a control out with the same sentence.
 */
export function firstMissing(scope: TeamScope, keys: string[], viewerKeys: string[]): string | null {
  return activeKeys(scope).find((k) => keys.includes(k) && !viewerKeys.includes(k)) ?? null;
}
