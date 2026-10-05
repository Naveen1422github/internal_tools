// file: ui/src/pages/Merge.tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { mergeVersions, resolveMerge, explainMerge, VERSIONS_CHANGED, type MergeView, type MergeVersion } from '../api/client';
import { fieldDiff, versionLabel } from '../sync/view';
import { formatEntryRef } from '../format';

type Draft = { title: string; summary: string; description: string | null };

/** /merge/:id (user chose its own page). Pick a version or combine by hand; refused if the versions changed meanwhile. */
export default function Merge() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [view, setView] = useState<MergeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    mergeVersions(id).then(setView).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const expected = () => view!.heads.map((h) => h.rev_id);
  async function save(choice: Draft) {
    setBusy(true);
    try {
      await resolveMerge(id, expected(), choice);
      navigate('/needs-merge');
    } catch (e: any) {
      if (e.message === VERSIONS_CHANGED) { setChanged(true); setDraft(null); load(); }
      else setError(e.message);
    } finally { setBusy(false); }
  }
  async function onExplain() {
    setExplain('…');
    try { setExplain((await explainMerge(id)).text); } catch { setExplain("couldn't explain"); }
  }

  if (error) return <p className="text-red-600">{error}</p>;
  if (!view) return <p className="text-gray-500">Loading…</p>;
  const diff = fieldDiff(view.heads);
  const field = (v: MergeVersion, k: 'title' | 'summary' | 'description', label: string) =>
    diff[k]
      ? <div><div className="text-xs font-semibold uppercase text-gray-400">{label}</div><div className="whitespace-pre-wrap">{v[k] ?? ''}</div></div>
      : <div className="text-xs text-gray-400">{label} · same in both</div>;

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 text-sm">
        ⚠ <b>Two people changed this note at the same time.</b> Nothing was lost. Pick the final text; the choice syncs to everyone.
      </div>
      {changed && (
        <div role="alert" className="p-3 rounded bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200 text-sm">
          <b>Someone changed this note while you were deciding.</b> Nothing was saved. Here are the versions now.
        </div>
      )}
      <h1 className="text-xl font-bold">{formatEntryRef(id)}</h1>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(view.heads.length, 3)}, minmax(0, 1fr))` }}>
        {view.heads.map((v, i) => (
          <div key={v.rev_id} className="border border-gray-300 dark:border-gray-700 rounded p-3 space-y-3 text-sm">
            <div className="text-xs font-semibold text-gray-500">{versionLabel(v, i)}</div>
            {field(v, 'title', 'Title')}
            {field(v, 'summary', 'Summary')}
            {field(v, 'description', 'Description')}
            <button disabled={busy} onClick={() => save({ title: v.title, summary: v.summary, description: v.description })}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Use this version</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => { const v = view.heads[0]; setDraft({ title: v.title, summary: v.summary, description: v.description }); }}
          className="px-3 py-1.5 rounded border text-sm">Combine by hand…</button>
        <button onClick={onExplain} className="px-3 py-1.5 rounded border text-sm">✦ Explain the difference (AI)</button>
      </div>
      {explain && <p className="text-sm whitespace-pre-wrap border-l-2 pl-3 text-gray-600 dark:text-gray-300">{explain}</p>}
      {draft && (
        <div className="space-y-2 border rounded p-3">
          <input className="w-full border rounded px-2 py-1" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input className="w-full border rounded px-2 py-1" value={draft.summary} maxLength={200} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          <textarea className="w-full border rounded px-2 py-1 h-40" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <button disabled={busy} onClick={() => save(draft)} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Save combined text</button>
        </div>
      )}
      <p className="text-xs text-gray-500">The AI only explains the difference; it never picks a version.</p>
    </div>
  );
}
