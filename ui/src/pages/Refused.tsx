import { useEffect, useRef, useState } from 'react';
import { refusedCopy, refusedDelete, refusedList, type RefusedList, type RefusedRow } from '../api/client';
import { localTimeOfUtc } from '../format';

// RnR S3 (R6, S3-10): changes the post office refused, kept on this laptop only.
// Copy and delete are the same core calls as `collab refused copy|delete`; the
// reason and any refusal are shown exactly as they arrive.

type Solo = RefusedList['solo_projects'][number];
const KIND = { new: 'New note', edit: 'Edit' } as const;
const button = 'rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';

export default function Refused() {
  const [list, setList] = useState<RefusedList | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RefusedRow | null>(null);
  // Rows with a copy or delete on its way: their buttons wait, so nothing is copied twice.
  // The ref answers at once (two clicks in one tick); the state redraws the buttons.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  // The Delete button that opened the panel: Cancel or a refusal gives focus back to it; a delete moves it to the heading.
  const opener = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refocus = () => (opener.current?.isConnected ? opener.current : headingRef.current)?.focus();

  useEffect(() => {
    let alive = true;
    refusedList().then((l) => { if (alive) setList(l); }).catch((e) => { if (alive) setFatal((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const mark = (id: string, on: boolean) => {
    if (on) inFlight.current.add(id); else inFlight.current.delete(id);
    setPending(new Set(inFlight.current));
  };

  /**
   * Runs one change for a row, then reads the list again. Resolves the change's
   * answer, or null after a refusal. A failed reload after a change that worked
   * still resolves the answer; its error goes in the banner.
   */
  const act = async <T,>(id: string, change: () => Promise<T>): Promise<T | null> => {
    setBanner(null);
    setDone(null);
    mark(id, true);
    try {
      let answer: T;
      try {
        answer = await change();
      } catch (e) {
        setBanner((e as Error).message);
        return null;
      }
      try { setList(await refusedList()); } catch (e) { setBanner((e as Error).message); }
      return answer;
    } finally {
      mark(id, false);
    }
  };

  const copy = async (r: RefusedRow, to: string) => {
    if (inFlight.current.has(r.id)) return;
    const answer = await act(r.id, () => refusedCopy(r.id, to));
    if (answer) setDone(`Copied as ${answer.ref}.`);
  };

  const remove = async (r: RefusedRow) => {
    setConfirming(null);
    if (inFlight.current.has(r.id)) return;
    const answer = await act(r.id, () => refusedDelete(r.id));
    // After a delete the row is about to go (its button is still there until the redraw): land on the heading.
    if (answer) headingRef.current?.focus(); else refocus();
  };

  const cancelDelete = () => { setConfirming(null); refocus(); };

  const heading = <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight focus:outline-none">Refused changes</h1>;
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
          {confirming && <ConfirmDelete row={confirming} onDelete={() => remove(confirming)} onCancel={cancelDelete} />}
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
                  <Row
                    key={r.id}
                    row={r}
                    solo={solo}
                    busy={pending.has(r.id)}
                    onCopy={(to) => copy(r, to)}
                    onDelete={(from) => { opener.current = from; setConfirming(r); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ row, solo, busy, onCopy, onDelete }: {
  row: RefusedRow;
  solo: Solo[];
  /** A copy or delete for this row is on its way. */
  busy: boolean;
  onCopy: (to: string) => void;
  onDelete: (from: HTMLButtonElement) => void;
}) {
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
              <button type="button" disabled={busy} onClick={() => onCopy(target)} className={button}>Copy</button>
            </>
          )}
          <button type="button" disabled={busy} onClick={(e) => onDelete(e.currentTarget)} className={button}>Delete</button>
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
