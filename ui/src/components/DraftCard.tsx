import { useState } from 'react';
import { upsertEntry, type Entry } from '../api/client';
import { useUi } from '../store/ui';

const TYPES = ['handoff', 'review', 'proposal', 'counter', 'decision', 'gotcha', 'session-note', 'changelog'];

export function draftErrors(d: Partial<Entry>): string[] {
  const errs: string[] = [];
  if (!d.type || !TYPES.includes(d.type)) errs.push(`invalid type: ${d.type ?? '(none)'}`);
  if (!d.title || !d.title.trim()) errs.push('title is required');
  if (!d.summary || !d.summary.trim()) errs.push('summary is required');
  else if (d.summary.length > 200) errs.push(`summary exceeds 200 chars (got ${d.summary.length})`);
  return errs;
}

// `validation` is the server's result; the card re-validates client-side after edits, so it
// accepts the prop for contract completeness but derives its own errors via draftErrors().
export default function DraftCard({ draft }: { draft: Partial<Entry>; validation: { ok: boolean; errors: string[] } }) {
  const { openDrawer } = useUi();
  const [edited, setEdited] = useState<Partial<Entry>>(draft);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);

  const errors = draftErrors(edited);
  const canSave = errors.length === 0 && !saving && savedId === null;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await upsertEntry(edited);
      if (res.ok) setSavedId(res.id);
    } catch (e: any) {
      setSaveError(e?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (discarded) return <div className="text-xs italic text-gray-400 px-3 py-2">Draft discarded.</div>;

  if (savedId !== null) {
    return (
      <div className="rounded-lg border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-900/20 px-3 py-2 text-sm">
        Saved as{' '}
        <button onClick={() => openDrawer(savedId)} className="font-mono font-bold underline text-green-700 dark:text-green-300">
          E-{String(savedId).padStart(5, '0')}
        </button>
      </div>
    );
  }

  const set = (k: keyof Entry, v: string) => setEdited((p) => ({ ...p, [k]: v }));

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-900/10 p-3 space-y-2">
      <div className="text-[10px] font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400">Proposed draft - review &amp; save</div>

      <select value={edited.type ?? ''} onChange={(e) => set('type', e.target.value)} className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 outline-none">
        <option value="" disabled>Select type...</option>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <input value={edited.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="Title"
        className="w-full text-sm font-semibold bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 outline-none" />

      <div>
        <textarea value={edited.summary ?? ''} onChange={(e) => set('summary', e.target.value)} placeholder="Summary (<=200 chars)" rows={2}
          className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 outline-none resize-none" />
        <div className={`text-[10px] text-right ${(edited.summary?.length ?? 0) > 200 ? 'text-red-500 font-bold' : 'text-gray-400'}`}>
          {edited.summary?.length ?? 0}/200
        </div>
      </div>

      <textarea value={edited.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="Description" rows={4}
        className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 outline-none resize-none font-mono" />

      <input value={edited.module ?? ''} onChange={(e) => set('module', e.target.value)} placeholder="module-slug (optional)"
        className="w-full text-xs bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 outline-none font-mono" />

      {errors.length > 0 && (
        <ul className="text-[11px] text-red-600 dark:text-red-400 list-disc pl-4">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {saveError && <div className="text-[11px] text-red-600 dark:text-red-400">{saveError}</div>}

      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={!canSave}
          className="flex-1 py-1.5 bg-blue-600 text-white rounded text-xs font-bold uppercase tracking-wider hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? 'Saving...' : 'Approve & Save'}
        </button>
        <button onClick={() => setDiscarded(true)}
          className="py-1.5 px-3 text-xs font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors">
          Discard
        </button>
      </div>
    </div>
  );
}
