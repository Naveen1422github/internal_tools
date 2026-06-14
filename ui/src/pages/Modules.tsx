import { useEffect, useState } from 'react';
import { modules, moduleCard } from '../api/client';
import { useUi } from '../store/ui';

export default function Modules() {
  const { openDrawer } = useUi();
  const [moduleList, setModuleList] = useState<any[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [card, setCard] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);

  useEffect(() => {
    modules()
      .then(res => setModuleList(res.results))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedSlug) {
      setCardLoading(true);
      moduleCard(selectedSlug)
        .then(setCard)
        .catch(console.error)
        .finally(() => setCardLoading(false));
    } else {
      setCard(null);
    }
  }, [selectedSlug]);

  if (loading) return <div className="p-8 text-gray-500 animate-pulse">Loading modules...</div>;

  return (
    <div className="flex h-full gap-8 animate-in fade-in duration-500">
      <div className="w-1/3 flex flex-col gap-4">
        <h2 className="text-xl font-bold tracking-tight">Modules</h2>
        <div className="flex-1 overflow-y-auto space-y-2 pr-2">
          {moduleList.map(m => (
            <button
              key={m.slug}
              onClick={() => setSelectedSlug(m.slug)}
              className={`w-full text-left p-4 rounded-lg border transition-all ${
                selectedSlug === m.slug 
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 shadow-sm' 
                  : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 bg-white dark:bg-gray-950'
              }`}
            >
              <div className="font-semibold text-sm">{m.name || m.slug}</div>
              <div className="text-xs text-gray-500 mt-1 line-clamp-1">{m.goal || 'No goal defined.'}</div>
              <div className="mt-2 flex items-center justify-between">
                <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  m.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                }`}>
                  {m.status || 'unknown'}
                </span>
                <span className="text-[10px] font-mono text-gray-400">{m.slug}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl overflow-y-auto shadow-inner">
        {selectedSlug ? (
          cardLoading ? (
            <div className="p-12 text-center text-gray-500 animate-pulse">Loading module details...</div>
          ) : card ? (
            <div className="p-8 space-y-8 animate-in slide-in-from-bottom-2 duration-300">
              <header className="border-b border-gray-100 dark:border-gray-800 pb-6">
                <div className="flex items-center gap-2 mb-2">
                   <h1 className="text-2xl font-bold">{card.module.name || card.module.slug}</h1>
                   <span className="text-sm font-mono text-gray-400">/{card.module.slug}</span>
                </div>
                <p className="text-gray-600 dark:text-gray-400 leading-relaxed text-sm">{card.module.goal}</p>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <section className="space-y-4">
                   <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Active Tasks</h3>
                   <div className="space-y-2">
                     {card.active_tasks?.length > 0 ? card.active_tasks.map((t: any) => (
                       <div key={t.id} className="p-3 bg-gray-50 dark:bg-gray-900 rounded border border-gray-100 dark:border-gray-800 group hover:border-blue-300 dark:hover:border-blue-700 transition-colors">
                         <div className="text-sm font-medium">{t.title}</div>
                         <div className="text-[10px] text-gray-400 mt-1 uppercase font-bold tracking-tighter">{t.status} • {t.id}</div>
                       </div>
                     )) : <div className="text-sm text-gray-500 italic p-4 border border-dashed border-gray-100 dark:border-gray-800 rounded">No active tasks.</div>}
                   </div>
                </section>

                <section className="space-y-4">
                   <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Top Gotchas</h3>
                   <div className="space-y-2">
                     {card.top_gotchas?.length > 0 ? card.top_gotchas.map((g: any) => (
                       <div key={g.id} className="p-3 bg-amber-50/50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded text-sm text-amber-900 dark:text-amber-200">
                         <span className="font-semibold text-amber-700 dark:text-amber-400 mr-2 font-mono">!</span>
                         {g.summary}
                       </div>
                     )) : <div className="text-sm text-gray-500 italic p-4 border border-dashed border-gray-100 dark:border-gray-800 rounded">No critical gotchas logged.</div>}
                   </div>
                </section>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4">
                <section className="space-y-4">
                   <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Knowledge Indexes</h3>
                   <div className="space-y-2">
                     {card.indexes?.length > 0 ? card.indexes.map((idx: any) => (
                       <div key={idx.id} className="p-3 bg-blue-50/30 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded group cursor-pointer hover:bg-blue-50 transition-colors" onClick={() => openDrawer(idx.id)}>
                         <div className="text-sm font-medium text-blue-900 dark:text-blue-300 group-hover:underline">{idx.title}</div>
                         <div className="text-[10px] text-blue-700/60 dark:text-blue-400/60 mt-1 line-clamp-1">{idx.summary}</div>
                       </div>
                     )) : <div className="text-sm text-gray-500 italic p-4 border border-dashed border-gray-100 dark:border-gray-800 rounded">No indexes found.</div>}
                   </div>
                </section>

                <section className="space-y-4">
                   <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Recent Handoffs</h3>
                   <div className="space-y-2">
                     {card.recent_handoffs?.length > 0 ? card.recent_handoffs.map((h: any) => (
                       <div key={h.id} className="p-3 bg-gray-50 dark:bg-gray-900 rounded border border-gray-100 dark:border-gray-800 group cursor-pointer hover:border-gray-300 transition-colors" onClick={() => openDrawer(h.id)}>
                         <div className="flex justify-between items-start gap-2">
                           <div className="text-sm font-medium truncate">{h.title}</div>
                           <span className="shrink-0 text-[9px] font-mono text-gray-400 uppercase">{h.agent}</span>
                         </div>
                         <div className="text-[10px] text-gray-500 mt-1 line-clamp-1">{h.summary}</div>
                       </div>
                     )) : <div className="text-sm text-gray-500 italic p-4 border border-dashed border-gray-100 dark:border-gray-800 rounded">No recent handoffs.</div>}
                   </div>
                </section>
              </div>

              <section className="space-y-4 pt-4">
                 <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Recent Decisions</h3>
                 <div className="border border-gray-100 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-gray-950">
                   <table className="w-full text-sm">
                     <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
                       <tr>
                         <th className="px-4 py-2 text-left font-bold text-[10px] uppercase tracking-wider text-gray-400">Decision</th>
                         <th className="px-4 py-2 text-right font-bold text-[10px] uppercase tracking-wider text-gray-400">Date</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                       {card.recent_decisions?.map((d: any) => (
                         <tr key={d.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                           <td className="px-4 py-3 font-medium">{d.title}</td>
                           <td className="px-4 py-3 text-right text-gray-500 font-mono text-[10px]">{new Date(d.created_at).toLocaleDateString()}</td>
                         </tr>
                       ))}
                       {(!card.recent_decisions || card.recent_decisions.length === 0) && (
                         <tr><td colSpan={2} className="px-4 py-8 text-center text-gray-400 italic">No recent decisions.</td></tr>
                       )}
                     </tbody>
                   </table>
                 </div>
              </section>
            </div>
          ) : (
             <div className="p-12 text-center text-gray-500">Failed to load module card.</div>
          )
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-12 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gray-50 dark:bg-gray-900 flex items-center justify-center text-2xl grayscale opacity-50">📦</div>
            <div>
              <h3 className="text-lg font-semibold">Select a Module</h3>
              <p className="text-sm text-gray-500 max-w-xs">Pick a module from the left to view its active tasks, decisions, and knowledge indexes.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
