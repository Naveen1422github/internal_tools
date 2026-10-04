import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { needsMerge } from '../api/client';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/knowledge', label: 'Knowledge' },
  { to: '/modules', label: 'Modules' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/health', label: 'Health' },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-md text-sm ${
    isActive ? 'bg-gray-200 dark:bg-gray-800 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-900'
  }`;

export default function Sidebar() {
  // Notes whose edits collided; the menu item shows only when there are some.
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => needsMerge().then((r) => { if (alive) setCount(r.results.length); }).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <nav className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-1">
      <div className="px-2 py-3 font-semibold tracking-tight">Knowledge Workspace</div>
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={navClass}
        >
          {l.label}
        </NavLink>
      ))}
      {count > 0 && (
        <NavLink to="/needs-merge" className={navClass}>
          Needs merge<span className="ml-2 rounded-full bg-amber-400 text-black px-2 text-xs">{count}</span>
        </NavLink>
      )}
    </nav>
  );
}
