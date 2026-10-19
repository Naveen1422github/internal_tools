import { useState } from 'react';
import { teamInvite, type TeamInvite, type TeamRoster } from '../api/client';
import Dialog, { buttonClass, primaryClass } from '../components/Dialog';
import { firstMissing, needSentence } from './view';

// UI parity D2: `collab team invite` on the web. The office checks
// office.member.add and that the new member's role (Office member) holds no key
// the inviter lacks (S3-14). The join code is a one-time password: it lives in
// this component's state only and is gone when the dialog closes.

const OFFICE_MEMBER = 'Office member';

/** Why this laptop can't invite, or null. */
export function inviteReason(viewerKeys: string[], roster: TeamRoster): string | null {
  if (!viewerKeys.includes('office.member.add')) return needSentence('office.member.add', 'this office');
  const member = roster.roles.find((r) => r.name === OFFICE_MEMBER);
  const missing = member ? firstMissing('office', member.keys, viewerKeys) : null;
  return missing ? needSentence(missing, 'this office') : null;
}

/** "Monday 26 October 2026, 10:00", in this browser's time zone. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

export default function Invite({ viewerKeys, roster }: { viewerKeys: string[]; roster: TeamRoster }) {
  const why = inviteReason(viewerKeys, roster);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <button type="button" disabled={!!why} title={why ?? undefined} onClick={() => setOpen(true)} className={primaryClass}>Invite a person</button>
      {why && <p className="text-xs text-gray-500">{why}</p>}
      {open && <InviteDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<TeamInvite | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    try { setInvite(await teamInvite(name.trim())); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite!.join_code);
      setCopied('Copied.');
    } catch {
      setCopied('Copying was blocked by the browser: select the code and copy it by hand.');
    }
  };

  if (!invite) {
    return (
      <Dialog title="Invite a person" confirmLabel="Create join code" confirmDisabled={!name.trim()} busy={busy} error={error} onConfirm={send} onCancel={onClose}>
        <label className="block space-y-1 text-sm">
          <span>Their name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm" />
        </label>
        <p className="text-xs text-gray-500">They join the office as an Office member. Add them to team projects once they have joined.</p>
      </Dialog>
    );
  }
  return (
    <Dialog title={`Join code for ${invite.name}`} onCancel={onClose} cancelLabel="Done">
      <p className="text-sm">
        Give this code to {invite.name}. On their laptop they run <code>{'collab sync setup <code>'}</code> with it.
        {' '}It works once{invite.expires_at ? ` and expires on ${when(invite.expires_at)}` : ''}.
      </p>
      <p className="text-sm font-medium">Treat it like a password: it is shown only once.</p>
      <textarea readOnly aria-label="Join code" value={invite.join_code} rows={3} onFocus={(e) => e.currentTarget.select()}
        className="w-full break-all rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-2 font-mono text-xs" />
      <div className="flex items-center gap-3">
        <button type="button" onClick={copy} className={buttonClass}>Copy code</button>
        {copied && <span role="status" className="text-xs text-gray-600 dark:text-gray-400">{copied}</span>}
      </div>
      <p className="text-xs text-gray-500">{invite.name} appears in the members list once they have joined.</p>
    </Dialog>
  );
}
