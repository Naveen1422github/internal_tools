// file: ui/src/components/SyncBar.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { syncStatus, type SyncOverview } from '../api/client';
import { barView } from '../sync/view';

const TONE = {
  ok: 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  bad: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
} as const;

/** Thin bar on every page (user chose A). Polls every 10 s and on focus. Hidden when sharing is off. */
export default function SyncBar() {
  const [o, setO] = useState<SyncOverview | null>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    let alive = true;
    const load = () => syncStatus().then((x) => { if (alive) { setO(x); setNow(new Date()); } }).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    window.addEventListener('focus', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', load); };
  }, []);
  const v = o ? barView(o, now) : null;
  if (!v) return null;
  return (
    <div role="status" className={`px-4 py-1.5 text-xs flex justify-between gap-4 ${TONE[v.tone]}`}>
      <span>{v.text}{v.fix ? <> · <code>{v.fix}</code></> : null} · <Link to="/health" className="underline">check setup</Link></span>
      {o?.enabled && <span className="opacity-70">shared: {o.sharedModules.join(', ') || 'none'}</span>}
    </div>
  );
}
