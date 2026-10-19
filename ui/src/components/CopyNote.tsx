import { useEffect, useRef, useState } from 'react';
import { copyApply, copyPlan, projectsList, type CopyPlanView, type Entry, type ProjectRow } from '../api/client';
import { useUi } from '../store/ui';
import Dialog from './Dialog';
import { toast } from './Toast';

// UI parity Task 10 (D10): "move" a note to another project. A note's number is
// its project's (SH-12), so core moves notes only by copying (spec P8): this is
// `collab copy --from note:<ref> --to <CODE>`, the same list -> ask -> copy.

export default function CopyNote({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { openDrawer } = useUi();
  const [targets, setTargets] = useState<ProjectRow[] | null>(null);
  const [to, setTo] = useState('');
  const [plan, setPlan] = useState<CopyPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = `note:${entry.ulid}`;

  useEffect(() => {
    const own = entry.series && entry.series !== 'E' ? entry.series : null;
    projectsList().then((r) => setTargets(r.projects.filter((p) => !p.left_at && p.code !== own))).catch((e) => setError((e as Error).message));
  }, [entry.series]);

  // The list for the chosen project; an answer for an earlier choice is dropped.
  const asked = useRef(0);
  useEffect(() => {
    setPlan(null); setError(null);
    if (!to) return;
    const n = ++asked.current;
    copyPlan({ from, to })
      .then((p) => { if (n === asked.current) setPlan(p); })
      .catch((e) => { if (n === asked.current) setError((e as Error).message); });
  }, [from, to]);

  const copy = async () => {
    if (!plan) return;
    setBusy(true); setError(null);
    try {
      const r = await copyApply({ from, to }, plan.items.map((i) => i.ulid), plan.target.ulid);
      onClose();
      toast(r.lines.join('\n'));
      const made = r.copied[0];
      // A team copy made while the office is away waits for its number: open it by its ULID.
      if (made) openDrawer(made.pending ? { ulid: made.to_ulid } : made.to);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const skipped = plan?.skipped[0];
  return (
    <Dialog
      title="Copy to another project"
      confirmLabel="Copy note"
      confirmDisabled={!plan || plan.items.length === 0}
      busy={busy}
      error={error}
      onConfirm={copy}
      onCancel={onClose}
    >
      <p className="text-sm">
        A note's number belongs to its project, so a note moves by copying: the copy is a new note numbered by the project
        you choose. This note stays as it is, with a link to its copy.
      </p>
      {targets === null && !error && <p className="text-sm text-gray-500">Loading projects…</p>}
      {targets?.length === 0 && <p className="text-sm">There is no other project to copy into. Create one on the Projects page.</p>}
      {targets && targets.length > 0 && (
        <label className="block space-y-1 text-sm">
          <span>Copy into</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm">
            <option value="">Choose a project…</option>
            {targets.map((p) => <option key={p.ulid} value={p.code}>{p.code} · {p.name}{p.mode === 'team' ? ' (team)' : ''}</option>)}
          </select>
        </label>
      )}
      {plan && plan.items.length > 0 && <p className="text-xs text-gray-600 dark:text-gray-400">{plan.lines[0]}</p>}
      {skipped && <p className="text-sm">This note was {skipped.reason}.</p>}
    </Dialog>
  );
}
