// file: courier/src/engine.ts
import Database from "better-sqlite3";
import { createSocket, type Socket } from "node:dgram";
import {
  loadCrsqlite, isCrsqliteLoaded, isSyncEnabled, getSyncValue, setSyncValue, postOfficeTargetFromDb,
  readOwnChanges, decodeChange, applyChanges, reindexFts, entryUlidOf, requestJson, openEventStream,
  AccessRevokedError, COURIER_PORT_KEY, type PostOfficeTarget, type WireChange, type EventStream,
} from "@collab-mcp/core";
import { COURIER_KEYS as K } from "./keys.js";

// The courier (spec Components 2, D4). One per machine, client-agnostic: it
// opens the notes DB itself. Push on write (each save pings us over local UDP,
// ~200 ms debounce; collab E-722), pull when the doorbell rings (SSE), retry every
// 30 s after a failure, no network while nothing changes. All network work runs one
// job at a time. Bookmarks make every step safe to repeat: the sent-bookmark
// moves only after the post office acknowledged; the receive-bookmark moves in
// the same transaction as the rows it covers.

export type CourierState = "starting" | "connected" | "offline" | "revoked" | "stopped";

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
  readonly target: PostOfficeTarget;
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

  constructor(opts: CourierOptions) {
    this.opt = { retryMs: 30_000, debounceMs: 200, maxReconnectMs: 30_000, batchSize: 2000, watch: true, ...opts };
    this.db = new Database(opts.dbPath, { fileMustExist: true });
    try {
      this.db.pragma("journal_mode = WAL");
      loadCrsqlite(this.db); // this connection writes a shared DB: it must carry cr-sqlite
      if (!isSyncEnabled(this.db)) throw new Error(`${opts.dbPath} does not share notes yet: run \`collab sync setup <join code>\` first`);
      const t = postOfficeTargetFromDb(this.db);
      if (!t) throw new Error(`${opts.dbPath} has no post office configured: run \`collab sync setup <join code>\` first`);
      this.target = t;
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

  pushNow(): Promise<void> {
    return this.enqueue(() => this.push());
  }
  pullNow(): Promise<void> {
    return this.enqueue(() => this.pull());
  }
  /** Modules, then pull, then push: what a (re)connect does. */
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshModules();
      await this.pull();
      await this.push();
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

  private sharedModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.shared) ?? "[]") as string[]); } catch { return new Set(); }
  }
  private backfilledModules(): Set<string> {
    try { return new Set(JSON.parse(getSyncValue(this.db, K.backfilled) ?? "[]") as string[]); } catch { return new Set(); }
  }

  /** The note a change belongs to and that note's PRIMARY module (D10); for a modules row, its slug. */
  private placeOf(w: WireChange, memo: Map<string, string | null>): { ulid: string | null; module: string | null } {
    const pk = Buffer.from(w.pk, "base64");
    if (w.table === "modules") {
      const r = this.db.prepare(`SELECT cell FROM crsql_unpack_columns(?)`).get(pk) as { cell: unknown } | undefined;
      return { ulid: null, module: r ? String(r.cell) : null };
    }
    const ulid = entryUlidOf(this.db, w.table, pk);
    if (!ulid) return { ulid: null, module: null };
    if (!memo.has(ulid)) {
      const e = this.db.prepare(`SELECT module FROM entries WHERE ulid = ?`).get(ulid) as { module: string | null } | undefined;
      memo.set(ulid, e?.module ?? null);
    }
    return { ulid, module: memo.get(ulid) ?? null };
  }

  private async refreshModules(): Promise<void> {
    const r = await requestJson(this.target, "GET", "/v1/modules");
    if (r.status !== 200 || !Array.isArray(r.body?.shared)) throw new Error(`the post office did not list the shared modules (${r.status})`);
    const next = JSON.stringify([...(r.body.shared as string[])].sort());
    if (next !== getSyncValue(this.db, K.shared)) setSyncValue(this.db, K.shared, next);
  }

  /**
   * Send this machine's OWN changes since the sent-bookmark whose note's primary
   * module is shared (D10). Also: older notes of a module shared since the last
   * push (backfill), and the whole of a note just MOVED into a shared module.
   */
  private async push(): Promise<void> {
    const since = Number(getSyncValue(this.db, K.sent) ?? 0);
    const shared = this.sharedModules();
    const done = this.backfilledModules();
    const backfill = new Set([...shared].filter((m) => !done.has(m)));
    const memo = new Map<string, string | null>();
    const out = new Map<string, WireChange>();
    const moved = new Set<string>();
    const createdNow = new Set<string>();
    let top = since;
    for (const w of readOwnChanges(this.db, since)) {
      top = Math.max(top, w.db_version);
      const { ulid, module } = this.placeOf(w, memo);
      if (!module || !shared.has(module)) continue;
      out.set(changeKey(w), w);
      if (w.table === "entries" && ulid) {
        if (w.cid === "created_at") createdNow.add(ulid);
        if (w.cid === "module") moved.add(ulid);
      }
    }
    for (const u of createdNow) moved.delete(u); // a new note is not a move: it is already whole
    if (backfill.size > 0 || moved.size > 0) {
      for (const w of readOwnChanges(this.db, 0)) {
        if (w.db_version > top) continue; // newer than this push: the next push takes it
        const { ulid, module } = this.placeOf(w, memo);
        if ((module && backfill.has(module)) || (ulid && moved.has(ulid))) out.set(changeKey(w), w);
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
    if (top !== since || sharedJson !== getSyncValue(this.db, K.backfilled)) {
      this.db.transaction(() => {
        setSyncValue(this.db, K.sent, String(top));
        setSyncValue(this.db, K.backfilled, sharedJson);
      })();
    }
    if (batch.length > 0) {
      this.set({ sentTotal: this.st.sentTotal + batch.length, lastPushAt: now(), lastError: null });
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
      this.db.transaction(() => {
        if (changes.length > 0) {
          const applied = applyChanges(this.db, changes.map(decodeChange));
          reindexFts(this.db, applied.entryUlids);
        }
        setSyncValue(this.db, K.recv, String(last));
      })();
      after = last;
      if (changes.length > 0) {
        this.set({ receivedTotal: this.st.receivedTotal + changes.length, lastPullAt: now(), lastError: null });
        this.log(`received ${changes.length} change(s)`);
      }
    }
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
