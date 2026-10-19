import type { TeamProjectAccess, TeamRoster, TeamScope } from '../api/client';
import { labelOf } from './catalog';

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
