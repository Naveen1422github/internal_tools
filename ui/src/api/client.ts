// Thin typed wrappers over the backend REST API. One responsibility: HTTP.
// All paths are relative; Vite proxies /api in dev, same-origin in prod.

export interface Entry {
  id: number;
  type: string;
  kind?: string;
  category?: 'Index' | 'Reference' | 'Activity';
  title: string;
  summary: string;
  description?: string;
  status?: string;
  agent?: string;
  module?: string;
  task_id?: string;
  superseded_by?: number | null;
  deprecated?: number;
  created_at?: string;
  modules?: string[];
  refs?: Array<{ ref_type: string; ref_value: string }>;
  author?: string | null;
  needs_merge?: number;
}

export interface Stats {
  total: number;
  by_category: Record<string, number>;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  top_modules: Array<{ module: string; count: number }>;
  recent: Entry[];
}

// The server only answers requests that carry its access key, which it puts
// into index.html as <meta name="collab-key">. Read once, sent on every call.
export const RELOAD_MESSAGE = "collab refused this request. The server was probably restarted: reload the page.";
let cachedKey: string | null | undefined;
export function collabKey(): string | null {
  if (cachedKey === undefined) {
    const doc = (globalThis as any).document as Document | undefined;
    cachedKey = doc?.querySelector('meta[name="collab-key"]')?.getAttribute('content') || null;
  }
  return cachedKey;
}
export function resetCollabKeyForTests(): void { cachedKey = undefined; }
function keyHeader(): Record<string, string> {
  const k = collabKey();
  return k ? { 'X-Collab-Key': k } : {};
}
export function keyMissingMessage(key: string | null, isDev: boolean): string | null {
  if (key || isDev) return null; // dev: the vite proxy adds the key
  return "This page can't talk to collab. Restart the collab web server and reload.";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: keyHeader() });
  if (res.status === 403) throw new Error(RELOAD_MESSAGE);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...keyHeader() },
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw new Error(RELOAD_MESSAGE);
  if (!res.ok) {
    let msg = `POST ${url} -> ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// --- Entries ---
export const search = (p: {
  q?: string; type?: string; module?: string; agent?: string;
  kind?: string; category?: string; since?: string;
} = {}) => getJson<{ results: Entry[] }>(`/api/collab/search${qs(p)}`);

export const getEntry = (id: number) =>
  getJson<Entry>(`/api/collab/entry${qs({ id: String(id) })}`);

export const upsertEntry = (body: Partial<Entry>) =>
  postJson<{ ok: boolean; id: number }>(`/api/collab/entry/upsert`, body);

export const deleteEntry = (id: number) =>
  postJson<{ ok: boolean }>(`/api/collab/entry/delete`, { id });

export const supersede = (ids: number[], by: number) =>
  postJson<{ ok: boolean; superseded: number[]; by: number }>(
    `/api/collab/entry/supersede`, { ids, by });

export const reassignModule = (ids: number[], module: string) =>
  postJson<{ ok: boolean; updated: number; module: string }>(
    `/api/collab/entry/reassign-module`, { ids, module });

// --- Stats / Health ---
export const stats = () => getJson<Stats>(`/api/collab/stats`);
export const doctor = () =>
  postJson<{ ok: boolean; checks: Array<{ name: string; severity: string; detail: string; items?: unknown[] }> }>(
    `/api/collab/doctor`, {});

// --- Setup doctor (same report as `collab doctor --json`) ---
export type SetupGroup = 'install' | 'notebook' | 'version' | 'programs' | 'sync' | 'claude' | 'notes';
export type SetupMark = 'ok' | 'warn' | 'error' | 'skipped';
export interface SetupCheck { group: SetupGroup; id: string; mark: SetupMark; text: string; fix?: string }
export interface SetupReport {
  checks: SetupCheck[];
  errors: number;
  warnings: number;
  exitCode: 0 | 1 | 2;
  notebook: { name: string | null; path: string; source: string; described: string } | null;
}
export const setupDoctor = () => getJson<SetupReport>(`/api/doctor/setup`);

// --- Tasks ---
export const tasks = () => getJson<{ results: any[] }>(`/api/collab/tasks`);

// --- Modules ---
export const modules = () => getJson<{ results: any[] }>(`/api/collab/modules`);
export const moduleCard = (slug: string) =>
  getJson<any>(`/api/collab/module-card${qs({ slug })}`);

// --- AI assistant ---
export interface AiSearchTrail { query: string; filters: Record<string, unknown>; resultCount: number; }
export interface AiAnswer { answer: string; searches: AiSearchTrail[]; }
export interface AiDraft {
  draft: Partial<Entry>;
  validation: { ok: boolean; errors: string[] };
  searches: AiSearchTrail[];
}
export type AiResponse = AiAnswer | AiDraft;
export type ChatRole = 'user' | 'assistant';

export const aiChat = (messages: Array<{ role: ChatRole; content: string }>) =>
  postJson<AiResponse>(`/api/ai/chat`, { messages });

export function isDraft(r: AiResponse): r is AiDraft {
  return 'draft' in r;
}

// --- Sync (web UI part 2) ---
export type SyncOverview =
  | { enabled: false }
  | {
      enabled: true; postOffice: string; deviceId: string; sharedModules: string[]; unsent: number;
      courier: { running: boolean; state: string; lastError: string | null; lastPushAt: string | null; lastPullAt: string | null };
      lastContactAt: string | null;
      health: 'ok' | 'behind' | 'not-syncing' | 'needs-update' | 'revoked' | 'unknown';
    };
export interface MergeVersion { rev_id: string; title: string; summary: string; description: string | null; author: string | null; created_at: string }
export interface MergeView { id: number; current: { title: string; summary: string; description: string | null }; heads: MergeVersion[] }
export interface NeedsMergeRow { id: number; title: string; module: string | null; type: string; updated_at: string }
export type MergeChoice = 'keep-current' | { title: string; summary: string; description: string | null };
export const VERSIONS_CHANGED = 'versions-changed';

export const syncStatus = () => getJson<SyncOverview>('/api/sync/status');
export const needsMerge = () => getJson<{ results: NeedsMergeRow[] }>('/api/sync/needs-merge');
export const mergeVersions = (id: number) => getJson<MergeView>(`/api/sync/versions${qs({ id: String(id) })}`);
export const resolveMerge = (id: number, expectedHeads: string[], choice: MergeChoice) =>
  postJson<{ ok: true; id: number }>('/api/sync/resolve', { id, expectedHeads, choice });
export const explainMerge = (id: number) => postJson<{ text: string }>('/api/sync/explain', { id });
