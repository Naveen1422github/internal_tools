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
}

export interface Stats {
  total: number;
  by_category: Record<string, number>;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  top_modules: Array<{ module: string; count: number }>;
  recent: Entry[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
