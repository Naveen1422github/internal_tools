import { useEffect, useRef, useState } from 'react';
import { refusedCopy, refusedDelete, refusedList, type RefusedList, type RefusedRow } from '../api/client';
import { localTimeOfUtc } from '../format';

// RnR S3 (R6, S3-10): changes the post office refused, kept on this laptop only.
// Copy and delete are the same core calls as `collab refused copy|delete`; the
// reason and any refusal are shown exactly as they arrive.

type Solo = RefusedList['solo_projects'][number];
const KIND = { new: 'New note', edit: 'Edit' } as const;
const button = 'rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-900';

export default function Refused() {
  const [list, setList] = useState<RefusedList | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RefusedRow | null>(null);

  useEffect(() => {
    let alive = true;
    refusedList().then((l) => { if (alive) setList(l); }).catch((e) => { if (alive) setFatal((e as Error).message); });
    return () => { alive = false; };
  }, []);

  /** Runs one change, then reads the list again. Resolves the change's answer, or null after a refusal. */
  const act = async <T,>(change: () => Promise<T>): Promise<T | null> => {
    setBanner(null);
    setDone(null);
    try {
      const answer = await change();
      setList(await refusedList());
      return answer;
    } catch (e) {
      setBanner((e as Error).message);
      return null;
    }
  };

  const copy = async (r: RefusedRow, to: string) => {
    const answer = await act(() => refusedCopy(r.id, to));
    if (answer) setDone(`Copied as ${answer.ref}.`);
  };

  const remove = async (r: RefusedRow) => {
    setConfirming(null);
    await act(() => refusedDelete(r.id));
  };

  const heading = <h1 className="text-2xl font-bold tracking-tight">Refused changes</h1>;
  if (fatal) return <div className="space-y-4">{heading}<p className="text-sm">{fatal}</p></div>;
  if (!list) return <div className="space-y-4">{heading}<p className="text-gray-500">Loading…</p></div>;

  const rows = list.results;
  const solo = list.solo_projects;
  return (
    <div className="space-y-4">
      {heading}
      <p className="text-sm text-gray-500">The post office turned down these changes. They are kept on this laptop only.</p>

      {banner && (
        <div role="alert" className="flex items-start justify-between gap-4 border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3 text-sm">
          <p>{banner}</p>
          <button type="button" onClick={() => setBanner(null)} className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:underline">
            Dismiss
          </button>
        </div>
      )}
      {done && <p role="status" className="text-sm text-green-700 dark:text-green-400">{done}</p>}

      {rows.length === 0 ? <p className="text-sm">Nothing was refused.</p> : (
        <>
          {solo.length === 0 && (
            <p className="text-sm text-gray-500">Create a solo project first: <code>{'collab project create <name>'}</code>.</p>
          )}
          {confirming && <ConfirmDelete row={confirming} onDelete={() => remove(confirming)} onCancel={() => setConfirming(null)} />}
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Project</th>
                  <th className="px-3 py-2 font-semibold">Kind</th>
                  <th className="px-3 py-2 font-semibold">Note</th>
                  <th className="px-3 py-2 font-semibold">Reason</th>
                  <th className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {rows.map((r) => (
                  <Row key={r.id} row={r} solo={solo} onCopy={(to) => copy(r, to)} onDelete={() => setConfirming(r)} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ row, solo, onCopy, onDelete }: { row: RefusedRow; solo: Solo[]; onCopy: (to: string) => void; onDelete: () => void }) {
  const [to, setTo] = useState(solo[0]?.code ?? '');
  // The chosen project may be gone after a reload; fall back to the first one.
  const target = solo.some((p) => p.code === to) ? to : solo[0]?.code ?? '';
  return (
    <tr>
      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{localTimeOfUtc(row.at)}</td>
      <td className="px-3 py-2">{row.project_code}</td>
      <td className="px-3 py-2">{KIND[row.kind]}</td>
      <td className="px-3 py-2 whitespace-nowrap">{row.note}</td>
      <td className="px-3 py-2">{row.reason}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap justify-end gap-2">
          {solo.length > 0 && (
            <>
              <select
                aria-label="Copy to a solo project"
                value={target}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm"
              >
                {solo.map((p) => <option key={p.code} value={p.code}>{p.name ? `${p.code} · ${p.name}` : p.code}</option>)}
              </select>
              <button type="button" onClick={() => onCopy(target)} className={button}>Copy</button>
            </>
          )}
          <button type="button" onClick={onDelete} className={button}>Delete</button>
        </div>
      </td>
    </tr>
  );
}

function ConfirmDelete({ row, onDelete, onCancel }: { row: RefusedRow; onDelete: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="confirm-delete-text"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      className="border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 space-y-3"
    >
      <p id="confirm-delete-text" className="text-sm">
        Delete this refused change? What you typed is removed from this laptop.{row.kind === 'new' ? ' The note is removed too.' : ''}
      </p>
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
