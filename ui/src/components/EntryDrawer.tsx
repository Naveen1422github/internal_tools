import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUi } from '../store/ui';
import { getEntry, upsertEntry, supersede, deleteEntry, type Entry } from '../api/client';
import Drawer from './Drawer';
import Markdown from './Markdown';
import { useSyncOverview } from '../sync/useSyncOverview';
import { shareLabel, saveNote, SHARED_LABEL, PRIVATE_LABEL } from '../sync/view';
import { formatEntryRef } from '../format';

export default function EntryDrawer() {
  const { drawerEntryId, closeDrawer, openDrawer } = useUi();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<Entry>>({});
  const sync = useSyncOverview();

  useEffect(() => {
    if (drawerEntryId) {
      setLoading(true);
      setError(null);
      getEntry(drawerEntryId)
        .then(res => {
          setEntry(res);
          setEditData(res);
        })
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
    } else {
      setEntry(null);
      setIsEditing(false);
    }
  }, [drawerEntryId]);

  const handleSave = async () => {
    if (!entry) return;
    try {
      const res = await upsertEntry({ ...editData, id: entry.id });
      if (res.ok) {
        setIsEditing(false);
        const updated = await getEntry(entry.id);
        setEntry(updated);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSupersede = async () => {
    if (!entry) return;
    const by = prompt('Enter the ID of the entry that supersedes this one:');
    if (!by) return;
    const byId = parseInt(by);
    if (isNaN(byId)) return alert('Invalid ID');

    if (confirm(`Supersede entry ${entry.id} by ${byId}?`)) {
      try {
        const res = await supersede([entry.id], byId);
        if (res.ok) {
          const updated = await getEntry(entry.id);
          setEntry(updated);
        }
      } catch (err: any) {
        alert(err.message);
      }
    }
  };

  const handleDelete = async () => {
    if (!entry) return;
    if (confirm('Are you sure? It is usually better to supersede an entry to keep history.')) {
      try {
        const res = await deleteEntry(entry.id);
        if (res.ok) {
          closeDrawer();
        }
      } catch (err: any) {
        alert(err.message);
      }
    }
  };

  return (
    <Drawer open={!!drawerEntryId} onClose={closeDrawer}>
      {loading && <div className="p-4 text-gray-500 animate-pulse">Loading entry...</div>}
      {error && <div className="p-4 text-red-500">Error: {error}</div>}
      {entry && (
        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
          <header className="flex justify-between items-start">
             <div>
                <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest mb-1">{entry.type}</div>
                {isEditing ? (
                  <input 
                    className="text-xl font-bold w-full bg-transparent border-b border-blue-500 outline-none"
                    value={editData.title || ''}
                    onChange={e => setEditData({...editData, title: e.target.value})}
                  />
                ) : (
                  <h2 className="text-xl font-bold leading-tight">{entry.title}</h2>
                )}
                {(() => {
                  const label = shareLabel(entry.module, sync);
                  if (!label && !entry.author) return null;
                  return (
                    <div className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                      {label && (
                        <span className={`px-1.5 py-0.5 rounded ${label === 'shared' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                          {label === 'shared' ? SHARED_LABEL : PRIVATE_LABEL}
                        </span>
                      )}
                      {entry.author && <span>· by {entry.author}</span>}
                    </div>
                  );
                })()}
             </div>
             <div className="text-xs font-mono text-gray-400">{formatEntryRef(entry.id)}</div>
          </header>

          {entry.needs_merge === 1 && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-800 dark:text-amber-200 flex items-center justify-between">
              <span>⚠ This note needs a merge: two versions exist.</span>
              <Link to={`/merge/${entry.id}`} onClick={() => closeDrawer()} className="font-bold underline">Pick the final text</Link>
            </div>
          )}

          {entry.superseded_by && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-800 dark:text-amber-200 flex items-center justify-between">
              <span>Superseded by <button onClick={() => openDrawer(entry.superseded_by!)} className="font-mono font-bold underline">{formatEntryRef(entry.superseded_by)}</button></span>
              <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 bg-amber-200 dark:bg-amber-800 rounded">Legacy</span>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Summary</h3>
            {isEditing ? (
              <textarea 
                className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-2 outline-none h-20"
                value={editData.summary || ''}
                onChange={e => setEditData({...editData, summary: e.target.value})}
              />
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300">{entry.summary}</p>
            )}
          </div>

          {!isEditing && entry.description && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Description</h3>
              <Markdown className="text-sm text-gray-700 dark:text-gray-300 font-serif leading-relaxed bg-gray-50 dark:bg-gray-900/50 p-3 rounded">
                {entry.description}
              </Markdown>
            </div>
          )}

          {isEditing && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Description</h3>
              <textarea 
                className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-2 outline-none h-40 font-mono"
                value={editData.description || ''}
                onChange={e => setEditData({...editData, description: e.target.value})}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-100 dark:border-gray-800">
             <div>
               <h4 className="text-[10px] font-bold text-gray-400 uppercase">Module</h4>
               <p className="text-sm font-medium">{entry.module || '—'}</p>
             </div>
             <div>
               <h4 className="text-[10px] font-bold text-gray-400 uppercase">Agent</h4>
               <p className="text-sm font-medium">{entry.agent || '—'}</p>
             </div>
             <div>
               <h4 className="text-[10px] font-bold text-gray-400 uppercase">Category</h4>
               <p className="text-sm font-medium">{entry.category || '—'}</p>
             </div>
             <div>
               <h4 className="text-[10px] font-bold text-gray-400 uppercase">Status</h4>
               <p className="text-sm font-medium uppercase tracking-wide">{entry.status || '—'}</p>
             </div>
          </div>

          {entry.refs && entry.refs.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">References</h3>
              <ul className="space-y-1">
                {entry.refs.map((ref, i) => {
                  const isEntry = ref.ref_type === 'entry' && !isNaN(parseInt(ref.ref_value));
                  const isUrl = ref.ref_type === 'url' && (ref.ref_value.startsWith('http') || ref.ref_value.startsWith('/'));
                  
                  return (
                    <li key={i} className="text-sm flex gap-2">
                      <span className="text-gray-400 font-mono text-[10px] uppercase w-12 pt-0.5">{ref.ref_type}</span>
                      {isEntry ? (
                        <button 
                          onClick={() => openDrawer(parseInt(ref.ref_value))}
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left"
                        >
                          {formatEntryRef(parseInt(ref.ref_value))}
                        </button>
                      ) : isUrl ? (
                        <a 
                          href={ref.ref_value} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline break-all"
                        >
                          {ref.ref_value}
                        </a>
                      ) : (
                        <span className="font-medium text-gray-700 dark:text-gray-300 break-all">{ref.ref_value}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="pt-8 flex flex-col gap-2">
             {isEditing && saveNote(editData.module ?? entry.module, sync) && (
               <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded text-xs text-blue-800 dark:text-blue-200">
                 {saveNote(editData.module ?? entry.module, sync)}
               </div>
             )}
             {isEditing ? (
               <div className="flex gap-2">
                 <button onClick={handleSave} className="flex-1 py-2 px-4 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 transition-colors">Save Changes</button>
                 <button onClick={() => setIsEditing(false)} className="py-2 px-4 bg-gray-100 dark:bg-gray-800 rounded text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
               </div>
             ) : (
               <>
                 <button onClick={() => setIsEditing(true)} className="w-full py-2 px-4 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-sm font-medium transition-colors">Edit Entry</button>
                 <button onClick={handleSupersede} className="w-full py-2 px-4 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded text-sm font-medium transition-colors">Supersede</button>
                 <button onClick={handleDelete} className="w-full py-2 px-4 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded text-sm font-medium transition-colors">Delete</button>
               </>
             )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
