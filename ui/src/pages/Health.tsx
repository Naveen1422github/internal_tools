import { useEffect, useState } from 'react';
import { doctor, reassignModule, upsertEntry } from '../api/client';

export default function Health() {
  const [checks, setChecks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHealth = () => {
    setLoading(true);
    doctor()
      .then(res => setChecks(res.checks))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  const handleBulkReassign = async (ids: number[]) => {
    const mod = prompt('Enter module slug to assign (e.g. workspace-redesign):');
    if (!mod) return;
    try {
      const res = await reassignModule(ids, mod);
      if (res.ok) fetchHealth();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleFixSummary = async (id: number) => {
    const summary = prompt('Enter summary (max 200 chars):');
    if (!summary) return;
    try {
      const res = await upsertEntry({ id, summary });
      if (res.ok) fetchHealth();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading && checks.length === 0) return <div className="p-8 text-gray-500 animate-pulse">Running system diagnostics...</div>;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Health</h1>
          <p className="text-gray-500">Diagnostics and automated fixes.</p>
        </div>
        <button 
          onClick={fetchHealth}
          className={`px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          disabled={loading}
        >
          {loading ? 'Running...' : 'Run Doctor'}
        </button>
      </div>

      <div className="space-y-6 pb-12">
        {checks.map((check, i) => (
          <div key={i} className={`border rounded-lg overflow-hidden bg-white dark:bg-gray-950 shadow-sm ${
            check.severity === 'error' ? 'border-red-200 dark:border-red-900/50' : 
            check.severity === 'warn' ? 'border-amber-200 dark:border-amber-900/50' : 
            'border-gray-200 dark:border-gray-800'
          }`}>
            <div className={`px-4 py-3 flex items-center justify-between border-b ${
              check.severity === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-900/30' : 
              check.severity === 'warn' ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-900/30' : 
              'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-800'
            }`}>
              <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${
                  check.severity === 'error' ? 'bg-red-500' : 
                  check.severity === 'warn' ? 'bg-amber-500' : 
                  'bg-green-500'
                }`} />
                <h3 className="font-bold text-xs uppercase tracking-widest">{check.name}</h3>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                check.severity === 'error' ? 'bg-red-200 text-red-800' : 
                check.severity === 'warn' ? 'bg-amber-200 text-amber-800' : 
                'bg-green-200 text-green-800'
              }`}>
                {check.severity}
              </span>
            </div>

            <div className="p-4 space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">{check.detail}</p>
              
              {check.items && check.items.length > 0 && (
                <div className="space-y-3">
                   <div className="max-h-60 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-md bg-white dark:bg-gray-900">
                     <table className="w-full text-[11px]">
                        <thead className="bg-gray-50 dark:bg-gray-950 sticky top-0 border-b border-gray-100 dark:border-gray-800">
                          <tr>
                            <th className="px-3 py-2 text-left font-bold uppercase tracking-tighter text-gray-400">ID</th>
                            <th className="px-3 py-2 text-left font-bold uppercase tracking-tighter text-gray-400">Context</th>
                            <th className="px-3 py-2 text-right font-bold uppercase tracking-tighter text-gray-400">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                          {check.items.map((item: any) => (
                            <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                              <td className="px-3 py-2 font-mono text-gray-400">E-{String(item.id).padStart(5, '0')}</td>
                              <td className="px-3 py-2 truncate max-w-xs font-medium">{item.title || item.name || item.slug}</td>
                              <td className="px-3 py-2 text-right">
                                {check.name.toLowerCase().includes('summary') && (
                                  <button onClick={() => handleFixSummary(item.id)} className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-bold uppercase tracking-tighter">Fix</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                     </table>
                   </div>

                   {check.name.toLowerCase().includes('module') && (
                     <button 
                       onClick={() => handleBulkReassign(check.items.map((it: any) => it.id))}
                       className="w-full py-2 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded text-[10px] font-bold uppercase tracking-widest transition-colors border border-blue-100 dark:border-blue-800"
                     >
                       Bulk Reassign {check.items.length} Entries
                     </button>
                   )}
                </div>
              )}
            </div>
          </div>
        ))}

        {checks.length === 0 && !loading && (
          <div className="p-12 text-center border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-xl space-y-2">
             <div className="text-2xl">✨</div>
             <h3 className="font-semibold text-gray-900 dark:text-gray-100">System Clear</h3>
             <p className="text-sm text-gray-500">All checks passed. No immediate actions needed.</p>
          </div>
        )}
      </div>
    </div>
  );
}
