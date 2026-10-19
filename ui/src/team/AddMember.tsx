import { useEffect, useState } from 'react';
import { teamOffice, teamSetMember, type TeamMember, type TeamProjectAccess, type TeamRoster } from '../api/client';
import Dialog, { primaryClass } from '../components/Dialog';
import { firstMissing, memberName, needSentence, orderRoles } from './view';

// UI parity D3: add an existing office member to a team project with a role —
// `collab team set <member> <CODE> <role>`, the same office PUT. The office
// checks member.invite and that the role holds no key the viewer lacks (S3-14);
// only roles the viewer could give are offered.

const DEFAULT_ROLE = 'Reader';

export default function AddMember({ project, viewerKeys, roster, act }: {
  project: TeamProjectAccess; viewerKeys: string[]; roster: TeamRoster;
  act: (change: () => Promise<unknown>) => Promise<boolean>;
}) {
  const why = viewerKeys.includes('member.invite') ? null : needSentence('member.invite', project.code);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <button type="button" disabled={!!why} title={why ?? undefined} onClick={() => setOpen(true)} className={primaryClass}>Add a member</button>
      {why && <p className="text-xs text-gray-500">{why}</p>}
      {open && <AddDialog project={project} viewerKeys={viewerKeys} roster={roster} act={act} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AddDialog({ project, viewerKeys, roster, act, onClose }: {
  project: TeamProjectAccess; viewerKeys: string[]; roster: TeamRoster;
  act: (change: () => Promise<unknown>) => Promise<boolean>; onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const grantable = orderRoles(roster.roles).filter((r) => firstMissing('project', r.keys, viewerKeys) === null);
  const [device, setDevice] = useState('');
  const [role, setRole] = useState(grantable.find((r) => r.name === DEFAULT_ROLE)?.name ?? grantable[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const inProject = new Set(roster.members.map((m) => m.device_id));
    teamOffice()
      .then((o) => { if (alive) setCandidates(o.members.filter((m) => !inProject.has(m.device_id))); })
      .catch((e) => { if (alive) setLoadError((e as Error).message); });
    return () => { alive = false; };
  }, [roster]);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      await teamSetMember({ scope: 'project', project: project.ulid, device, role });
    } catch (e) {
      // The office's refusal, word for word, in the dialog; the choices stay.
      setError((e as Error).message); setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
    await act(async () => {}); // read the members again
  };

  const select = 'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm';
  return (
    <Dialog title={`Add a member to ${project.code}`} confirmLabel="Add" confirmDisabled={!device || !role} busy={busy} error={loadError ?? error} onConfirm={add} onCancel={onClose}>
      {candidates === null && !loadError && <p className="text-sm text-gray-500">Loading the office's members…</p>}
      {candidates?.length === 0 && (
        <p className="text-sm">Everyone in the office is already in {project.code}. Invite a new person from Team → Office.</p>
      )}
      {candidates && candidates.length > 0 && (
        <>
          <label className="block space-y-1 text-sm">
            <span>Member</span>
            <select value={device} onChange={(e) => setDevice(e.target.value)} className={select}>
              <option value="">Choose a member…</option>
              {candidates.map((m) => <option key={m.device_id} value={m.device_id}>{memberName(m)}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} className={select}>
              {grantable.map((r) => <option key={r.ulid} value={r.name}>{r.name}</option>)}
            </select>
          </label>
          {grantable.length < roster.roles.length && (
            <p className="text-xs text-gray-500">Roles with permissions you don't hold aren't offered.</p>
          )}
          <p className="text-xs text-gray-500">They receive the project's notes, its history included, if the role can view notes.</p>
        </>
      )}
    </Dialog>
  );
}
