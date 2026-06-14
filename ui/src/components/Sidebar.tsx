import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/knowledge', label: 'Knowledge' },
  { to: '/modules', label: 'Modules' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/health', label: 'Health' },
];

export default function Sidebar() {
  return (
    <nav className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-1">
      <div className="px-2 py-3 font-semibold tracking-tight">Knowledge Workspace</div>
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            `px-3 py-2 rounded-md text-sm ${
              isActive ? 'bg-gray-200 dark:bg-gray-800 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-900'
            }`
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
