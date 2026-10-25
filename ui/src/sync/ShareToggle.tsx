import { useEffect, useState } from 'react';
import { moduleShare, teamOverview } from '../api/client';
import { buttonClass } from '../components/Dialog';
import { toast } from '../components/Toast';

// UI parity Task 7c: `collab sync share|unshare <module>` on the web. These are
// the office-wide (legacy E) modules. The office checks office.module.share;
// without it the button is greyed with the office's sentence.

const NOT_CONNECTED = "This notebook isn't connected to a post office.";
// office.module.share left the catalog (local-first Task 5), so labelOf no longer knows it: today's sentence, verbatim.
const SHARE_NEEDED = 'You need "Share modules" (office.module.share) in this office to do this';

export default function ShareToggle({ slug, shared, boundProject, onChange }: {
  slug: string; shared: boolean; boundProject?: string; onChange: (shared: string[]) => void;
}) {
  const [why, setWhy] = useState<string | null>('Checking the post office…');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    teamOverview()
      .then((o) => {
        if (!alive) return;
        if (!o.connected) setWhy(NOT_CONNECTED);
        // The office's pre-adoption rule (requireLegacyModuleShare): the starter Office admin
        // (its name is fixed and unique) or a role still listing the retired key.
        else setWhy(o.office?.role === 'Office admin' || o.office?.keys.includes('office.module.share') ? null : SHARE_NEEDED);
      })
      .catch((e) => { if (alive) setWhy((e as Error).message); });
    return () => { alive = false; };
  }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await moduleShare(slug, !shared);
      onChange(r.shared);
      toast(shared
        ? `${slug} is no longer shared with the team. Notes already sent stay with the team.`
        : `${slug} is now shared with the whole team.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1">
      <button type="button" onClick={toggle} disabled={!!why || busy} title={why ?? undefined} className={buttonClass}>
        {shared ? 'Stop sharing' : 'Share with the team'}
      </button>
      {why && <p className="text-xs text-gray-500">{why}</p>}
      {boundProject && (
        <p className="text-xs text-gray-500">
          This module is bound to {boundProject}: its new notes go to {boundProject} and follow that project, not this switch.
          Sharing covers its notes in no project.
        </p>
      )}
    </div>
  );
}
