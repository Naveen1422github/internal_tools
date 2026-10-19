import { useCallback, useEffect, useRef, useState } from 'react';
import {
  copyApply, copyPlan, type CopyArgs, type CopyPlanView,
  projectBind, projectCreate, projectPromote, projectRename, projectUnbind, projectsList, teamOverview,
  type ProjectList, type ProjectRow, type TeamOverview,
} from '../api/client';
import Dialog, { buttonClass, primaryClass } from '../components/Dialog';
import { toast } from '../components/Toast';
import { needSentence } from '../team/view';

// UI parity: the Projects page. Every action is the same core operation as
// `collab project ...`. Solo projects work fully offline; team actions need
// the post office, which checks every one of them. Controls this laptop can't
// use are greyed out with the reason (D6); the office still decides.

const NOT_CONNECTED = "This notebook isn't connected to a post office.";
const LEFT = 'This is a team you left: it is read-only.';

/** What the office said about this laptop, asked separately so the page never waits for it. */
type OfficeState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'down'; message: string }
  | { state: 'ok'; overview: Extract<TeamOverview, { connected: true }> };

type Open =
  | { kind: 'create' }
  | { kind: 'rename'; row: ProjectRow }
  | { kind: 'promote'; row: ProjectRow }
  | { kind: 'copy'; row: ProjectRow }
  | null;

const officeReason = (o: OfficeState): string | null =>
  o.state === 'loading' ? 'Checking the post office…' : o.state === 'none' ? NOT_CONNECTED : o.state === 'down' ? o.message : null;

/** Why this laptop can't create or promote a team project, or null. */
export function teamCreateReason(o: OfficeState): string | null {
  const r = officeReason(o);
  if (r || o.state !== 'ok') return r;
  return o.overview.office?.keys.includes('office.project.create') ? null : needSentence('office.project.create', 'this office');
}

/** Why this laptop can't rename the project, or null. Solo projects never need the office. */
export function renameReason(o: OfficeState, row: ProjectRow): string | null {
  if (row.mode === 'solo') return null;
  if (row.left_at) return LEFT;
  const r = officeReason(o);
  if (r || o.state !== 'ok') return r;
  const keys = o.overview.projects.find((p) => p.ulid === row.ulid)?.keys ?? [];
  return keys.includes('project.edit') ? null : needSentence('project.edit', row.code);
}

const modeLabel = (r: ProjectRow) => (r.left_at ? 'Team (left)' : r.mode === 'team' ? 'Team' : 'Solo');

export default function Projects() {
  const [list, setList] = useState<ProjectList | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [office, setOffice] = useState<OfficeState>({ state: 'loading' });
  const [open, setOpen] = useState<Open>(null);

  const load = useCallback(async () => {
    try { setList(await projectsList()); setFatal(null); } catch (e) {
      setFatal((e as Error).message);
      // With a list already on screen, say it may be out of date rather than replace it.
      if (listRef.current) toast((e as Error).message, 'error');
    }
  }, []);
  const listRef = useRef<ProjectList | null>(null);
  listRef.current = list;
  // Only the newest answer counts: two quick reloads can finish out of order.
  const officeAsk = useRef(0);
  const loadOffice = useCallback(async () => {
    const n = ++officeAsk.current;
    try {
      const o = await teamOverview();
      if (n === officeAsk.current) setOffice(o.connected ? { state: 'ok', overview: o } : { state: 'none' });
    } catch (e) {
      if (n === officeAsk.current) setOffice({ state: 'down', message: (e as Error).message });
    }
  }, []);
  useEffect(() => { load(); loadOffice(); }, [load, loadOffice]);

  const after = async (message: string) => {
    setOpen(null);
    toast(message);
    // A new team project brings new keys: read them before its row is judged against them.
    await loadOffice();
    await load();
  };

  const heading = <h1 className="text-2xl font-bold tracking-tight">Projects</h1>;
  if (fatal && !list) return <div className="space-y-4">{heading}<p className="text-sm">{fatal}</p></div>;
  if (!list) return <div className="space-y-4">{heading}<p className="text-gray-500">Loading…</p></div>;

  const teamWhy = teamCreateReason(office);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          {heading}
          <p className="text-sm text-gray-500">Each project numbers its own notes (SH-1, SH-2, …). Solo projects stay on this laptop; team projects are shared through the post office.</p>
        </div>
        <button type="button" onClick={() => setOpen({ kind: 'create' })} className={primaryClass}>New project</button>
      </div>

      {list.projects.length === 0 ? (
        <p className="text-sm">No projects yet. Create one with “New project”.</p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Project</th>
                <th className="px-3 py-2 font-semibold">Mode</th>
                <th className="px-3 py-2 font-semibold">Notes</th>
                <th className="px-3 py-2 font-semibold">Bound modules</th>
                <th className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {list.projects.map((r) => (
                <Row
                  key={r.ulid}
                  row={r}
                  modules={list.modules}
                  renameWhy={renameReason(office, r)}
                  promoteWhy={teamWhy}
                  onRename={() => setOpen({ kind: 'rename', row: r })}
                  onPromote={() => setOpen({ kind: 'promote', row: r })}
                  onCopy={() => setOpen({ kind: 'copy', row: r })}
                  onDone={after}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open?.kind === 'create' && <CreateDialog teamWhy={teamWhy} onCancel={() => setOpen(null)} onDone={after} />}
      {open?.kind === 'rename' && <RenameDialog row={open.row} onCancel={() => setOpen(null)} onDone={after} />}
      {open?.kind === 'copy' && (
        <CopyDialog row={open.row} projects={list.projects} modules={list.copy_modules} me={list.me} onCancel={() => setOpen(null)} onDone={after} />
      )}
      {open?.kind === 'promote' && <PromoteDialog row={open.row} url={list.office_url} onCancel={() => setOpen(null)} onDone={after} />}
    </div>
  );
}

function Row({ row, modules, renameWhy, promoteWhy, onRename, onPromote, onCopy, onDone }: {
  row: ProjectRow; modules: string[]; renameWhy: string | null; promoteWhy: string | null;
  onRename: () => void; onPromote: () => void; onCopy: () => void; onDone: (message: string) => Promise<void>;
}) {
  const [module, setModule] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (change: () => Promise<{ line: string }>) => {
    setBusy(true); setError(null);
    try { const r = await change(); setModule(''); await onDone(r.line); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const bindable = modules.filter((m) => !row.modules.includes(m));
  const bindWhy = row.left_at ? LEFT : null;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <div className="font-mono text-xs text-gray-500">{row.code}</div>
        <div className="font-medium">{row.name}</div>
      </td>
      <td className="px-3 py-2">{modeLabel(row)}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {row.notes}
        {row.pending > 0 && <div className="text-xs text-amber-700 dark:text-amber-400">{row.pending} waiting for a number</div>}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {row.modules.length === 0 && <span className="text-gray-400">None</span>}
          {row.modules.map((m) => (
            <span key={m} className="inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs">
              {m}
              <button type="button" aria-label={`Unbind ${m} from ${row.code}`} disabled={busy} onClick={() => run(() => projectUnbind(m))}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-100">×</button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <select
            aria-label={`Bind a module to ${row.code}`}
            value={module}
            disabled={!!bindWhy || bindable.length === 0 || busy}
            title={bindWhy ?? undefined}
            onChange={(e) => setModule(e.target.value)}
            className="max-w-[12rem] rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs disabled:opacity-50"
          >
            <option value="">{bindable.length === 0 ? 'No module to bind' : 'Bind a module…'}</option>
            {bindable.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button type="button" disabled={!module || !!bindWhy || busy} onClick={() => run(() => projectBind(module, row.code))} className={buttonClass}>Bind</button>
        </div>
        {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-end gap-1">
          <button type="button" onClick={onRename} disabled={!!renameWhy} title={renameWhy ?? undefined} className={buttonClass}>Rename</button>
          <button type="button" onClick={onCopy} disabled={!!row.left_at} title={row.left_at ? LEFT : undefined} className={buttonClass}>Copy notes here</button>
          {row.mode === 'solo' && (
            <button type="button" onClick={onPromote} disabled={!!promoteWhy} title={promoteWhy ?? undefined} className={buttonClass}>Make team project</button>
          )}
          {(row.mode === 'solo' ? promoteWhy : renameWhy) && (
            <p className="max-w-[16rem] text-right text-xs text-gray-500">{row.mode === 'solo' ? promoteWhy : renameWhy}</p>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Runs one dialog action; a refusal stays in the dialog, word for word. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const field = 'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm';

function CreateDialog({ teamWhy, onCancel, onDone }: { teamWhy: string | null; onCancel: () => void; onDone: (m: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [team, setTeam] = useState(false);
  const a = useAction();
  return (
    <Dialog
      title="New project"
      confirmLabel="Create project"
      confirmDisabled={!name.trim() || !code.trim() || (team && !!teamWhy)}
      busy={a.busy}
      error={a.error}
      onCancel={onCancel}
      onConfirm={() => a.run(async () => { const r = await projectCreate({ name: name.trim(), code: code.trim(), team }); await onDone(r.lines[0]); })}
    >
      <label className="block space-y-1 text-sm">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={`${field} font-mono`} aria-describedby="project-code-help" />
        </label>
        <p id="project-code-help" className="text-xs text-gray-500">Its notes are numbered with it: {code.trim() || 'SH'}-1, {code.trim() || 'SH'}-2, … It never changes.</p>
      </div>
      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1">Mode</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="kind" checked={!team} onChange={() => setTeam(false)} className="mt-1" />
          <span><span className="font-medium">Solo</span><span className="block text-xs text-gray-500">Numbered on this laptop and never sent. Works offline.</span></span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="kind" checked={team} disabled={!!teamWhy} onChange={() => setTeam(true)} className="mt-1" />
          <span><span className="font-medium">Team</span><span className="block text-xs text-gray-500">Registered at the post office, which numbers its notes and shares them with the members you add. You become its Owner.</span></span>
        </label>
        {teamWhy && <p className="text-xs text-gray-500">{teamWhy}</p>}
      </fieldset>
    </Dialog>
  );
}

function RenameDialog({ row, onCancel, onDone }: { row: ProjectRow; onCancel: () => void; onDone: (m: string) => Promise<void> }) {
  const [name, setName] = useState(row.name);
  const a = useAction();
  return (
    <Dialog
      title={`Rename ${row.code}`}
      confirmLabel="Rename"
      confirmDisabled={!name.trim() || name.trim() === row.name}
      busy={a.busy}
      error={a.error}
      onCancel={onCancel}
      onConfirm={() => a.run(async () => { const r = await projectRename(row.code, name.trim()); await onDone(`Project ${r.project.code} is now named ${r.project.name}.`); })}
    >
      <label className="block space-y-1 text-sm">
        <span>New name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <p className="text-xs text-gray-500">
        The code {row.code} never changes.{row.mode === 'team' ? ' The post office renames it for every member.' : ''}
      </p>
    </Dialog>
  );
}

/** The D5 explanation of what promoting changes. */
export function promoteText(row: ProjectRow, url: string | null): string {
  const n = row.highest ?? 0;
  const after = n > 0 ? `new notes continue after ${row.code}-${n}` : `new notes start at ${row.code}-1`;
  return `Make ${row.code} a team project? Its notes keep their numbers; ${after} at the post office${url ? ` ${url}` : ''}. ` +
    'The courier sends all its notes to the office on its next sync. You become its Owner, and only members you add can see it. ' +
    "A team project can't be made solo again.";
}

function PromoteDialog({ row, url, onCancel, onDone }: { row: ProjectRow; url: string | null; onCancel: () => void; onDone: (m: string) => Promise<void> }) {
  const a = useAction();
  return (
    <Dialog
      title={`Make ${row.code} a team project`}
      confirmLabel="Make team project"
      busy={a.busy}
      error={a.error}
      onCancel={onCancel}
      onConfirm={() => a.run(async () => {
        const r = await projectPromote(row.code);
        await onDone(r.already
          ? `Project ${r.project.code} is already a team project of this notebook's post office.`
          : `Project ${r.project.code} is now a team project; the next note is ${r.next}.`);
      })}
    >
      <p className="text-sm">{promoteText(row, url)}</p>
    </Dialog>
  );
}

/**
 * `collab copy --from <module | project> --to <CODE>` (UI parity Task 7a): pick
 * the source, see exactly what would be copied (core's own list), then copy that
 * list. If the notes change in between, nothing is copied and the list is shown again.
 */
function CopyDialog({ row, projects, modules, me, onCancel, onDone }: {
  row: ProjectRow; projects: ProjectRow[]; modules: string[]; me: string | null; onCancel: () => void; onDone: (m: string) => Promise<void>;
}) {
  const sources = [
    ...modules.map((m) => ({ value: `module:${m}`, label: `Module ${m} (its notes with no project)` })),
    ...projects.filter((p) => p.ulid !== row.ulid).map((p) => ({ value: `project:${p.code}`, label: `Project ${p.code} · ${p.name}` })),
  ];
  const [from, setFrom] = useState('');
  const [mine, setMine] = useState(false);
  const [since, setSince] = useState('');
  const [plan, setPlan] = useState<CopyPlanView | null>(null);
  const a = useAction();
  const args = (): CopyArgs => ({ from, to: row.code, ...(mine ? { author: 'me' } : {}), ...(since ? { since } : {}) });
  // Any change to the choice means the list on screen is no longer the one to copy;
  // an answer to an older choice is dropped when it arrives.
  const asked = useRef(0);
  const change = (f: () => void) => { f(); asked.current++; setPlan(null); };

  const check = () => a.run(async () => {
    const n = ++asked.current;
    const p = await copyPlan(args());
    if (n === asked.current) setPlan(p);
  });
  const copy = () => a.run(async () => {
    try {
      const r = await copyApply(args(), plan!.items.map((i) => i.ulid), plan!.target.ulid);
      await onDone(r.lines.join('\n'));
    } catch (e) {
      // The list changed: show the new one, so the person can check it again.
      if ((e as { status?: number }).status === 409) setPlan(await copyPlan(args()));
      throw e;
    }
  });
  const n = plan?.items.length ?? 0;
  const field2 = 'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm';
  return (
    <Dialog
      title={`Copy notes into ${row.code}`}
      confirmLabel={plan ? (n === 0 ? 'Nothing to copy' : `Copy ${n === 1 ? '1 note' : `${n} notes`}`) : 'Show the notes'}
      confirmDisabled={!from || (!!plan && n === 0)}
      busy={a.busy}
      error={a.error}
      onCancel={onCancel}
      onConfirm={plan ? copy : check}
    >
      <label className="block space-y-1 text-sm">
        <span>Copy from</span>
        <select value={from} onChange={(e) => change(() => setFrom(e.target.value))} className={field2}>
          <option value="">Choose a module or project…</option>
          {sources.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={mine} onChange={(e) => change(() => setMine(e.target.checked))} />
        <span>Only my notes{me ? ` (by ${me})` : ''}</span>
      </label>
      <label className="block space-y-1 text-sm">
        <span>Only notes created on or after (optional)</span>
        <input type="date" value={since} onChange={(e) => change(() => setSince(e.target.value))} className={field2} />
      </label>
      {plan && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{plan.lines[0]}</p>
          {plan.items.length > 0 && (
            <ul aria-label="Notes to copy" className="max-h-56 overflow-y-auto rounded border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 text-sm">
              {plan.items.map((i) => (
                <li key={i.ulid} className="px-2 py-1">
                  <span className="font-mono text-xs text-gray-500">{i.ref}</span> {i.title}
                  <span className="text-xs text-gray-500"> · {i.type} · {i.author ?? 'unknown author'}</span>
                </li>
              ))}
            </ul>
          )}
          {plan.skipped.length > 0 && (
            <p className="text-xs text-gray-500">Skipped {plan.skipped.length}: {plan.skipped.map((x) => `${x.ref} (${x.reason})`).join(', ')}.</p>
          )}
          {plan.items.length > 0 && (
            <p className="text-xs text-gray-500">
              Each copy is a new note numbered by {plan.target.code}; the original is not changed, apart from a link to its copy.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
