import { useEffect, useId, useRef, useState } from 'react';
import { teamRemoveMember, teamSetMember, type TeamMember } from '../api/client';
import { needSentence, orderRoles, whereOf, type TeamTabProps } from './view';
import { localTimeOfUtc } from '../format';

const nameOf = (m: TeamMember) => m.name ?? m.device_id;
/** The office stores SQLite's datetime('now'), in UTC. */
const lastSeen = (at: string | null) => (at ? localTimeOfUtc(at) : 'Never');

/**
 * Members of a team project, or of the office. The role select applies at once;
 * the office decides. Controls the viewer's keys rule out are shown disabled with
 * the reason, never hidden. Removing a device from the office stays on the CLI (S3-7).
 */
export default function Members(props: TeamTabProps) {
  const { scope, project, me, viewerKeys, roster, act } = props;
  const where = whereOf(props);
  const manageKey = scope === 'office' ? 'office.role.manage' : 'role.manage';
  const canManage = viewerKeys.includes(manageKey);
  const canRemove = viewerKeys.includes('member.revoke');
  const [confirming, setConfirming] = useState<TeamMember | null>(null);
  const others = roster.members.filter((m) => m.device_id !== me);
  // Each reason is said once, visibly, above the table; the controls point at it (and keep the title).
  const manageWhy = canManage ? undefined : needSentence(manageKey, where);
  const removeWhy = canRemove || !project ? undefined : needSentence('member.revoke', where);
  const manageId = useId();
  const removeId = useId();
  // The Remove button that opened the panel gets focus back when it closes.
  const opener = useRef<HTMLButtonElement | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const refocus = () => { if (opener.current?.isConnected) opener.current.focus(); };

  const setRole = (m: TeamMember, role: string) =>
    act(() => teamSetMember(project ? { scope, project: project.ulid, device: m.device_id, role } : { scope, device: m.device_id, role }));

  const remove = async (m: TeamMember) => {
    if (!project) return;
    setConfirming(null);
    const ok = await act(() => teamRemoveMember({ project: project.ulid, device: m.device_id }));
    // After a removal the row is about to go: land on the table instead of a button that vanishes.
    if (ok) table.current?.focus(); else refocus();
  };

  return (
    <div className="space-y-4">
      {(manageWhy || removeWhy) && (
        <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
          {manageWhy && <p id={manageId}>{manageWhy}</p>}
          {removeWhy && <p id={removeId}>{removeWhy}</p>}
        </div>
      )}
      {project && others.length === 0 && (
        <p className="text-sm text-gray-500">
          This project has no other members yet. Add one with <code>{`collab team set <member> ${project.code} <role>`}</code>.
        </p>
      )}
      {confirming && project && (
        <ConfirmRemove
          name={nameOf(confirming)}
          code={project.code}
          onRemove={() => remove(confirming)}
          onCancel={() => { setConfirming(null); refocus(); }}
        />
      )}
      <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table ref={table} tabIndex={-1} className="w-full text-sm focus:outline-none">
          <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Last seen</th>
              <th className="px-3 py-2 font-semibold">{project ? 'Role' : 'Office role'}</th>
              {project && <th className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {roster.members.map((m) => (
              <tr key={m.device_id}>
                <td className="px-3 py-2">
                  {nameOf(m)}
                  {m.device_id === me && (
                    <span className="ml-2 rounded-full bg-gray-200 dark:bg-gray-800 px-2 text-xs text-gray-700 dark:text-gray-300">You</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500">{lastSeen(m.last_seen_at)}</td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`${project ? 'Role' : 'Office role'} for ${nameOf(m)}`}
                    value={m.role}
                    disabled={!canManage}
                    title={manageWhy}
                    aria-describedby={manageWhy ? manageId : undefined}
                    onChange={(e) => setRole(m, e.target.value)}
                    className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm disabled:opacity-50"
                  >
                    {orderRoles(roster.roles).map((r) => <option key={r.ulid} value={r.name}>{r.name}</option>)}
                  </select>
                </td>
                {project && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={!canRemove}
                      title={removeWhy}
                      aria-describedby={removeWhy ? removeId : undefined}
                      onClick={(e) => { opener.current = e.currentTarget; setConfirming(m); }}
                      className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Remove from {project.code}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!project && (
        <p className="text-sm text-gray-500">
          To remove a device from the office, use <code>collab team revoke</code> on any laptop with that permission.
        </p>
      )}
    </div>
  );
}

function ConfirmRemove({ name, code, onRemove, onCancel }: { name: string; code: string; onRemove: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="confirm-remove-text"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      className="border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 space-y-3"
    >
      <p id="confirm-remove-text" className="text-sm">
        Remove {name} from {code}? They keep a read-only copy of the project's notes and receive nothing new.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onRemove} className="px-3 py-1 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700">
          Remove
        </button>
        <button type="button" ref={cancel} onClick={onCancel} className="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-900">
          Cancel
        </button>
      </div>
    </div>
  );
}
