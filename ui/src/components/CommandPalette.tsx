import { useEffect, useState } from 'react';
import { useUi } from '../store/ui';
import { search, type Entry } from '../api/client';
import { formatEntryRef, noteRefOf } from '../format';

export default function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUi();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Entry[]>([]);

  // ⌘K / Ctrl+K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    const t = setTimeout(() => {
      // Parse tokens: module: type: category: since:
      const tokens = ['module:', 'type:', 'category:', 'since:'];
      let cleanQ = q;
      const params: any = {};
      
      tokens.forEach(token => {
        if (q.includes(token)) {
          const parts = q.split(token);
          if (parts.length > 1) {
            const val = parts[1].split(' ')[0];
            if (val) {
              params[token.replace(':', '')] = val;
              cleanQ = cleanQ.replace(`${token}${val}`, '').trim();
            }
          }
        }
      });
      params.q = cleanQ;

      search(params).then((r) => setResults(r.results)).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, paletteOpen]);

  const { openDrawer } = useUi();

  if (!paletteOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" onClick={() => setPaletteOpen(false)}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-[600px] max-w-[90vw] bg-white dark:bg-gray-950 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center px-4 border-b border-gray-100 dark:border-gray-800">
          <span className="text-gray-400">🔍</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search (module: type: category: since:) …"
            className="w-full px-3 py-4 bg-transparent outline-none text-sm"
          />
          <kbd className="hidden sm:block px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-800 text-[10px] font-mono text-gray-400 bg-gray-50 dark:bg-gray-900">ESC</kbd>
        </div>
        <ul className="max-h-96 overflow-y-auto py-2">
          {results.map((r) => (
            <li 
              key={r.id} 
              className="px-4 py-3 text-sm hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer flex items-center justify-between group"
              onClick={() => {
                openDrawer(noteRefOf(r));
                setPaletteOpen(false);
                setQ('');
              }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="shrink-0 w-8 text-center text-[10px] font-mono font-bold text-gray-400 bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded uppercase">{r.type.slice(0, 3)}</span>
                <div className="min-w-0">
                  <div className="font-medium truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{r.title}</div>
                  <div className="text-[10px] text-gray-500 truncate">{r.summary}</div>
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                 {r.module && <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{r.module}</span>}
                 <span className="text-[10px] font-mono text-gray-400">{formatEntryRef(r.id, r.series)}</span>
              </div>
            </li>
          ))}
          {results.length === 0 && q && <li className="px-4 py-8 text-center text-sm text-gray-400 italic">No matching knowledge found</li>}
          {!q && <li className="px-4 py-8 text-center text-sm text-gray-400 italic">Start typing to search knowledge…</li>}
        </ul>
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center text-[10px] text-gray-400 uppercase tracking-widest font-bold">
           <span>Tokens: module:workspace type:handoff</span>
           <span>{results.length} results</span>
        </div>
      </div>
    </div>
  );
}
