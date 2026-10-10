// file: courier/src/engine.ts
import Database from "better-sqlite3";
import { createSocket, type Socket } from "node:dgram";
import {
  loadCrsqlite, isCrsqliteLoaded, isSyncEnabled, getSyncValue, setSyncValue, postOfficeTargetFromDb,
  readOwnChanges, decodeChange, applyChanges, reindexFts, requestJson, openEventStream, hasSeries,
  sendContext, sendVerdictOf, resolveAllocator, allocateWithRetry, formatEntryRef,
  upsertTeamProjectFromOffice, localClashOf, projectClashText, assignPendingNumber,
  AccessRevokedError, SchemaMismatchError, PinMismatchError, COURIER_PORT_KEY,
  type PostOfficeTarget, type WireChange, type EventStream, type NotePlace, type ProjectClash,
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
  log?: (line: string) => void;
  onStatus?: (s: CourierStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;
const now = () => new Date().toISOString();
const changeKey = (w: WireChange) => `${w.site_id}|${w.db_version}|${w.seq}|${w.table}|${w.pk}|${w.cid}`;

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

  constructor(opts: CourierOptions) {
    this.opt = { retryMs: 30_000, debounceMs: 200, maxReconnectMs: 30_000, batchSize: 2000, watch: true, ...opts };
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
      if (this.clashes().length > 0) return this.holdForClash();
      await this.pull();
    });
  }
  /** Ask the office for the numbers of pending notes (stage C). Never throws. */
  numberPendingNow(): Promise<void> {
    return this.enqueue(async () => { await this.numberPending(); });
  }
  /**
   * Modules, team projects, pull, number pending notes, push: what a
   * (re)connect does. A project clash pauses the pull only (P10).
   */
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshModules();
      await this.refreshProjects();
      if (this.clashes().length === 0) await this.pull();
      const numbering = await this.numberPending();
      if (numbering === "revoked") return;
      await this.push();
      if (this.clashes().length > 0) this.holdForClash();
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
  /** What lastError should keep showing after a successful step (rule 8): a clash, or a note the office won't number. */
  private notice(): string | null {
    const c = this.clashes();
    return c.length > 0 ? projectClashText(c) : this.numberingProblem;
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
        if (upsertTeamProjectFromOffice(this.db, p, fingerprint) !== "clash") continue;
        const local = localClashOf(this.db, p);
        clashes.push({ code: p.code, office_ulid: p.ulid, local_ulid: local?.ulid ?? null, ...(local ? { local_code: local.code } : {}) });
      }
      const next = JSON.stringify(clashes);
      if (next !== (getSyncValue(this.db, K.projectClash) ?? "[]")) setSyncValue(this.db, K.projectClash, next);
    })();
  }

  /**
   * Number this laptop's pending notes (stage C, rule 4 / E-820): E notes, and
   * notes of this office's team projects. No "own notes only" filter is needed:
   * a pending note is never sent (send rule: hold), so a pending row only ever
   * exists on the laptop that wrote it. Retries use the SAME ulid, so a number
   * the office gave before an answer was lost comes back again (E-713).
   * Never throws: an unreachable office stops the loop and schedules the
   * normal retry; a note the office refuses to number is skipped and shown.
   */
  private async numberPending(): Promise<"ok" | "failed" | "revoked"> {
    this.numberingProblem = null;
    const series = hasSeries(this.db);
    const rows = (series
      ? this.db.prepare(
          `SELECT e.ulid, e.series FROM entries e LEFT JOIN projects p ON p.ulid = e.project_ulid
            WHERE e.id IS NULL AND e.deleted_at IS NULL
              AND (e.project_ulid IS NULL OR (p.mode = 'team' AND p.team = ?))
            ORDER BY e.ulid`,
        ).all(this.target.fingerprint)
      : this.db.prepare(`SELECT ulid, 'E' AS series FROM entries WHERE id IS NULL AND deleted_at IS NULL ORDER BY ulid`).all()
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

  private async refreshModules(): Promise<void> {
    const r = await requestJson(this.target, "GET", "/v1/modules");
    if (r.status !== 200 || !Array.isArray(r.body?.shared)) throw new Error(`the post office did not list the shared modules (${r.status})`);
    const next = JSON.stringify([...(r.body.shared as string[])].sort());
    if (next !== getSyncValue(this.db, K.shared)) setSyncValue(this.db, K.shared, next);
  }

  /**
   * Send this machine's OWN changes since the sent-bookmark that the send rule
   * (core send-filter.ts, shared with the status count) says to send: team
   * notes of this office, and E notes whose primary module is shared (D10).
   * Also: older notes of a module shared since the last push (backfill), and
   * the whole of a note just MOVED into a shared module.
   */
  private async push(): Promise<void> {
    const since = Number(getSyncValue(this.db, K.sent) ?? 0);
    const ctx = sendContext(this.db);
    const shared = ctx.shared;
    const done = this.backfilledModules();
    const backfill = new Set([...shared].filter((m) => !done.has(m)));
    const doneProjects = this.backfilledProjects();
    const projectBackfill = new Set([...ctx.teamProjects].filter((p) => !doneProjects.has(p)));
    const memo = new Map<string, NotePlace>();
    const out = new Map<string, WireChange>();
    const moved = new Set<string>();
    const createdNow = new Set<string>();
    const numberedNow = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, verdict } = sendVerdictOf(this.db, w, ctx, memo);
      if (verdict !== "send") continue; // hold = waiting (status only); the bookmark still passes it
      out.set(changeKey(w), w);
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
        if (verdict !== "send") continue;
        // Module backfill is the E path only: notes with no project. Team notes
        // are backfilled per project (promoted, or learned after an early edit).
        if (
          (place.project === null && place.module && backfill.has(place.module)) ||
          (place.project !== null && projectBackfill.has(place.project)) ||
          (ulid && (moved.has(ulid) || numberedNow.has(ulid)))
        ) out.set(changeKey(w), w);
      }
    }
    const batch = [...out.values()];
    for (let i = 0; i < batch.length; i += this.opt.batchSize) {
      const r = await requestJson(this.target, "POST", "/v1/changes", { changes: batch.slice(i, i + this.opt.batchSize) });
      if (r.status !== 200) throw new Error(`the post office refused the changes (${r.status}${r.body?.error ? `: ${r.body.error}` : ""})`);
    }
    // Only now is everything up to `top` acknowledged. A crash before this line
    // means a resend, which the post office de-duplicates.
    const sharedJson = JSON.stringify([...shared].sort());
    const projectsJson = JSON.stringify([...ctx.teamProjects].sort());
    if (top !== since || sharedJson !== getSyncValue(this.db, K.backfilled) || projectsJson !== (getSyncValue(this.db, K.backfilledProjects) ?? "[]")) {
      this.db.transaction(() => {
        setSyncValue(this.db, K.sent, String(top));
        setSyncValue(this.db, K.backfilled, sharedJson);
        setSyncValue(this.db, K.backfilledProjects, projectsJson);
      })();
    }
    if (batch.length > 0) {
      this.set({ sentTotal: this.st.sentTotal + batch.length, lastPushAt: now(), lastError: this.notice() });
      this.log(`sent ${batch.length} change(s)`);
    }
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
      // A note of a team project this laptop doesn't know yet: learn the
      // project list BEFORE applying, so a clashing code never mixes two
      // series here (P10). On a clash nothing is applied and the
      // receive-bookmark stays put.
      if (this.namesUnknownProject(changes)) {
        await this.refreshProjects();
        if (this.clashes().length > 0) return this.holdForClash();
      }
      this.db.transaction(() => {
        if (changes.length > 0) {
          const applied = applyChanges(this.db, changes.map(decodeChange));
          reindexFts(this.db, applied.entryUlids);
        }
        setSyncValue(this.db, K.recv, String(last));
      })();
      after = last;
      if (changes.length > 0) {
        this.set({ receivedTotal: this.st.receivedTotal + changes.length, lastPullAt: now(), lastError: this.notice() });
        this.log(`received ${changes.length} change(s)`);
      }
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
