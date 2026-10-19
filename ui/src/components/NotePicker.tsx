import { useEffect, useId, useRef, useState } from 'react';
import { search, type Entry } from '../api/client';
import { formatEntryRef } from '../format';

// UI parity Task 12 (D): pick a note by searching for it, instead of typing its
// number. Uses the same search as Knowledge; `exclude` drops the note itself.

const key = (e: Entry) => e.ulid ?? `${e.series ?? 'E'}-${e.id}`;

export default function NotePicker({ label, exclude, value, onChange }: {
  /** The note itself, by ULID and by number: never offered. */
  label: string; exclude: string[]; value: Entry | null; onChange: (e: Entry | null) => void;
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Entry[]>([]);
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    const t = setTimeout(() => {
      search({ q, kind: 'any' })
        // Not the note itself (by ULID or number), and not a note still waiting for its number: it can't be named yet.
        .then((r) => { if (n === asked.current) setResults(r.results.filter((e) => e.id != null && !exclude.includes(key(e)) && !exclude.includes(formatEntryRef(e.id, e.series)))); })
        .catch(() => { if (n === asked.current) setResults([]); });
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, exclude]);

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm">{label}</label>
      <input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or text…"
        className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm" />
      <ul aria-label={label} className="max-h-56 overflow-y-auto rounded border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
        {results.map((e) => {
          const chosen = value !== null && key(value) === key(e);
          return (
            <li key={key(e)}>
              <button type="button" aria-pressed={chosen} onClick={() => onChange(chosen ? null : e)}
                className={`w-full px-2 py-1.5 text-left text-sm ${chosen ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-900'}`}>
                <span className="font-mono text-xs text-gray-500">{formatEntryRef(e.id, e.series)}</span> {e.title}
              </button>
            </li>
          );
        })}
        {results.length === 0 && <li className="px-2 py-3 text-sm text-gray-500">No matching notes.</li>}
      </ul>
    </div>
  );
}
