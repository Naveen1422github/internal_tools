import { useEffect, useState } from 'react';
import { stats, type Stats } from '../api/client';
import { useUi } from '../store/ui';

export default function Dashboard() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { openDrawer } = useUi();

  useEffect(() => {
    stats()
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-gray-500 animate-pulse">Loading dashboard...</div>;
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-gray-500">System overview and recent activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Entries" value={data.total} />
        <StatCard title="By Category" items={Object.entries(data.by_category)} />
        <StatCard title="By Type" items={Object.entries(data.by_type)} />
        <StatCard title="By Status" items={Object.entries(data.by_status)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-gray-950">
            {data.recent.length > 0 ? (
              <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                {data.recent.map((entry) => (
                  <li 
                    key={entry.id} 
                    className="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer flex items-start gap-4 transition-colors"
                    onClick={() => openDrawer(entry.id)}
                  >
                    <div className="shrink-0 w-10 h-10 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-[10px] font-mono font-bold text-gray-500">
                      {entry.type.slice(0, 3).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{entry.title}</p>
                        <time className="shrink-0 text-xs text-gray-400">
                          {entry.created_at ? new Date(entry.created_at).toLocaleDateString() : 'recently'}
                        </time>
                      </div>
                      <p className="text-sm text-gray-500 truncate">{entry.summary}</p>
                      <div className="mt-1 flex gap-2">
                        {entry.module && (
                          <span className="text-[10px] bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-wider">
                            {entry.module}
                          </span>
                        )}
                        <span className="text-[10px] bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-wider">
                          {entry.agent}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-8 text-center text-gray-500 text-sm">No recent activity.</div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Top Modules</h2>
          <div className="space-y-2">
            {data.top_modules.length > 0 ? (
              data.top_modules.map((m) => (
                <div key={m.module} className="flex items-center justify-between p-3 border border-gray-100 dark:border-gray-800 rounded-md bg-white dark:bg-gray-950">
                  <span className="text-sm font-medium">{m.module}</span>
                  <span className="text-xs font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">{m.count}</span>
                </div>
              ))
            ) : (
              <div className="text-sm text-gray-500">No modules found.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, items }: { title: string; value?: number; items?: [string, number][] }) {
  return (
    <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-950 shadow-sm">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{title}</h3>
      {value !== undefined ? (
        <div className="text-2xl font-bold">{value}</div>
      ) : (
        <div className="space-y-1">
          {items?.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400 truncate mr-2">{k}</span>
              <span className="font-mono font-medium">{v}</span>
            </div>
          ))}
          {(!items || items.length === 0) && <div className="text-sm text-gray-400 italic">None</div>}
        </div>
      )}
    </div>
  );
}
