import { useEffect, useRef, useState } from 'react';
import { teamCreateRole, teamDeleteRole, teamUpdateRole, type TeamRole } from '../api/client';
import { activeKeys, labelOf } from './catalog';
import RoleEditor from './RoleEditor';
import { holdersOf, needSentence, orderRoles, whereOf, type TeamTabProps } from './view';

/** What the editor panel is showing: a new role (blank or duplicated), or an existing one. */
type Editing =
  | { kind: 'new'; name: string; keys: string[] }
  | { kind: 'existing'; role: TeamRole };

const countOf = (n: number) => (n === 0 ? 'No members' : n === 1 ? '1 member' : `${n} members`);
const button =
  'rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The Roles tab: one card per role, built-ins first (S3-2), and an editor panel.
 * Inactive keys are never shown or sent (rule 4); the office keeps a role's stored
 * inactive keys (S3-4). Controls the viewer's keys rule out are disabled, not hidden.
 */
export default function Roles(props: TeamTabProps) {
  const { scope, project, viewerKeys, roster, act } = props;
  const manageKey = scope === 'office' ? 'office.role.manage' : 'role.manage';
  const canManage = viewerKeys.includes(manageKey);
  const why = canManage ? undefined : needSentence(manageKey, whereOf(props));
  const active = activeKeys(scope);
  const inScope = project ? { scope, project: project.ulid } : { scope };
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<TeamRole | null>(null);
  const roles = orderRoles(roster.roles);

  const open = (next: Editing) => { setDeleting(null); setEditing(next); };

  const save = (name: string, keys: string[]) => {
    if (!editing) return Promise.resolve(false);
    if (editing.kind === 'new') return act(() => teamCreateRole({ ...inScope, name, keys }));
    const { role } = editing;
    return act(() => teamUpdateRole(role.locked === 'name' ? { ...inScope, role: role.ulid, keys } : { ...inScope, role: role.ulid, name, keys }));
  };

  const remove = async (role: TeamRole) => {
    setDeleting(null);
    await act(() => teamDeleteRole({ ...inScope, role: role.ulid }));
  };

  return (
    <div className="space-y-4">
      <div>
        <button type="button" disabled={!canManage} title={why} onClick={() => open({ kind: 'new', name: '', keys: [] })} className={button}>
          New role
        </button>
      </div>

      {editing && (
        <RoleEditor
          key={editing.kind === 'existing' ? editing.role.ulid : `new:${editing.name}`}
          scope={scope}
          title={editing.kind === 'new' ? 'New role' : editing.role.locked === 'all' ? `Role ${editing.role.name}` : `Edit role ${editing.role.name}`}
          initialName={editing.kind === 'new' ? editing.name : editing.role.name}
          initialKeys={editing.kind === 'new' ? editing.keys : editing.role.keys}
          locked={editing.kind === 'new' ? null : editing.role.locked}
          viewerKeys={viewerKeys}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && <ConfirmDelete name={deleting.name} onDelete={() => remove(deleting)} onCancel={() => setDeleting(null)} />}

      <div className="grid gap-3 md:grid-cols-2">
        {roles.map((r) => {
          const keys = r.keys.filter((k) => active.includes(k));
          return (
            <article key={r.ulid} aria-label={r.name} className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{r.name}</h2>
                {r.is_starter && (
                  <span className="rounded-full bg-gray-200 dark:bg-gray-800 px-2 text-xs text-gray-700 dark:text-gray-300">Built-in</span>
                )}
                <span className="text-sm text-gray-500">{countOf(holdersOf(r, roster.members).length)}</span>
              </div>
              {keys.length > 0 ? (
                <ul className="flex flex-wrap gap-1">
                  {keys.map((k) => (
                    <li key={k} className="rounded bg-gray-100 dark:bg-gray-900 px-2 py-0.5 text-xs">{labelOf(k)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No permissions</p>
              )}
              <div className="flex flex-wrap gap-2">
                {r.locked === 'all' ? (
                  <button type="button" onClick={() => open({ kind: 'existing', role: r })} className={button}>View</button>
                ) : (
                  <button type="button" disabled={!canManage} title={why} onClick={() => open({ kind: 'existing', role: r })} className={button}>
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canManage}
                  title={why}
                  onClick={() => open({ kind: 'new', name: `${r.name} (copy)`, keys: r.keys })}
                  className={button}
                >
                  Duplicate
                </button>
                {!r.is_starter && (
                  <button type="button" disabled={!canManage} title={why} onClick={() => { setEditing(null); setDeleting(r); }} className={button}>
                    Delete
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmDelete({ name, onDelete, onCancel }: { name: string; onDelete: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="confirm-delete-role-text"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      className="border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 space-y-3"
    >
      <p id="confirm-delete-role-text" className="text-sm">Delete the role {name}? This can't be undone.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onDelete} className="px-3 py-1 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700">
          Delete
        </button>
        <button type="button" ref={cancel} onClick={onCancel} className="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-900">
          Cancel
        </button>
      </div>
    </div>
  );
}
