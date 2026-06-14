import { useEffect, useState } from 'react';
import { tasks } from '../api/client';

export default function Tasks() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tasks()
      .then(res => setData(res.results))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const statuses = ['active', 'todo', 'blocked', 'done'];
  const grouped = statuses.reduce((acc, status) => {
    acc[status] = data.filter(t => (t.status || 'todo').toLowerCase() === status);
    return acc;
  }, {} as Record<string, any[]>);

  // Catch any tasks with other statuses
  const otherTasks = data.filter(t => !statuses.includes((t.status || 'todo').toLowerCase()));

  if (loading) return <div className="p-8 text-gray-500 animate-pulse">Loading tasks...</div>;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <p className="text-gray-500">Project progress and action items.</p>
        </div>
        <div className="text-xs text-gray-400 font-mono">
          Total: {data.length}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statuses.map(status => (
          <div key={status} className="flex flex-col gap-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 px-1 flex items-center justify-between">
              {status}
              <span className="bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-[10px] font-mono">{grouped[status]?.length || 0}</span>
            </h3>
            <div className="flex-1 space-y-3 min-h-[200px]">
              {grouped[status]?.map(task => (
                <div key={task.id} className="p-4 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-sm hover:shadow-md transition-all group">
                  <div className="flex justify-between items-start mb-1">
                    <div className="text-[10px] font-mono text-gray-400 group-hover:text-blue-500 transition-colors">{task.id}</div>
                  </div>
                  <div className="text-sm font-semibold mb-3 leading-tight text-gray-900 dark:text-gray-100">{task.title}</div>
                  <div className="flex flex-wrap gap-2">
                    {task.module && (
                      <span className="text-[10px] bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                        {task.module}
                      </span>
                    )}
                    {task.assignee && (
                      <span className="text-[10px] bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                        {task.assignee}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {grouped[status]?.length === 0 && (
                <div className="p-8 border border-dashed border-gray-100 dark:border-gray-800 rounded-lg text-xs text-gray-400 text-center italic">
                  No tasks
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {otherTasks.length > 0 && (
        <div className="pt-8 border-t border-gray-100 dark:border-gray-800">
           <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-4">Other / Uncategorized</h3>
           <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
             {otherTasks.map(task => (
                <div key={task.id} className="p-3 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg">
                   <div className="text-[10px] font-mono text-gray-400">{task.id} • {task.status}</div>
                   <div className="text-sm font-medium mt-1">{task.title}</div>
                </div>
             ))}
           </div>
        </div>
      )}
    </div>
  );
}
