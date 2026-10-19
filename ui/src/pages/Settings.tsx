import { useCallback, useEffect, useState } from 'react';
import { settingsAddress, settingsAutostart, settingsView, type SettingsView } from '../api/client';
import { buttonClass, primaryClass } from '../components/Dialog';
import { toast } from '../components/Toast';

// UI parity Task 11 (C): this laptop's settings. The same code as the CLI:
// core thisLaptop (`collab notebook which`), the courier's setPostOfficeAddress
// (`collab sync set-address`) and setAutostart (`collab sync autostart on|off`).

const card = 'border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-950 p-4 space-y-3';
const row = 'grid gap-1 sm:grid-cols-[12rem_1fr] text-sm';

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const load = useCallback(() => settingsView().then((v) => { setView(v); setFatal(null); }).catch((e) => setFatal((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const heading = <h1 className="text-2xl font-bold tracking-tight">Settings</h1>;
  if (fatal) return <div className="space-y-4">{heading}<p className="text-sm">{fatal}</p></div>;
  if (!view) return <div className="space-y-4">{heading}<p className="text-gray-500">Loading…</p></div>;

  return (
    <div className="space-y-6 max-w-3xl">
      {heading}
      <section className={card}>
        <h2 className="font-semibold">This laptop</h2>
        <div className={row}><span className="text-gray-500">Notebook</span><span>{view.notebook ? <>{view.notebook.described} <span className="break-all text-gray-500">({view.notebook.path})</span></> : '—'}</span></div>
        <div className={row}><span className="text-gray-500">Member name</span><span>{view.name ?? (view.name_error ?? (view.device_id ? 'Not known' : 'Not shared with a post office'))}</span></div>
        <div className={row}><span className="text-gray-500">Device id</span><span className="font-mono text-xs break-all">{view.device_id ?? 'None: this notebook has not joined a post office'}</span></div>
      </section>
      <AddressSection view={view} onSaved={load} />
      <AutostartSection view={view} onSaved={load} />
    </div>
  );
}

function AddressSection({ view, onSaved }: { view: SettingsView; onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view.post_office) {
    return (
      <section className={card}>
        <h2 className="font-semibold">Post office</h2>
        <p className="text-sm">This notebook isn't connected to a post office.</p>
      </section>
    );
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await settingsAddress(url.trim());
      toast(r.line);
      setUrl('');
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className={card}>
      <h2 className="font-semibold">Post office</h2>
      <div className={row}><span className="text-gray-500">Address</span><span className="break-all font-mono text-xs">{view.post_office.url}</span></div>
      <form onSubmit={save} className="space-y-2">
        <label className="block space-y-1 text-sm">
          <span>The post office moved? Its new address</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://192.168.1.40:7443" disabled={busy}
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm font-mono" />
        </label>
        <p className="text-xs text-gray-500">
          For when its laptop changed network. The new address is checked first: only your post office's certificate is accepted, otherwise nothing changes.
        </p>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={!url.trim() || busy} className={primaryClass}>{busy ? 'Checking…' : 'Check and save'}</button>
      </form>
    </section>
  );
}

function AutostartSection({ view, onSaved }: { view: SettingsView; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why = !view.courier_available ? "The sync program isn't installed with this web server."
    : view.autostart === null && view.courier_notebook && view.courier_notebook !== view.open_notebook
      ? `This laptop's sync runs for another notebook (${view.courier_notebook}). Change start-at-login from that notebook's web page.`
    : view.autostart === null ? "This laptop isn't set up for sync yet, so there is nothing to start at login." : null;
  const toggle = async () => {
    setBusy(true); setError(null);
    try {
      const r = await settingsAutostart(!view.autostart);
      toast(r.lines.join('\n'));
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className={card}>
      <h2 className="font-semibold">Sync</h2>
      <div className={row}>
        <span className="text-gray-500">Start sync at login</span>
        <span>{view.autostart === null ? '—' : view.autostart ? 'On' : 'Off'}</span>
      </div>
      <button type="button" onClick={toggle} disabled={!!why || busy} title={why ?? undefined} className={buttonClass}>
        {view.autostart ? 'Turn off' : 'Turn on'}
      </button>
      {why && <p className="text-xs text-gray-500">{why}</p>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
