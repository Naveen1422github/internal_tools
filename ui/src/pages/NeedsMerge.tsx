// file: ui/src/pages/NeedsMerge.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { needsMerge, type NeedsMergeRow } from '../api/client';
import { formatEntryRef } from '../format';

export default function NeedsMerge() {
  const [rows, setRows] = useState<NeedsMergeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { needsMerge().then((r) => setRows(r.results)).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="text-red-600">{error}</p>;
  if (!rows) return <p className="text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Needs merge</h1>
      <p className="text-sm text-gray-500">Two people changed these notes at the same time. Nothing was lost; pick the final text for each.</p>
      {rows.length === 0 ? <p>Nothing to merge.</p> : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((r) => (
            <li key={r.id} className="py-2 flex justify-between">
              <Link to={`/merge/${r.id}`} className="underline">{formatEntryRef(r.id)} · {r.title}</Link>
              <span className="text-xs text-gray-500">{r.module ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
