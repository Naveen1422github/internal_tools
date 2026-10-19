import { useEffect, useRef, useState } from 'react';
import { modules, noteDestination, projectsList, upsertEntry, type NoteDestination, type ProjectRow } from '../api/client';
import { useUi } from '../store/ui';
import { formatEntryRef } from '../format';
import Dialog from './Dialog';
import { toast } from './Toast';
import { draftErrors, TYPES } from './DraftCard';

// UI parity Task 9 (A): write a note yourself. The same save as the AI's draft
// card (POST /api/collab/entry/upsert -> core addEntryAsync), with a project
// picker that says, in core's words, where the note will land before saving.

const AUTO = '';
const NONE = 'none';
const field = 'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm';

export default function NewNote() {
  const { setNewNoteOpen, openDrawer } = useUi();
  const close = () => setNewNoteOpen(false);
  const [type, setType] = useState('decision');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [module, setModule] = useState('');
  const [project, setProject] = useState(AUTO);
  const [moduleList, setModuleList] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [dest, setDest] = useState<NoteDestination | null>(null);
  const [destError, setDestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    modules().then((r) => setModuleList(r.results.map((m: { slug: string }) => m.slug))).catch(() => {});
    projectsList().then((r) => setProjects(r.projects.filter((p) => !p.left_at))).catch(() => {});
  }, []);

  // Where it lands: asked again whenever the module or the project changes; only the newest answer counts.
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    noteDestination({ module: module || undefined, project: project || undefined })
      .then((d) => { if (n === asked.current) { setDest(d); setDestError(null); } })
      .catch((e) => { if (n === asked.current) { setDest(null); setDestError((e as Error).message); } });
  }, [module, project]);

  const errors = draftErrors({ type, title, summary });
  const save = async () => {
    setTouched(true);
    if (errors.length) return;
    setBusy(true); setError(null);
    try {
      const r = await upsertEntry({
        type, title: title.trim(), summary: summary.trim(), description: description.trim() || undefined,
        module: module || undefined, ...(project ? { project } : {}),
      });
      close();
      if (r.pending) {
        toast('Saved. It waits for its number from the post office, and is sent once it has one.');
        if (r.ulid) openDrawer({ ulid: r.ulid });
      } else {
        toast(`Saved as ${formatEntryRef(r.id, r.series)}.`);
        openDrawer(r.series && r.series !== 'E' ? `${r.series}-${r.id}` : r.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="New note" confirmLabel="Save note" busy={busy} error={error ?? (touched && errors.length ? errors.join('; ') : null)} onConfirm={save} onCancel={close}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Module</span>
          <select value={module} onChange={(e) => setModule(e.target.value)} className={field}>
            <option value="">No module</option>
            {moduleList.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>
      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span>Summary</span>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} className={`${field} resize-none`} aria-describedby="new-note-count" />
        </label>
        <p id="new-note-count" className={`text-right text-xs ${summary.length > 200 ? 'font-bold text-red-600' : 'text-gray-500'}`}>{summary.length}/200 (one line; the detail goes in the description)</p>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Description (optional, Markdown)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className={`${field} font-mono`} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Project</span>
        <select value={project} onChange={(e) => setProject(e.target.value)} className={field}>
          <option value={AUTO}>Automatic (from the module)</option>
          {projects.map((p) => <option key={p.ulid} value={p.code}>{p.code} · {p.name}</option>)}
          <option value={NONE}>No project (E series)</option>
        </select>
      </label>
      <p role="status" className="text-xs text-gray-600 dark:text-gray-400">
        {destError ?? dest?.line ?? 'Working out where it goes…'}
      </p>
    </Dialog>
  );
}
