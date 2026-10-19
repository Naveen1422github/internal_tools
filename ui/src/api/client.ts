// Thin typed wrappers over the backend REST API. One responsibility: HTTP.
// All paths are relative; Vite proxies /api in dev, same-origin in prod.

export interface Entry {
  id: number;
  /** "E", or a project's code (stage B1). Absent on older servers = E. */
  series?: string;
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
  refs?: EntryRef[];
  author?: string | null;
  needs_merge?: number;
  ulid?: string;
  /** 0005+: the note at superseded_by_ulid (J17). null = not superseded; absent = older file. */
  superseded_target?: LinkTarget | null;
  /** UI parity Task 10: the note's project (search results carry its ULID, a note read the project). */
  project_ulid?: string | null;
  project?: { code: string; name: string; mode: string; left: boolean } | null;
}

/** The note at the other end of a link, found by its ULID (J17; core's LinkTarget). */
export interface LinkTarget {
  ulid: string;
  id: number | null;
  title: string | null;
  deleted: boolean;
  present: boolean;   // false: the ULID names no note on this laptop
  series?: string;    // present only for a project note (SH); absent = E
}

export interface EntryRef {
  ref_type: string;
  ref_value: string;
  /** ref_type 'entry' on 0005+ files: the linked note. Absent/null = unresolved or older file. */
  target?: LinkTarget | null;
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
  /** A project's code, or "none" for notes in no project. */
  project?: string;
} = {}) => getJson<{ results: Entry[] }>(`/api/collab/search${qs(p)}`);

// A note number: an integer is an E note; "SH-12" names a project note (stage B1).
export const getEntry = (id: number | string) =>
  getJson<Entry>(`/api/collab/entry${qs({ id: String(id) })}`);

export const entryByUlid = (ulid: string) =>
  getJson<Entry>(`/api/collab/entry${qs({ ulid })}`);

/**
 * Create (no id) or edit a note. `project` (create only): a project code, or "none";
 * omitted, core decides (the module's binding). A refusal keeps its own sentence:
 * a 403 here is usually a role refusal, not a stale page (UI parity Task 9).
 */
export const upsertEntry = (body: Omit<Partial<Entry>, 'id' | 'project'> & { id?: number | string; project?: string }) =>
  sendJson<{ ok: boolean; id: number | null; series?: string; pending?: boolean; ulid?: string }>('POST', `/api/collab/entry/upsert`, body);
/** Where a new note would land, in core's words. */
export interface NoteDestination { project: { code: string; name: string; mode: string } | null; why: 'named' | 'bound' | 'folder' | 'none'; line: string }
export const noteDestination = (p: { module?: string; project?: string }) =>
  sendJson<NoteDestination>('GET', `/api/collab/note-destination${qs({ module: p.module, project: p.project })}`);

export const deleteEntry = (id: number | string) =>
  postJson<{ ok: boolean }>(`/api/collab/entry/delete`, { id });

export const supersede = (ids: Array<number | string>, by: number | string) =>
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
export const setupDoctor = () => getJson<SetupReport & { fixable?: string[] }>(`/api/doctor/setup`);
/** One of `collab doctor --fix`'s safe repairs; `text` is --fix's own line. */
export const doctorFix = (id: string) =>
  sendJson<{ ok: boolean; text: string; report: SetupReport & { fixable?: string[] } }>('POST', '/api/doctor/fix', { id });
/** `collab notebook list` and `which`, read-only. */
export interface NotebooksView {
  open: { name: string | null; path: string; described: string };
  notebooks: Array<{ name: string; path: string; default: boolean; open: boolean; missing: boolean }>;
  error?: string;
}
export const notebooksList = () => sendJson<NotebooksView>('GET', '/api/notebooks');

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
export interface NeedsMergeRow { id: number; series?: string; title: string; module: string | null; type: string; updated_at: string }
export type MergeChoice = 'keep-current' | { title: string; summary: string; description: string | null };
export const VERSIONS_CHANGED = 'versions-changed';

export const syncStatus = () => getJson<SyncOverview>('/api/sync/status');
export const needsMerge = () => getJson<{ results: NeedsMergeRow[] }>('/api/sync/needs-merge');
export const mergeVersions = (id: number | string) => getJson<MergeView>(`/api/sync/versions${qs({ id: String(id) })}`);
export const resolveMerge = (id: number | string, expectedHeads: string[], choice: MergeChoice) =>
  postJson<{ ok: true; id: number }>('/api/sync/resolve', { id, expectedHeads, choice });
export const explainMerge = (id: number | string) => postJson<{ text: string }>('/api/sync/explain', { id });

// --- Team admin and refused changes (RnR S3) ---
// These calls carry the post office's (or core's) own sentence on failure, so
// they don't use getJson/postJson, which turn every 403 into "reload". Only the
// web guard's own 403 `{ error: 'forbidden' }` means reload (Review Focus 4).
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function sendJson<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, method === 'GET'
    ? { headers: keyHeader() }
    : { method, headers: { 'Content-Type': 'application/json', ...keyHeader() }, body: JSON.stringify(body ?? {}) });
  if (res.ok) return res.json() as Promise<T>;
  let error: unknown;
  try { error = (await res.json())?.error; } catch { /* not JSON */ }
  if (res.status === 403 && error === 'forbidden') throw new ApiError(RELOAD_MESSAGE, 403);
  throw new ApiError(typeof error === 'string' && error ? error : `Something went wrong (HTTP ${res.status}). Try again.`, res.status);
}

export type TeamScope = 'project' | 'office';
export interface TeamProjectAccess { ulid: string; code: string; name: string | null; role: string; keys: string[] }
export type TeamOverview =
  | { connected: false }
  | {
      connected: true;
      me: { device_id: string };
      /** null: this device holds no office role. */
      office: { role: string; keys: string[] } | null;
      projects: TeamProjectAccess[];
    };
export interface TeamMember { device_id: string; name: string | null; role: string; role_ulid: string; last_seen_at: string | null }
export interface TeamRole {
  ulid: string;
  name: string;
  keys: string[];
  is_starter: boolean;
  /** "all": name and keys are fixed (Owner, Office admin); "name": only the name (Office member). */
  locked: 'all' | 'name' | null;
  /**
   * Every device the office has on this role, removed and not-yet-joined ones
   * included: the count its delete rule uses (S3-3). Absent from an older office.
   */
  holders?: number;
}
export interface TeamRoster { members: TeamMember[]; roles: TeamRole[] }
/** `project` is the project's ULID; required for the project scope. */
type InScope = { scope: TeamScope; project?: string };

export const teamOverview = () => sendJson<TeamOverview>('GET', '/api/team/overview');
export const teamProject = (ulid: string) => sendJson<TeamRoster>('GET', `/api/team/project${qs({ ulid })}`);
export const teamOffice = () => sendJson<TeamRoster>('GET', '/api/team/office');
/** `role` is the role's name. */
export const teamSetMember = (b: InScope & { device: string; role: string }) =>
  sendJson<{ ok: true }>('POST', '/api/team/member/set', b);
/** Project scope only: revoking a device from the office stays on the CLI (S3-7). */
export const teamRemoveMember = (b: { project: string; device: string }) =>
  sendJson<{ ok: true }>('POST', '/api/team/member/remove', b);
/** UI parity D2: `collab team invite` on the web. The join code is shown once: never store it. */
export interface TeamInvite { device_id: string; name: string; join_code: string; expires_at?: string }
export const teamInvite = (name: string) => sendJson<TeamInvite>('POST', '/api/team/invite', { name });
/** UI parity D4: `collab team revoke` on the web. */
export const teamRevoke = (device: string) => sendJson<{ ok: true }>('POST', '/api/team/revoke', { device });
export const teamCreateRole = (b: InScope & { name: string; keys: string[] }) =>
  sendJson<{ role: { ulid: string; name: string; keys: string[] } }>('POST', '/api/team/role/create', b);
/** `role` is the role's ULID. */
export const teamUpdateRole = (b: InScope & { role: string; name?: string; keys?: string[] }) =>
  sendJson<{ ok: true }>('POST', '/api/team/role/update', b);
/** `role` is the role's ULID. */
export const teamDeleteRole = (b: InScope & { role: string }) =>
  sendJson<{ ok: true }>('POST', '/api/team/role/delete', b);

export interface RefusedRow {
  id: string;
  at: string;
  project_code: string;
  kind: 'new' | 'edit';
  key: string | null;
  reason: string;
  note: string;
}
export interface RefusedList { results: RefusedRow[]; solo_projects: Array<{ code: string; name: string }> }
export const refusedList = () => sendJson<RefusedList>('GET', '/api/refused');
/** `to` is a solo project's code; answers the new note's ref, e.g. "MY-4". */
export const refusedCopy = (id: string, to: string) => sendJson<{ ref: string }>('POST', '/api/refused/copy', { id, to });
export const refusedDelete = (id: string) => sendJson<{ ok: true }>('POST', '/api/refused/delete', { id });

// --- Projects (UI parity): the same core operations as `collab project ...` ---
export interface Project {
  ulid: string; name: string; code: string; mode: 'solo' | 'team'; team: string | null; created_at: string;
  /** A team project this laptop left: read-only. */
  left_at: string | null;
}
export interface ProjectRow extends Project {
  notes: number;
  /** Notes waiting for a number from the post office. */
  pending: number;
  /** Modules bound to this project on this laptop. */
  modules: string[];
  /** Solo only: the highest number ever used, so a promote continues after it. */
  highest?: number;
}
export interface ProjectList {
  projects: ProjectRow[];
  /** Modules with a modules row: the ones a project can be bound to. */
  modules: string[];
  /** Modules with notes in no project: the ones `collab copy --from <module>` copies. */
  copy_modules: string[];
  office_url: string | null;
  /** Who "only my notes" means on this laptop, or null when unknown. */
  me: string | null;
}
export const projectsList = () => sendJson<ProjectList>('GET', '/api/projects');
export const projectCreate = (b: { name: string; code: string; team: boolean }) =>
  sendJson<{ project: Project; lines: string[] }>('POST', '/api/projects/create', b);
export const projectPromote = (code: string) =>
  sendJson<{ project: Project; next?: string; already?: true }>('POST', '/api/projects/promote', { code });
export const projectRename = (code: string, name: string) => sendJson<{ project: Project }>('POST', '/api/projects/rename', { code, name });
export const projectBind = (module: string, code: string) => sendJson<{ line: string }>('POST', '/api/projects/bind', { module, code });
export const projectUnbind = (module: string) => sendJson<{ line: string }>('POST', '/api/projects/unbind', { module });
/** `collab copy` on the web: list what would be copied, then copy exactly that list. */
export interface CopyArgs { from: string; to: string; author?: string; since?: string }
export interface CopyPlanItem { ulid: string; ref: string; type: string; title: string; author: string | null; created_at: string }
export interface CopyPlanView {
  source: { kind: 'module' | 'project'; name: string; label: string };
  target: { ulid: string; code: string; name: string; mode: 'solo' | 'team' };
  items: CopyPlanItem[];
  skipped: Array<{ ulid: string; ref: string; title: string; reason: string }>;
  /** core's copyPlanLines: what `collab copy` prints before asking. */
  lines: string[];
}
export const copyPlan = (a: CopyArgs) => sendJson<CopyPlanView>('POST', '/api/projects/copy/plan', a);
/** `expect` and `target`: the list and project the person saw; if either changed, nothing is copied (409). */
export const copyApply = (a: CopyArgs, expect: string[], target: string) =>
  sendJson<{ copied: Array<{ from: string; to: string; pending: boolean }>; lines: string[] }>('POST', '/api/projects/copy/apply', { ...a, expect, target });

/** `collab sync share|unshare <module>`: answers the office's list of shared modules. */
export const moduleShare = (slug: string, shared: boolean) => sendJson<{ shared: string[] }>('POST', '/api/sync/share', { slug, shared });
