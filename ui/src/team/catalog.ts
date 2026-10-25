/**
 * The UI's copy of core's permission catalog (core/src/access/catalog.ts): the
 * UI's TypeScript project can't import core. test/ui-catalog.test.mts checks it
 * equals core's CATALOG, so edit both together. No imports: the root test loads
 * this file directly.
 *
 * Rule 4: inactive keys (`active: false`) are never offered and grant nothing.
 * `checkedOn: 'laptop'` keys are checked on this laptop, not by the office (R7b).
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

// project.edit is checked at the office since UI parity D1 (a team rename goes there).
const LAPTOP = new Set(['note.copy.out', 'project.make_solo', 'project.delete']);

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
      // S2-2: neither op exists yet, so neither key is offered or grants anything.
      def('project.make_solo', 'Make project solo', 'Convert the team project back to a solo project', false),
      def('project.delete', 'Delete project', 'Delete the project', false),
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
      // office.module.share retired (local-first Task 5): modules follow their project; stored roles drop it via sanitizeKeys.
      def('office.member.add', 'Add office members', 'Add people to the office'),
      def('office.member.revoke', 'Revoke office members', 'Remove people from the office'),
      def('office.role.manage', 'Manage office roles', 'Create, edit and assign office roles'),
      def('module.create', 'Create modules', 'Create modules in the office'),
      def('module.edit', 'Edit modules', 'Edit modules in the office'),
    ],
  },
];

/** The active keys of a scope, in catalog order. Only these are offered or grant anything. */
export function activeKeys(scope: Scope): string[] {
  return CATALOG.filter((a) => a.scope === scope)
    .flatMap((a) => a.permissions)
    .filter((p) => p.active)
    .map((p) => p.key);
}

/** A key's label, or the key itself when the catalog doesn't know it. */
export function labelOf(key: string): string {
  for (const a of CATALOG) {
    const p = a.permissions.find((x) => x.key === key);
    if (p) return p.label;
  }
  return key;
}
