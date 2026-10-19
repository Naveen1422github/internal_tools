import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { needsMerge, refusedList, teamOverview } from '../api/client';

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
  // S3-10: changes the post office refused; shown only when there are some.
  // Any failure hides it rather than keep a stale count.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => refusedList().then((r) => { if (alive) setRefused(r.results.length); }).catch(() => { if (alive) setRefused(0); });
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // S3-11: "Team" only for a notebook connected to a post office that is in a
  // team project or holds an office role. Asked once; any failure keeps it hidden.
  const [team, setTeam] = useState(false);
  useEffect(() => {
    let alive = true;
    teamOverview()
      .then((o) => { if (alive) setTeam(o.connected && (o.projects.length > 0 || o.office !== null)); })
      .catch(() => {});
    return () => { alive = false; };
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
      {team && <NavLink to="/team" className={navClass}>Team</NavLink>}
      {refused > 0 && (
        <NavLink to="/refused" className={navClass}>
          Refused changes<span className="ml-2 rounded-full bg-amber-400 text-black px-2 text-xs">{refused}</span>
        </NavLink>
      )}
      {count > 0 && (
        <NavLink to="/needs-merge" className={navClass}>
          Needs merge<span className="ml-2 rounded-full bg-amber-400 text-black px-2 text-xs">{count}</span>
        </NavLink>
      )}
    </nav>
  );
}
