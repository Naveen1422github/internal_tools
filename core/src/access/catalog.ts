/**
 * RnR permission catalog (project + office scopes).
 *
 * Rule 4: "a key that guards nothing is not offered". Keys whose feature does
 * not exist yet (tasks do not sync) are kept in the catalog with
 * `active: false`: they are never offered and grant nothing until activated.
 * `checkedOn` records where enforcement happens: "office" keys are checked by
 * the office server, "laptop" keys by the local client (R7b).
 */
export type Scope = 'project' | 'office';

export interface PermissionDef {
  key: string;
  label: string;
  description: string;
  checkedOn: 'office' | 'laptop';
  active: boolean;
}

export interface PermissionArea {
  area: string;
  label: string;
  scope: Scope;
  permissions: PermissionDef[];
}

const LAPTOP = new Set(['note.copy.out', 'project.edit', 'project.make_solo', 'project.delete']);

function def(key: string, label: string, description: string, active = true): PermissionDef {
  return { key, label, description, checkedOn: LAPTOP.has(key) ? 'laptop' : 'office', active };
}

export const CATALOG: PermissionArea[] = [
  {
    area: 'notes', label: 'Notes', scope: 'project',
    permissions: [
      def('note.view', 'View notes', 'Read notes in the project'),
      def('note.create', 'Create notes', 'Add new notes to the project'),
      def('note.edit.own', 'Edit own notes', 'Edit notes the member created'),
      def('note.edit.any', 'Edit any note', 'Edit notes created by other members'),
      def('note.supersede', 'Supersede notes', 'Replace a note with a newer one'),
      def('note.archive', 'Archive notes', 'Archive notes in the project'),
      def('note.copy.out', 'Copy notes out', 'Copy notes into another project'),
    ],
  },
  {
    area: 'tasks', label: 'Tasks', scope: 'project',
    permissions: [
      def('task.create', 'Create tasks', 'Add new tasks to the project', false),
      def('task.assign', 'Assign tasks', 'Assign tasks to members', false),
      def('task.status.change', 'Change task status', 'Move tasks between statuses', false),
    ],
  },
  {
    area: 'conflicts', label: 'Conflicts', scope: 'project',
    permissions: [def('merge.resolve', 'Resolve conflicts', 'Resolve sync merge conflicts')],
  },
  {
    area: 'project', label: 'Project', scope: 'project',
    permissions: [
      def('project.edit', 'Edit project', 'Change project name and settings'),
      def('project.make_solo', 'Make project solo', 'Convert the team project back to a solo project'),
      def('project.delete', 'Delete project', 'Delete the project'),
    ],
  },
  {
    area: 'team', label: 'Team & access', scope: 'project',
    permissions: [
      def('member.invite', 'Invite members', 'Invite people to the project'),
      def('member.revoke', 'Revoke members', 'Remove members from the project'),
      def('role.manage', 'Manage roles', 'Create, edit and assign project roles'),
      def('ai_limits.manage', 'Manage AI limits', 'Set AI usage limits for the project'),
    ],
  },
  {
    area: 'office', label: 'Office', scope: 'office',
    permissions: [
      def('office.project.create', 'Create projects', 'Create team projects in the office'),
      def('office.module.share', 'Share modules', 'Share modules across the office'),
      def('office.member.add', 'Add office members', 'Add people to the office'),
      def('office.member.revoke', 'Revoke office members', 'Remove people from the office'),
      def('office.role.manage', 'Manage office roles', 'Create, edit and assign office roles'),
      def('module.create', 'Create modules', 'Create modules in the office'),
      def('module.edit', 'Edit modules', 'Edit modules in the office'),
    ],
  },
];

export function keysOf(scope: Scope, opts: { includeInactive?: boolean } = {}): string[] {
  return CATALOG.filter(a => a.scope === scope)
    .flatMap(a => a.permissions)
    .filter(p => opts.includeInactive || p.active)
    .map(p => p.key);
}

/** Drops unknown, wrong-scope and duplicate keys; keeps inactive ones (they grant nothing until active). */
export function sanitizeKeys(scope: Scope, keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const valid = new Set(keysOf(scope, { includeInactive: true }));
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === 'string' && valid.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export function labelOf(key: string): string {
  for (const a of CATALOG) {
    const p = a.permissions.find(x => x.key === key);
    if (p) return p.label;
  }
  return key;
}

const areaKeys = (...areas: string[]) =>
  CATALOG.filter(a => areas.includes(a.area)).flatMap(a => a.permissions.map(p => p.key));

export const STARTER_PROJECT_ROLES: Array<{ name: 'Owner' | 'Editor' | 'Contributor' | 'Reader'; keys: string[] }> = [
  { name: 'Owner', keys: keysOf('project', { includeInactive: true }) },
  { name: 'Editor', keys: areaKeys('notes', 'tasks', 'conflicts') },
  { name: 'Contributor', keys: ['note.view', 'note.create', 'note.edit.own', 'task.status.change'] },
  { name: 'Reader', keys: ['note.view'] },
];

export const STARTER_OFFICE_ROLES: Array<{ name: 'Office admin' | 'Office member'; keys: string[] }> = [
  { name: 'Office admin', keys: keysOf('office') },
  { name: 'Office member', keys: ['office.project.create'] },
];
