import { useEffect, useState } from 'react';
import { search, modules, projectsList, type Entry, type ProjectRow } from '../api/client';
import { useUi } from '../store/ui';
import { formatEntryRef, noteRefOf } from '../format';

export default function Knowledge() {
  const [results, setResults] = useState<Entry[]>([]);
  const [moduleList, setModuleList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    q: '',
    category: '',
    module: '',
    type: '',
    project: '',
  });
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const { openDrawer, setNewNoteOpen } = useUi();

  useEffect(() => {
    modules().then(res => setModuleList(res.results)).catch(() => {});
    projectsList().then((r) => setProjects(r.projects)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      search(filters)
        .then(res => setResults(res.results))
        .catch(err => console.error(err))
        .finally(() => setLoading(false));
    }, filters.q ? 200 : 0);
    return () => clearTimeout(t);
  }, [filters]);

  return (
    <div className="flex h-full flex-col gap-6 md:flex-row animate-in fade-in duration-500">
      <aside className="w-full shrink-0 space-y-6 md:w-64">
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Category</h3>
          <div className="space-y-1">
            {['Index', 'Reference', 'Activity'].map(cat => (
              <button
                key={cat}
                onClick={() => setFilters({ ...filters, category: filters.category === cat ? '' : cat })}
                className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                  filters.category === cat ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Module</h3>
          <select 
            className="w-full bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
            value={filters.module}
            onChange={e => setFilters({ ...filters, module: e.target.value })}
          >
            <option value="">All Modules</option>
            {moduleList.map(m => (
              <option key={m.slug} value={m.slug}>{m.name || m.slug}</option>
            ))}
          </select>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Project</h3>
          <select
            aria-label="Project"
            className="w-full bg-transparent border border-gray-200 dark:border-gray-800 rounded p-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
            value={filters.project}
            onChange={e => setFilters({ ...filters, project: e.target.value })}
          >
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.ulid} value={p.code}>{p.code} · {p.name}</option>)}
            <option value="none">No project (E series)</option>
          </select>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Type</h3>
          <input 
            type="text"
            placeholder="Filter by type..."
            className="w-full bg-transparent border border-gray-200 dark:border-gray-800 rounded px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
            value={filters.type}
            onChange={e => setFilters({ ...filters, type: e.target.value })}
          />
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex gap-2">
          <input 
            type="text"
            placeholder="Search entries..."
            className="w-full bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 shadow-sm"
            value={filters.q}
            onChange={e => setFilters({ ...filters, q: e.target.value })}
          />
          <button type="button" onClick={() => setNewNoteOpen(true)} className="shrink-0 rounded-lg border border-gray-200 dark:border-gray-800 px-3 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-900">New note</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pr-2">
          {loading ? (
            <div className="p-8 text-center text-gray-500 animate-pulse">Searching knowledge...</div>
          ) : results.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 pb-8">
              {results.map(r => (
                <div 
                  key={`${r.series ?? 'E'}-${r.id}`} 
                  className={`p-4 border rounded-lg cursor-pointer transition-all hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md bg-white dark:bg-gray-950 group ${r.superseded_by ? 'opacity-60 grayscale-[0.3]' : ''}`}
                  onClick={() => openDrawer(noteRefOf(r))}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{r.type}</span>
                    <span className="text-[10px] font-mono text-gray-400 group-hover:text-blue-500 transition-colors">{formatEntryRef(r.id, r.series)}</span>
                  </div>
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{r.title}</h3>
                  <p className="text-sm text-gray-500 mt-1 line-clamp-2">{r.summary}</p>
                  <div className="mt-3 flex gap-2 overflow-x-hidden">
                    {r.series && r.series !== 'E' && (
                      <span title={projects.find((p) => p.code === r.series)?.name} className="text-[10px] bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300 px-1.5 py-0.5 rounded font-bold tracking-wider">
                        {r.series}{projects.find((p) => p.code === r.series) ? ` · ${projects.find((p) => p.code === r.series)!.name}` : ''}
                      </span>
                    )}
                    {r.module && <span className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">{r.module}</span>}
                    {r.category && <span className="text-[10px] bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">{r.category}</span>}
                    {r.superseded_by && <span className="text-[10px] bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">Superseded</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-12 text-center text-gray-500 border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-xl">
              No results found for your filters.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
