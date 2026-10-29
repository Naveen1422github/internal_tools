// file: courier/src/engine.ts
import Database from "better-sqlite3";
import { createSocket, type Socket } from "node:dgram";
import {
  loadCrsqlite, isCrsqliteLoaded, isSyncEnabled, getSyncValue, setSyncValue, postOfficeTargetFromDb,
  readOwnChanges, decodeChange, applyChanges, reindexFts, requestJson, openEventStream, hasSeries, hasProjectLeft,
  sendContext, sendVerdictOf, eSendsBlocked, moduleSlugsOf, resolveAllocator, allocateWithRetry, formatEntryRef,
  upsertTeamProjectFromOffice, localClashOf, projectClashText, assignPendingNumber, rememberSharedModules,
  writeAccessCache, markProjectLeft, clearProjectLeft, recordRefusal, entryUlidOf,
  AccessRevokedError, SchemaMismatchError, PinMismatchError, COURIER_PORT_KEY,
  isEAdopted, cachedEAccess, adoptEFromOffice, E_PROJECT_ULID, SENT_MODULES_KEY,
  type PostOfficeTarget, type WireChange, type EventStream, type NotePlace, type ProjectClash, type AccessPayload,
} from "@collab-mcp/core";
import { COURIER_KEYS as K } from "./keys.js";

// The courier (spec Components 2, D4). One per machine, client-agnostic: it
// opens the notes DB itself. Push on write (each save pings us over local UDP,
// ~200 ms debounce; collab E-722), pull when the doorbell rings (SSE), retry every
// 30 s after a failure, no network while nothing changes. All network work runs one
// job at a time. Bookmarks make every step safe to repeat: the sent-bookmark
// moves only after the post office acknowledged; the receive-bookmark moves in
// the same transaction as the rows it covers.

/** needs-action: a person must act before pulling resumes (stage C: a team project clashes with a local one, P10). */
export type CourierState = "starting" | "connected" | "offline" | "needs-update" | "needs-action" | "revoked" | "stopped";

export interface CourierStatus {
  state: CourierState;
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  sentTotal: number;
  receivedTotal: number;
}

export interface CourierOptions {
  dbPath: string;
  /** After a failed push/pull (D4: 30 s). */
  retryMs?: number;
  /** After a file change, before pushing (~200 ms). */
  debounceMs?: number;
  /** Cap of the doorbell's reconnect back-off (30 s: "reconnects within 30 s"). */
  maxReconnectMs?: number;
  /** Changes per request. */
  batchSize?: number;
  /** Listen for save pings (off in unit tests that drive push/pull by hand). */
  watch?: boolean;
  /** Adopt E on this laptop once the office has (local-first Task 7). Off = an older laptop (tests). */
  autoAdoptE?: boolean;
  log?: (line: string) => void;
  onStatus?: (s: CourierStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;
const now = () => new Date().toISOString();
/** sync_state key of a replay's bookmark (R14); deleted once the office confirms the replay done. */
const replayKey = (projectUlid: string) => `replay:${projectUlid}`;
/** One office refusal (R5): a laptop transaction, named by hex site_id + db_version (ruling R-1). */
interface Refusal { site_id: string; db_version: number; ulid: string | null; key: string | null; reason: string }
/** A push not yet acknowledged (R-22): exactly what was sent, and what its acknowledgement moves. */
interface Outbox { top: number; shared: string; projects: string; pages: WireChange[][] }
const groupKey = (w: WireChange) => `${decodeChange(w).site_id.toString("hex")}:${w.db_version}`;
const changeKey = (w: WireChange) => `${w.site_id}|${w.db_version}|${w.seq}|${w.table}|${w.pk}|${w.cid}`;

/**
 * Requests of about `size` changes, in order, with two things never split:
 * one laptop transaction, (site_id, db_version), because the office judges
 * each one whole (R5); and every `entries` cell of one note, because the office
 * (R3) holds a note's rows until it has the note's project cell (a note cut
 * before it would look like a pre-0009 note with no project, and go to
 * everyone). A `modules` or `entry_modules` cell given a note by `noteOf` joins
 * that note's unit: the office accepts a new module's row only beside a note that
 * carries it (Task 9).
 * These rules join changes into units; a unit bigger than `size`
 * goes alone on its own page. Within a page, the batch order is kept.
 */
export function pagesOf(batch: WireChange[], noteOf: (w: WireChange) => string | null, size: number): WireChange[][] {
  const up = new Map<string, string>();
  const root = (k: string): string => {
    let r = k;
    while (up.has(r) && up.get(r) !== r) r = up.get(r)!;
    for (let x = k; x !== r;) { const n = up.get(x)!; up.set(x, r); x = n; }
    if (!up.has(r)) up.set(r, r);
    return r;
  };
  const group = (w: WireChange) => `g:${w.site_id}:${w.db_version}`;
  for (const w of batch) {
    // A modules row (and its carrier's tag cells) join the carrying note's unit (Task 9).
    const u = w.table === "entries" || w.table === "modules" || w.table === "entry_modules" ? noteOf(w) : null;
    const g = root(group(w));
    if (u !== null) { const n = root(`n:${u}`); if (n !== g) up.set(n, g); }
  }
  const unitSize = new Map<string, number>();
  const order: string[] = [];
  for (const w of batch) {
    const k = root(group(w));
    if (!unitSize.has(k)) order.push(k);
    unitSize.set(k, (unitSize.get(k) ?? 0) + 1);
  }
  const pageOfUnit = new Map<string, number>();
  let pages = 0, fill = 0;
  for (const k of order) {
    const n = unitSize.get(k)!;
    if (pages === 0 || (fill > 0 && fill + n > size)) { pages++; fill = 0; }
    pageOfUnit.set(k, pages - 1);
    fill += n;
  }
  const out: WireChange[][] = Array.from({ length: pages }, () => []);
  for (const w of batch) out[pageOfUnit.get(root(group(w)))!].push(w);
  return out;
}

export class Courier {
  readonly db: Database.Database;
  /** The address as of start; used only if the notes DB loses it (never expected). */
  private readonly startTarget: PostOfficeTarget;
  /**
   * Read fresh from the notes DB on every use (collab E-767): a laptop-hosted
   * post office changes address with its host's network, and a corrected
   * address must take effect on the next retry or reconnect, not after a
   * restart. Four tiny local reads per request.
   */
  get target(): PostOfficeTarget {
    return (this.db.open && postOfficeTargetFromDb(this.db)) || this.startTarget;
  }
  private readonly opt: Required<Omit<CourierOptions, "log" | "onStatus">> & Pick<CourierOptions, "log" | "onStatus">;
  private st: CourierStatus = { state: "starting", lastError: null, lastPushAt: null, lastPullAt: null, sentTotal: 0, receivedTotal: 0 };
  private stream: EventStream | null = null;
  private pingSock: Socket | null = null;
  /** The UDP port save pings arrive on (null = not listening). Read-only outside this class. */
  pingPort: number | null = null;
  private debounceTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private reconnectDelay = 1000;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  /** A pending note the office refuses to number (non-retriable), kept visible in lastError (rule 8). */
  private numberingProblem: string | null = null;
  private oldOfficeLogged = false;
  private noAccessLogged = false;
  /** The last auto-adopt refusal logged, so each distinct one is logged once. */
  private adoptRefusal: string | null = null;

  constructor(opts: CourierOptions) {
    this.opt = { retryMs: 30_000, debounceMs: 200, maxReconnectMs: 30_000, batchSize: 2000, watch: true, autoAdoptE: true, ...opts };
    this.db = new Database(opts.dbPath, { fileMustExist: true });
    try {
      this.db.pragma("journal_mode = WAL");
      loadCrsqlite(this.db); // this connection writes a shared DB: it must carry cr-sqlite
      if (!isSyncEnabled(this.db)) throw new Error(`${opts.dbPath} does not share notes yet: run \`collab sync setup <join code>\` first`);
      const t = postOfficeTargetFromDb(this.db);
      if (!t) throw new Error(`${opts.dbPath} has no post office configured: run \`collab sync setup <join code>\` first`);
      this.startTarget = t;
    } catch (e) {
      this.closeDb();
      throw e;
    }
  }

  get status(): CourierStatus {
    return { ...this.st };
  }

  /** Timers waiting to fire. 0 = idle and healthy (D4: idle = no work). */
  pendingTimers(): number {
    return [this.debounceTimer, this.retryTimer, this.reconnectTimer].filter((t) => t !== null).length;
  }

  /** Resolves when the work queued so far is done. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  start(): void {
    if (this.stopped) throw new Error("this courier was stopped; make a new one");
    if (this.opt.watch) this.listen();
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.closeListener();
    this.stream?.close();
    this.stream = null;
    await this.chain;
    this.closeDb();
    if (this.st.state !== "revoked") this.set({ state: "stopped" });
  }

  /** Number pending notes, then push (stage C: a note gets its number before it is ever sent). */
  pushNow(): Promise<void> {
    return this.enqueue(async () => {
      if (await this.numberPending() === "revoked") return;
      await this.push();
    });
  }
  pullNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.flushInflight(); // R-22: before any pull can apply a write-back over it
      if (this.clashes().length > 0) return this.holdForClash();
      await this.pull();
    });
  }
  /** Ask the office for the numbers of pending notes (stage C). Never throws. */
  numberPendingNow(): Promise<void> {
    return this.enqueue(async () => { await this.numberPending(); });
  }
  /**
   * Modules, team projects, access (+ replays), pull, number pending notes,
   * push: what a (re)connect does. A project clash pauses the pulls only (P10).
   */
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      // R-22: an unacknowledged push goes first, before a replay or pull applies
      // the office's write-back over its cells (the refused values would be lost).
      await this.flushInflight();
      await this.refreshModules();
      await this.refreshProjects();
      // Before pull (R14): a replay brings an old note's base cells first, so a
      // later edit to it never lands as a project-less E note. A removed project
      // is marked left before numbering and pushing (R15).
      await this.refreshAccess();
      if (this.clashes().length === 0) await this.pull();
      const numbering = await this.numberPending();
      if (numbering === "revoked") return;
      await this.push();
      // Adoption refused earlier for unsent changes: the push just sent them, so try again now.
      if (await this.maybeAdoptE()) await this.push();
      if (this.clashes().length > 0) this.holdForClash();
      else if (isEAdopted(this.db) && !cachedEAccess(this.db).adopted) {
        this.set({ state: "needs-update", lastError: "the post office has not adopted E; E changes are held locally until it does" });
      }
      else if (numbering === "ok") this.set({ state: "connected", lastError: this.notice() });
    });
  }

  // ------------------------------------------------------------ internals
  private set(patch: Partial<CourierStatus>): void {
    this.st = { ...this.st, ...patch };
    this.opt.onStatus?.(this.status);
  }
  private log(line: string): void {
    this.opt.log?.(line);
  }
  private clearTimers(): void {
    for (const t of [this.debounceTimer, this.retryTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.debounceTimer = this.retryTimer = this.reconnectTimer = null;
  }
  private closeDb(): void {
    if (!this.db?.open) return;
    if (isCrsqliteLoaded(this.db)) {
      try { this.db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
    }
    this.db.close();
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.stopped || this.st.state === "revoked") return;
      try {
        await job();
      } catch (e) {
        this.failed(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.chain = next;
    return next;
  }

  private failed(e: Error): void {
    if (e instanceof AccessRevokedError) return this.revoked(e);
    if (e instanceof SchemaMismatchError) {
      // Paused, not offline: only updating this laptop (or the office) fixes it.
      // Check again at the normal retry interval, never faster.
      this.log(`paused: ${e.message}`);
      this.set({ state: "needs-update", lastError: e.message });
      if (!this.retryTimer && !this.stopped) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.syncNow(); }, this.opt.retryMs);
      }
      return;
    }
    this.log(`sync failed, retrying in ${Math.round(this.opt.retryMs / 1000)} s: ${e.message}`);
    this.set({ state: "offline", lastError: e.message });
    if (!this.retryTimer && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.syncNow();
      }, this.opt.retryMs);
    }
  }

  /** Failure table: "The courier shows 'access revoked' and stops retrying." */
  private revoked(e?: Error): void {
    this.clearTimers();
    this.stream?.close();
    this.stream = null;
    this.closeListener();
    this.set({ state: "revoked", lastError: e?.message ?? "access revoked: the post office refused this machine's key; ask its owner for a new join code" });
    this.log("access revoked: the post office refused this machine's key. Stopped (no retries). Ask its owner for a new join code.");
  }

  private backfilledModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.backfilled) ?? "[]") as string[]); } catch { return new Set(); }
  }
  private backfilledProjects(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.backfilledProjects) ?? "[]") as string[]); } catch { return new Set(); }
  }
  private clashes(): ProjectClash[] {
    try { return JSON.parse(getSyncValue(this.db, K.projectClash) ?? "[]") as ProjectClash[]; } catch { return []; }
  }
  /** What lastError should keep showing after a successful step (rule 8): a clash, or a note the office won't number; and refusals (R6). */
  private notice(): string | null {
    const c = this.clashes();
    const main = c.length > 0 ? projectClashText(c) : this.numberingProblem;
    const n = this.refusedCount();
    if (n === 0) return main;
    const line = `${n} change(s) refused by the post office: collab refused list`;
    return main ? `${main}; ${line}` : line;
  }
  /** Rows in the local refused_changes (0013); 0 before that migration. */
  private refusedCount(): number {
    if (!this.hasRefusedTable()) return 0;
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM refused_changes`).get() as { n: number }).n;
  }
  private hasRefusedTable(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'refused_changes'`).get();
  }
  /** The project a note is in here (null: none, or before 0009). */
  private projectOf(ulid: string): string | null {
    if (!hasSeries(this.db)) return null;
    return (this.db.prepare(`SELECT project_ulid FROM entries WHERE ulid = ?`).get(ulid) as { project_ulid: string | null } | undefined)?.project_ulid ?? null;
  }

  /**
   * A team project clashes with a local one (P10): pulling stops, because the
   * office sends every delivery to every member and the two series would mix.
   * Pushing goes on. Checked again at the normal retry interval.
   */
  private holdForClash(): void {
    const text = projectClashText(this.clashes());
    if (this.st.state !== "needs-action" || this.st.lastError !== text) {
      this.log(`pulling paused: ${text}`);
      this.set({ state: "needs-action", lastError: text });
    }
    if (!this.retryTimer && !this.stopped) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.syncNow(); }, this.opt.retryMs);
    }
  }

  /**
   * The office's team projects (spec P1): create or refresh them locally; a
   * code or name already used by a local project is a clash, recorded and
   * never overwritten (P10). An older office without the list (404) has none.
   */
  private async refreshProjects(): Promise<void> {
    if (!hasSeries(this.db)) return;
    const r = await requestJson(this.target, "GET", "/v1/projects");
    let list: Array<{ ulid: string; name: string; code: string }> = [];
    if (r.status === 404) {
      if (!this.oldOfficeLogged) this.log("this post office keeps no team projects (an older version): update it to use team projects");
      this.oldOfficeLogged = true;
    } else if (r.status !== 200 || !Array.isArray(r.body?.projects)) {
      throw new Error(`the post office did not list the team projects (${r.status})`);
    } else {
      list = r.body.projects;
    }
    const fingerprint = this.target.fingerprint;
    this.db.transaction(() => {
      const clashes: ProjectClash[] = [];
      for (const p of list) {
        if (p.code === "E" || p.ulid === E_PROJECT_ULID) continue; // E is never a local project (an older office could list it)
        if (upsertTeamProjectFromOffice(this.db, p, fingerprint) !== "clash") continue;
        const local = localClashOf(this.db, p);
        clashes.push({ code: p.code, office_ulid: p.ulid, local_ulid: local?.ulid ?? null, ...(local ? { local_code: local.code } : {}) });
      }
      const next = JSON.stringify(clashes);
      if (next !== (getSyncValue(this.db, K.projectClash) ?? "[]")) setSyncValue(this.db, K.projectClash, next);
    })();
  }

  /**
   * What this laptop may do, as the office says (R2): cached locally, never
   * synced. The office's membership decides (R15): a team project of this
   * office it doesn't list, or lists without note.view, is marked left (its
   * notes stay, read-only); a left one it lists with note.view is writable again. Then any replay the office owes us (R14).
   * An older office (404) keeps no roles: nothing changes.
   */
  private async refreshAccess(): Promise<void> {
    if (!hasSeries(this.db)) return;
    const fingerprint = this.target.fingerprint;
    // Only projects that were team projects here BEFORE asking: a project is
    // team locally only after the office registered it with us as Owner, but
    // one created by another program while the answer is on its way would be
    // missing from it, and must not be marked left.
    const known = new Set(this.teamProjectsOfOffice(fingerprint).map((x) => x.ulid));
    const r = await requestJson(this.target, "GET", "/v1/access");
    if (r.status === 404) {
      if (!this.noAccessLogged) this.log("this post office keeps no roles (an older version): update it to use roles");
      this.noAccessLogged = true;
      return;
    }
    const p = r.body as AccessPayload | null;
    // Never write a bad answer: an empty list would mark every project left.
    if (r.status !== 200 || !p || !Array.isArray(p.projects) || !Array.isArray(p.replays)) {
      throw new Error(`the post office did not say what this laptop may do (${r.status})`);
    }
    // R15: a project listed without note.view (its role lost it in an edit,
    // S3-5) receives nothing, so it is read-only like one this laptop is not in.
    const listed = new Set(p.projects.map((x) => x.ulid));
    const viewer = new Set(p.projects.filter((x) => Array.isArray(x.keys) && x.keys.includes("note.view")).map((x) => x.ulid));
    this.db.transaction(() => {
      writeAccessCache(this.db, p);
      if (!hasProjectLeft(this.db)) return;
      for (const x of this.teamProjectsOfOffice(fingerprint)) {
        if (!viewer.has(x.ulid) && !x.left_at && known.has(x.ulid)) {
          markProjectLeft(this.db, x.ulid);
          this.log(listed.has(x.ulid)
            ? `can no longer view team project ${x.code} (its role changed): its notes stay here, read-only`
            : `removed from team project ${x.code}: its notes stay here, read-only`);
        } else if (viewer.has(x.ulid) && x.left_at && clearProjectLeft(this.db, x.ulid, fingerprint)) {
          this.log(`added back to team project ${x.code}: it is writable again`);
        }
      }
    })();
    if (isEAdopted(this.db) && !cachedEAccess(this.db).adopted) {
      const msg = "the post office has not adopted E; E changes are held locally until it does";
      this.log(msg);
      this.set({ lastError: msg });
    }
    await this.maybeAdoptE();
    await this.runReplays(p.replays);
  }

  /**
   * Local-first Task 7: the office adopted E and this laptop hasn't. adoptELocal
   * refuses while changes are unsent (the before-adoption rule must finish its
   * work), so this is tried again after the push and on every later sync. A
   * refusal never fails the sync; each distinct one is logged once. True = adopted now.
   */
  private async maybeAdoptE(): Promise<boolean> {
    if (!this.opt.autoAdoptE || isEAdopted(this.db) || !cachedEAccess(this.db).adopted) return false;
    try {
      const r = await adoptEFromOffice(this.db, {}); // a member asks the office which E notes it holds; a failure is a refusal
      this.adoptRefusal = null;
      this.log(`adopted emp1st (E) as a shared project: ${r.member ? `modules bound to it: ${r.bound.join(", ") || "none"}` : "not a member of it, so none of its notes are sent"}; ` +
        `${r.neverSend} E note(s) stay on this laptop only; new notes with no project go to ${r.default}`);
      return true;
    } catch (e) {
      const msg = (e as Error).message.replace(/^\[collab\] /, "");
      const kind = msg.replace(/\d+/g, "N"); // "sync first: 3 change(s)" and "2 change(s)" are one refusal
      if (kind !== this.adoptRefusal) this.log(`not adopting emp1st (E) yet, will retry: ${msg}`);
      this.adoptRefusal = kind;
      return false;
    }
  }

  /** This notebook's team projects of the office `fingerprint`, left or not. */
  private teamProjectsOfOffice(fingerprint: string): Array<{ ulid: string; code: string; left_at: string | null }> {
    const left = hasProjectLeft(this.db) ? "left_at" : "NULL AS left_at";
    return this.db.prepare(`SELECT ulid, code, ${left} FROM projects WHERE mode = 'team' AND team = ?`).all(fingerprint) as
      Array<{ ulid: string; code: string; left_at: string | null }>;
  }

  /**
   * R14: a project's past changes, once, after this laptop was given note.view
   * (the receive-bookmark already passed them). Per project, from its own
   * bookmark; each page applies like a pull() page. Ends with the confirming
   * call (done), then the bookmark goes. A clash holds, the bookmark unmoved.
   */
  private async runReplays(list: AccessPayload["replays"]): Promise<void> {
    for (const { project_ulid: ulid } of list) {
      const key = replayKey(ulid);
      let after = Number(getSyncValue(this.db, key) ?? 0);
      for (;;) {
        const r = await requestJson(this.target, "GET", `/v1/replay?project=${encodeURIComponent(ulid)}&after=${after}&limit=${this.opt.batchSize}`);
        if (r.status === 404 || r.status === 403) {
          // Removed, or note.view taken away, since /v1/access answered: nothing is owed.
          this.log(`no history to fetch for team project ${ulid} (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
          this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
          break;
        }
        if (r.status !== 200) throw new Error(`the post office did not send a project's history (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
        if (r.body?.done === true) {
          this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
          break;
        }
        const last = Number(r.body?.last_seq);
        const changes = (r.body?.changes ?? []) as WireChange[];
        if (!Number.isInteger(last) || last <= after) break; // never spin; the next sync asks again
        if (await this.heldForUnknownProject(changes)) return;
        this.applyPage(changes, key, last);
        after = last;
      }
    }
  }

  /**
   * Number this laptop's pending notes (stage C, rule 4 / E-820): E notes, and
   * notes of this office's team projects. No "own notes only" filter is needed:
   * a pending note is never sent (send rule: hold), so a pending row only ever
   * exists on the laptop that wrote it. Retries use the SAME ulid, so a number
   * the office gave before an answer was lost comes back again (E-713).
   * Never throws: an unreachable office stops the loop and schedules the
   * normal retry; a note the office refuses to number is skipped and shown.
   * R7: a 403 (no note.create) is a refusal, kept with the note's cells, and the
   * note is never asked for again (refused notes are left out here).
   */
  private async numberPending(): Promise<"ok" | "failed" | "revoked"> {
    this.numberingProblem = null;
    const series = hasSeries(this.db);
    const notRefused = this.hasRefusedTable() ? " AND NOT EXISTS (SELECT 1 FROM refused_changes r WHERE r.note_ulid = e.ulid AND r.kind = 'new')" : "";
    const rows = (series
      ? this.db.prepare(
          `SELECT e.ulid, e.series FROM entries e LEFT JOIN projects p ON p.ulid = e.project_ulid
            WHERE e.id IS NULL AND e.deleted_at IS NULL${notRefused}
              AND (e.project_ulid IS NULL OR (p.mode = 'team' AND p.team = ?${hasProjectLeft(this.db) ? " AND p.left_at IS NULL" : ""}))
            ORDER BY e.ulid`, // a team this laptop left is never numbered again (stage B2, P11)
        ).all(this.target.fingerprint)
      : this.db.prepare(`SELECT ulid, 'E' AS series FROM entries e WHERE id IS NULL AND deleted_at IS NULL${notRefused} ORDER BY ulid`).all()
    ) as Array<{ ulid: string; series: string }>;
    if (rows.length === 0) return "ok";
    const allocator = resolveAllocator(this.db);
    if (!allocator) return "ok";
    let numbered = 0;
    for (const r of rows) {
      if (this.stopped) break;
      try {
        const id = await allocateWithRetry(allocator, r.ulid, r.series);
        assignPendingNumber(this.db, r.ulid, id);
        numbered++;
      } catch (e) {
        const c = (e as { cause?: unknown })?.cause;
        const cause = c instanceof Error ? c : e instanceof Error ? e : new Error(String(e));
        if (cause instanceof AccessRevokedError) { this.revoked(cause); return "revoked"; }
        const refusal = cause as { refused?: boolean; key?: string; reason?: string };
        if (refusal.refused === true && this.hasRefusedTable()) {
          this.recordNewRefusal(r.ulid, refusal.key ?? "note.create", refusal.reason ?? cause.message);
          continue;
        }
        if (cause instanceof SchemaMismatchError || cause instanceof PinMismatchError || (cause as { retriable?: boolean }).retriable !== false) {
          this.failed(cause); // offline (or paused) + the normal retry; push still runs
          return "failed";
        }
        const msg = `${formatEntryRef(null, r.series)} note ${r.ulid} could not be numbered: ${cause.message}`;
        this.log(msg);
        this.numberingProblem = msg;
        this.set({ lastError: msg });
      }
    }
    if (numbered > 0) this.log(`numbered ${numbered} pending note(s)`);
    return "ok";
  }

  /** R7: keep a note the office won't let us create, with its current cells (nothing typed is lost, R6). */
  private recordNewRefusal(ulid: string, key: string, reason: string): void {
    this.db.transaction(() => {
      const cells = readOwnChanges(this.db, 0).filter((w) => entryUlidOf(this.db, w.table, Buffer.from(w.pk, "base64")) === ulid);
      recordRefusal(this.db, { noteUlid: ulid, projectUlid: this.projectOf(ulid), kind: "new", key, reason, cells });
    })();
    this.log(`note ${ulid} was refused by the post office: ${reason} (collab refused list)`);
    this.set({ lastError: this.notice() }); // the refused count shows at once, not only after the next sync
  }

  private async refreshModules(): Promise<void> {
    if (isEAdopted(this.db)) return; // modules follow their project now: the office's list no longer decides anything here
    const r = await requestJson(this.target, "GET", "/v1/modules");
    if (r.status !== 200 || !Array.isArray(r.body?.shared)) throw new Error(`the post office did not list the shared modules (${r.status})`);
    rememberSharedModules(this.db, r.body.shared as string[]);
  }

  /**
   * Send this machine's OWN changes since the sent-bookmark that the send rule
   * (core send-filter.ts, shared with the status count) says to send: team
   * notes of this office, and E notes whose primary module is shared (D10).
   * Also: older notes of a module shared since the last push (backfill), and
   * the whole of a note just MOVED into a shared module.
   */
  private async push(): Promise<void> {
    await this.flushInflight();
    const since = Number(getSyncValue(this.db, K.sent) ?? 0);
    const ctx = sendContext(this.db);
    const shared = ctx.shared;
    const done = this.backfilledModules();
    const backfill = new Set([...shared].filter((m) => !done.has(m)));
    const doneProjects = this.backfilledProjects();
    // E adopted: E is a team project for the backfill too (its notes are project_ulid NULL, series 'E').
    const projectsNow = ctx.eAdopted ? new Set([...ctx.teamProjects, E_PROJECT_ULID]) : ctx.teamProjects;
    const projectBackfill = new Set([...projectsNow].filter((p) => !doneProjects.has(p)));
    const eNotes = projectBackfill.has(E_PROJECT_ULID) ? this.eNoteUlids() : new Set<string>();
    const memo = new Map<string, NotePlace>();
    const out = new Map<string, WireChange>();
    const noteOf = new Map<string, string>(); // changeKey -> note, entries cells only
    const moved = new Set<string>();
    let held = false;
    const sentNotes = new Set<string>(); // every note with a row sent in this push, whatever the table
    const tagCells: Array<[string, string]> = []; // entry_modules cells sent: [changeKey, note]
    const createdNow = new Set<string>();
    const numberedNow = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, verdict, place } = sendVerdictOf(this.db, w, ctx, memo);
      if (verdict === "hold" && place.project === null && eSendsBlocked(ctx)) held = true;
      if (verdict !== "send") continue; // hold = waiting (status only); the bookmark passes it unless E is blocked
      out.set(changeKey(w), w);
      if (ulid) sentNotes.add(ulid);
      if (w.table === "entries" && ulid) noteOf.set(changeKey(w), ulid);
      if (w.table === "entry_modules" && ulid) tagCells.push([changeKey(w), ulid]);
      if (w.table === "entries" && ulid) {
        if (w.cid === "created_at") createdNow.add(ulid);
        if (w.cid === "module") moved.add(ulid);
        if (w.cid === "id") numberedNow.add(ulid); // a pending note just got its number: send it whole
      }
    }
    for (const u of createdNow) { moved.delete(u); numberedNow.delete(u); } // a new note is already whole
    if (backfill.size > 0 || moved.size > 0 || numberedNow.size > 0 || projectBackfill.size > 0) {
      for (const w of readOwnChanges(this.db, 0)) {
        if (w.db_version > top) continue; // newer than this push: the next push takes it
        const { ulid, verdict, place } = sendVerdictOf(this.db, w, ctx, memo);
        if (verdict === "hold" && place.project === null && eSendsBlocked(ctx)) held = true;
        if (verdict !== "send") continue;
        // Module backfill is the E path only: notes with no project. Team notes
        // are backfilled per project (promoted, or learned after an early edit).
        if (
          (place.project === null && place.module && backfill.has(place.module)) ||
          (place.project !== null && projectBackfill.has(place.project)) ||
          (place.project === null && ulid !== null && eNotes.has(ulid)) || // never-send was skipped by the verdict
          (ulid && (moved.has(ulid) || numberedNow.has(ulid)))
        ) {
          if (w.table === "entries" && ulid) noteOf.set(changeKey(w), ulid);
          if (w.table === "entry_modules" && ulid) tagCells.push([changeKey(w), ulid]);
          if (ulid) sentNotes.add(ulid);
          out.set(changeKey(w), w);
        }
      }
    }
    if (ctx.eAdopted) {
      // E adopted: a modules row travels with the (non-never-send) notes sent in THIS push that reference it.
      for (const m of moduleSlugsOf(this.db, sentNotes)) ctx.sentModules.add(m);
      if (ctx.sentModules.size > 0) {
        // Task 9 ruling: the office accepts a new module's row only in the page that creates
        // a note in it, so each modules row shares a page unit with one such note (a note
        // created now first). R5 holds: a unit only grows, a transaction is never split.
        const carrier = new Map<string, string>();
        const order = [...createdNow].filter((u) => sentNotes.has(u)).concat([...sentNotes].filter((u) => !createdNow.has(u)));
        for (const u of order) for (const m of moduleSlugsOf(this.db, [u])) if (!carrier.has(m)) carrier.set(m, u);
        for (const w of readOwnChanges(this.db, 0)) {
          if (w.table !== "modules" || w.db_version > top) continue;
          const { verdict, place } = sendVerdictOf(this.db, w, ctx, memo);
          if (verdict !== "send") continue;
          out.set(changeKey(w), w);
          const u = place.module ? carrier.get(place.module) : undefined;
          if (u) noteOf.set(changeKey(w), u);
        }
        // A carrier's tag cells join it too: a tag-only change carries the row (fix round 2, M4).
        const carriers = new Set(carrier.values());
        for (const [k, u] of tagCells) if (carriers.has(u)) noteOf.set(k, u);
      }
    }
    const batch = [...out.values()];
    const sharedJson = JSON.stringify([...shared].sort());
    const projectsJson = JSON.stringify([...projectsNow].sort());
    // R5: pages never split a laptop transaction; the office judges each one whole.
    // Never advance the sent bookmark across a held E change. The office can
    // safely de-duplicate any other page resent while waiting for adoption.
    const box: Outbox = { top: held ? since : top, shared: sharedJson, projects: projectsJson, pages: pagesOf(batch, (w) => noteOf.get(changeKey(w)) ?? null, this.opt.batchSize) };
    // R-22: kept before the first POST, so a lost answer or a failed page is
    // resent exactly as sent, even after a pull wrote the office's value over it.
    if (batch.length > 0) setSyncValue(this.db, K.inflight, JSON.stringify(box));
    const refused = await this.sendPages(box.pages);
    // Only now is everything up to `top` acknowledged. A crash before this line
    // means a resend, which the post office de-duplicates (a refused group gets
    // the same refusal again).
    if (batch.length > 0 || top !== since || sharedJson !== getSyncValue(this.db, K.backfilled) || projectsJson !== (getSyncValue(this.db, K.backfilledProjects) ?? "[]")) {
      this.acknowledge(box, refused);
    }
    if (batch.length > 0) {
      this.set({ sentTotal: this.st.sentTotal + batch.length, lastPushAt: now(), lastError: this.notice() });
      this.log(`sent ${batch.length} change(s)`);
    }
  }

  /** Ulids of the E notes here (project_ulid NULL, series 'E'): the E backfill's notes. */
  private eNoteUlids(): Set<string> {
    if (!hasSeries(this.db)) return new Set();
    return new Set((this.db.prepare(`SELECT ulid FROM entries WHERE project_ulid IS NULL AND series = 'E'`).all() as Array<{ ulid: string }>).map((r) => r.ulid));
  }

  /** POST the pages in order; the office's refusals of all of them (R5). Throws on any non-200. */
  private async sendPages(pages: WireChange[][]): Promise<Refusal[]> {
    const refused: Refusal[] = [];
    for (const page of pages) {
      const r = await requestJson(this.target, "POST", "/v1/changes", { changes: page });
      if (r.status !== 200) throw new Error(`the post office refused the changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
      if (Array.isArray(r.body?.refused)) refused.push(...(r.body.refused as Refusal[]));
    }
    return refused;
  }

  /**
   * R6: the refusals, the sent-bookmark, the backfill lists and the outbox's
   * removal commit together, so a refusal is recorded exactly once.
   */
  private acknowledge(box: Outbox, refused: Refusal[]): void {
    this.db.transaction(() => {
      if (refused.length > 0) this.recordRefusals(box.pages.flat(), refused);
      this.rememberSentModules(box.pages.flat(), refused);
      const sent = Number(getSyncValue(this.db, K.sent) ?? 0);
      setSyncValue(this.db, K.sent, String(Math.max(sent, box.top)));
      setSyncValue(this.db, K.backfilled, box.shared);
      setSyncValue(this.db, K.backfilledProjects, box.projects);
      this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(K.inflight);
    })();
  }

  /**
   * Task 9 ruling: the slugs whose modules row the office just accepted (a refused
   * group is left out). The send filter reads them as "the office holds it": a later
   * change to that row is a module.edit, sent only with that office key.
   */
  private rememberSentModules(batch: WireChange[], refused: Refusal[]): void {
    const no = new Set(refused.map((r) => r.site_id.toLowerCase() + ":" + r.db_version));
    const slugs = new Set<string>();
    for (const w of batch) {
      if (w.table !== "modules" || no.has(groupKey(w))) continue;
      const c = this.db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(Buffer.from(w.pk, "base64")) as { cell: unknown } | undefined;
      if (c && c.cell != null) slugs.add(String(c.cell));
    }
    if (!slugs.size) return;
    let had: string[] = [];
    try { had = JSON.parse(getSyncValue(this.db, SENT_MODULES_KEY) ?? "[]") as string[]; } catch { /* rebuilt */ }
    const all = new Set([...had, ...slugs]);
    if (all.size !== had.length) setSyncValue(this.db, SENT_MODULES_KEY, JSON.stringify([...all].sort()));
  }

  /**
   * R-22: a push whose answer never came (lost, crashed, or a later page
   * failed) is resent push-only, exactly as kept, before anything is pulled.
   * The office answers a resent refused group with the same refusal.
   */
  private async flushInflight(): Promise<void> {
    const raw = getSyncValue(this.db, K.inflight);
    if (!raw) return;
    let box: Outbox;
    try { box = JSON.parse(raw) as Outbox; } catch {
      this.log("dropped an unreadable unsent push; the next push resends from the sent-bookmark");
      this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(K.inflight);
      return;
    }
    const refused = await this.sendPages(box.pages);
    this.acknowledge(box, refused);
    const n = box.pages.reduce((a, p) => a + p.length, 0);
    this.set({ sentTotal: this.st.sentTotal + n, lastPushAt: now(), lastError: this.notice() });
    this.log(`resent ${n} change(s) whose answer was lost`);
  }

  /**
   * Keep each refused group with the cells it carried (R6); the caller owns the
   * transaction. One row per note of the group (R-24: one transaction can touch
   * several notes, e.g. supersede, and each note is recovered or discarded on
   * its own; rule 5). Cells of no note go with the office's note. A note whose
   * creation (its created_at cell) is in a refused group is `new`, whatever the key
   * (R-30: the office marks it dead the same way; it stays local, no write-back,
   * R7); anything else is an `edit`, reverted by the write-back on pull.
   */
  private recordRefusals(batch: WireChange[], refused: Refusal[]): void {
    const groups = new Map<string, WireChange[]>();
    for (const w of batch) {
      const k = groupKey(w);
      const g = groups.get(k);
      if (g) g.push(w); else groups.set(k, [w]);
    }
    for (const f of refused) {
      const at = `${String(f.site_id).toLowerCase()}:${f.db_version}`;
      const office = typeof f.ulid === "string" ? f.ulid : null;
      const reason = String(f.reason ?? "refused by the post office");
      const group = groups.get(at);
      if (!group) this.log(`warning: the post office refused a change group (${at}) this push did not send; kept with no cells`);
      const byNote = new Map<string | null, WireChange[]>([[office, []]]);
      for (const w of group ?? []) {
        const u = entryUlidOf(this.db, w.table, Buffer.from(w.pk, "base64")) ?? office;
        const list = byNote.get(u);
        if (list) list.push(w); else byNote.set(u, [w]);
      }
      for (const [u, cells] of byNote) {
        if (cells.length === 0 && u === office && byNote.size > 1) continue; // the office's note has no cells of its own here
        const created = cells.some((w) => w.table === "entries" && w.cid === "created_at");
        recordRefusal(this.db, {
          noteUlid: u, projectUlid: u ? this.projectOf(u) : null,
          kind: created ? "new" : "edit", key: f.key ?? null, reason, cells,
        });
      }
    }
    this.log(`${refused.length} change group(s) refused by the post office (collab refused list)`);
  }

  /** Fetch deliveries after the receive-bookmark; apply + re-index (D15) + move the bookmark in ONE transaction. */
  private async pull(): Promise<void> {
    let after = Number(getSyncValue(this.db, K.recv) ?? 0);
    for (;;) {
      const r = await requestJson(this.target, "GET", `/v1/changes?after=${after}&limit=${this.opt.batchSize}`);
      if (r.status !== 200) throw new Error(`the post office did not send changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
      const last = Number(r.body?.last_seq);
      const changes = (r.body?.changes ?? []) as WireChange[];
      if (!Number.isInteger(last) || last <= after) break; // nothing new (and the office now knows we hold `after`)
      if (await this.heldForUnknownProject(changes)) return;
      this.applyPage(changes, K.recv, last);
      after = last;
    }
  }

  /**
   * A note of a team project this laptop doesn't know yet: learn the project
   * list BEFORE applying, so a clashing code never mixes two series here
   * (P10). True = a clash: hold, apply nothing, the bookmark stays put.
   */
  private async heldForUnknownProject(changes: WireChange[]): Promise<boolean> {
    if (!this.namesUnknownProject(changes)) return false;
    await this.refreshProjects();
    if (this.clashes().length === 0) return false;
    this.holdForClash();
    return true;
  }

  /** Apply + re-index (D15) + move `bookmark` to `last` in ONE transaction (pull and replay pages). */
  private applyPage(changes: WireChange[], bookmark: string, last: number): void {
    this.db.transaction(() => {
      if (changes.length > 0) {
        const applied = applyChanges(this.db, changes.map(decodeChange));
        reindexFts(this.db, applied.entryUlids);
      }
      setSyncValue(this.db, bookmark, String(last));
    })();
    if (changes.length > 0) {
      this.set({ receivedTotal: this.st.receivedTotal + changes.length, lastPullAt: now(), lastError: this.notice() });
      this.log(`received ${changes.length} change(s)`);
    }
  }

  /** True when a received change puts a note into a project this notebook doesn't have. */
  private namesUnknownProject(changes: WireChange[]): boolean {
    if (!hasSeries(this.db)) return false;
    const known = this.db.prepare(`SELECT 1 FROM projects WHERE ulid = ?`);
    return changes.some((c) => c.table === "entries" && c.cid === "project_ulid" && typeof c.val === "string" && !known.get(c.val));
  }

  /**
   * Push on write: every program that writes this DB pings us after its save
   * commits (core installSyncPing, collab E-722). Our own connection never
   * installs that hook, so applying pulled changes causes no ping (no echo).
   * Not fs.watch (misses writes on Windows, E-716), not polling.
   */
  private listen(): void {
    const sock = createSocket("udp4");
    this.pingSock = sock;
    sock.on("message", () => this.onPing());
    sock.on("error", (e) => this.log(`save-ping listener failed: ${e.message}`));
    sock.bind(0, "127.0.0.1", () => {
      if (this.stopped || this.pingSock !== sock) return; // stopped or revoked while binding
      this.pingPort = sock.address().port;
      try { setSyncValue(this.db, COURIER_PORT_KEY, String(this.pingPort)); }
      catch (e) { this.log(`could not publish the ping port: ${(e as Error).message}`); }
      void this.pushNow(); // saves made while we were down or starting
    });
  }

  private onPing(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.pushNow();
    }, this.opt.debounceMs);
  }

  private closeListener(): void {
    if (!this.pingSock) return;
    try { this.pingSock.close(); } catch { /* already closed */ }
    this.pingSock = null;
    this.pingPort = null;
    try { if (this.db.open) this.db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(COURIER_PORT_KEY); } catch { /* best effort */ }
  }

  /** The doorbell. On (re)connect: catch up both ways. Dropped: reconnect with back-off up to 30 s. */
  private connect(): void {
    if (this.stopped || this.st.state === "revoked") return;
    this.stream = openEventStream(this.target, "/v1/events", {
      event: (name) => {
        if (name === "ready") {
          this.reconnectDelay = 1000;
          this.set({ state: "connected", lastError: null });
          void this.syncNow();
        } else if (name === "changes") {
          void this.pullNow();
        } else if (name === "projects") {
          void this.syncNow(); // a team project was created or promoted: learn it, then send
        } else if (name === "access") {
          // A membership or role changed (R2), or E was adopted: learn the projects, the keys and
          // any replay, adopt E if the office has, then catch up both ways.
          void this.syncNow();
        } else if (name === "modules") {
          void this.enqueue(async () => {
            await this.refreshModules();
            await this.push();
          });
        } else if (name === "revoked") {
          this.revoked();
        }
      },
      close: (err) => {
        this.stream = null;
        if (this.stopped || this.st.state === "revoked") return;
        if (err instanceof AccessRevokedError) return this.revoked(err);
        if (err instanceof SchemaMismatchError) {
          this.log(`paused: ${err.message}`);
          this.set({ state: "needs-update", lastError: err.message });
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, this.opt.retryMs);
          return;
        }
        this.set({ state: "offline", lastError: err?.message ?? this.st.lastError });
        const delay = Math.min(this.reconnectDelay, this.opt.maxReconnectMs);
        this.reconnectDelay = Math.min(delay * 2, this.opt.maxReconnectMs);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      },
    });
  }
}
