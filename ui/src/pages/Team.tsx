import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { teamOffice, teamOverview, teamProject, type TeamOverview, type TeamRoster } from '../api/client';
import Members from '../team/Members';
import Roles from '../team/Roles';
import Matrix from '../team/Matrix';
import type { TeamTabProps } from '../team/view';

// RnR S3: team admin. The post office decides every change; this page asks and
// shows its answer. Members, roles and the viewer's keys are read fresh from the
// office on every load, never from the laptop's cache (S3-12).

const NOT_CONNECTED = "This notebook isn't connected to a post office. Team settings appear here once it is.";
const NO_SCOPE = "This notebook isn't a member of any team project.";
const OFFICE = 'office';

const TABS = [
  { id: 'members', label: 'Members', Tab: Members },
  { id: 'roles', label: 'Roles', Tab: Roles },
  { id: 'matrix', label: 'Who can do what', Tab: Matrix },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Connected = Extract<TeamOverview, { connected: true }>;
const errorOf = (e: unknown) => ({ status: (e as { status?: number })?.status, message: (e as Error)?.message ?? String(e) });
/** 501 (office too old) and 503 (office unreachable) replace the page body; other refusals go in the banner. */
const replacesBody = (status: number | undefined) => status === 501 || status === 503;

/** The scope choices: each team project by code, plus "office" when this device holds an office role. */
function choicesOf(o: Connected): string[] {
  return [...o.projects.map((p) => p.code), ...(o.office ? [OFFICE] : [])];
}

export default function Team() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('scope');
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  // Kept with the scope it belongs to, so a scope change never shows another scope's members.
  const [roster, setRoster] = useState<{ scope: string; data: TeamRoster } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('members');
  const [reloads, setReloads] = useState(0);

  const scope = overview?.connected ? (asked && choicesOf(overview).includes(asked) ? asked : choicesOf(overview)[0] ?? null) : null;

  useEffect(() => {
    let alive = true;
    setFatal(null);
    (async () => {
      const o = await teamOverview();
      if (!alive) return;
      setOverview(o);
      if (!o.connected) return;
      const choices = choicesOf(o);
      const chosen = asked && choices.includes(asked) ? asked : choices[0];
      if (!chosen) return;
      const project = o.projects.find((p) => p.code === chosen);
      const r = project ? await teamProject(project.ulid) : await teamOffice();
      if (alive) setRoster({ scope: chosen, data: r });
    })().catch((e) => { if (alive) { setRoster(null); setFatal(errorOf(e).message); } });
    return () => { alive = false; };
  }, [asked, reloads]);

  const choose = (next: string) => {
    setBanner(null);
    setRoster(null);
    setParams({ scope: next });
  };

  const act = async (change: () => Promise<unknown>) => {
    setBanner(null);
    try {
      await change();
    } catch (e) {
      const { status, message } = errorOf(e);
      if (replacesBody(status)) { setRoster(null); setFatal(message); } else setBanner(message);
      return false;
    }
    setReloads((n) => n + 1);
    return true;
  };

  const heading = <h1 className="text-2xl font-bold tracking-tight">Team</h1>;
  if (!overview) {
    return <div className="space-y-4">{heading}{fatal ? <p className="text-sm">{fatal}</p> : <p className="text-gray-500">Loading…</p>}</div>;
  }
  if (!overview.connected) return <div className="space-y-4">{heading}<p className="text-sm">{NOT_CONNECTED}</p></div>;
  if (!scope) return <div className="space-y-4">{heading}<p className="text-sm">{NO_SCOPE}</p></div>;

  const project = overview.projects.find((p) => p.code === scope) ?? null;
  const viewerKeys = project ? project.keys : overview.office?.keys ?? [];
  const tabProps: TeamTabProps | null = roster?.scope === scope
    ? { scope: project ? 'project' : 'office', project, me: overview.me.device_id, viewerKeys, roster: roster.data, act }
    : null;
  const Current = TABS.find((t) => t.id === tab)!.Tab;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {heading}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Team settings for</span>
          <select
            value={scope}
            onChange={(e) => choose(e.target.value)}
            className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm"
          >
            {overview.projects.map((p) => (
              <option key={p.ulid} value={p.code}>{p.name ? `${p.code} · ${p.name}` : p.code}</option>
            ))}
            {overview.office && <option value={OFFICE}>Office</option>}
          </select>
        </label>
      </div>

      {fatal ? <p className="text-sm">{fatal}</p> : (
        <>
          <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`team-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="team-tabpanel"
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm -mb-px border-b-2 ${
                  tab === t.id ? 'border-blue-600 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {banner && (
            <div role="alert" className="flex items-start justify-between gap-4 border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3 text-sm">
              <p>{banner}</p>
              <button type="button" onClick={() => setBanner(null)} className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:underline">
                Dismiss
              </button>
            </div>
          )}

          <div role="tabpanel" id="team-tabpanel" aria-labelledby={`team-tab-${tab}`}>
            {tabProps ? <Current {...tabProps} /> : <p className="text-gray-500">Loading…</p>}
          </div>
        </>
      )}
    </div>
  );
}
