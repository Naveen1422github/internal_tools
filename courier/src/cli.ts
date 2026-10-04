// file: courier/src/cli.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  resolveDbPath, loadCrsqlite, getSyncValue, postOfficeTargetFromDb, readOwnChanges, requestJson, type PostOfficeTarget,
} from "@collab-mcp/core";
import { Courier, type CourierStatus } from "./engine.js";
import { COURIER_KEYS } from "./keys.js";
import { courierDir as defaultCourierDir, courierFiles } from "./paths.js";
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type AutostartDeps } from "./autostart.js";
import { setup, uninstall, readCourierConfig, writeCourierConfig } from "./setup.js";

export interface Io { out(line: string): void; err(line: string): void }

export interface CliDeps {
  courierDir?: string;
  /** Asks the user; the default reads one line from a TTY and answers "" (= No) otherwise. */
  ask?: (question: string) => Promise<string>;
  autostartCtx?: Partial<AutostartContext>;
  autostartDeps?: AutostartDeps;
  /** How `start` launches `collab sync run` (default: this node + this script). */
  launcher?: { file: string; args: string[] };
  /** Courier timings (tests). */
  courierOptions?: { retryMs?: number; debounceMs?: number; maxReconnectMs?: number };
}

export interface CliResult {
  code: number;
  /** `sync run`: the running courier and how to stop it (bin.ts wires the signals). */
  courier?: Courier;
  stop?: () => Promise<void>;
}

export const USAGE = `collab sync: share chosen modules of your collab notes with your other machines

  collab sync setup <join code> [--db <notes.db>] [--autostart | --no-autostart] [--upload-existing]
  collab sync start [--foreground]      start the courier in the background
  collab sync stop
  collab sync status [--team]
  collab sync modules | share <module> | unshare <module>
  collab sync autostart on|off [--dry-run]
  collab sync uninstall [--yes]         remove everything setup added

Notes are always saved locally; the courier sends and collects them. If it is not
running, nothing is lost: it catches up when it starts.`;

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  const valued = new Set(["db"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.has(name) && argv[i + 1] !== undefined) { opt[name] = argv[i + 1]; i++; } else opt[name] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function defaultAsk(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openReadable(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true });
  loadCrsqlite(db);
  return db;
}
function closeReadable(db: Database.Database): void {
  try { db.prepare("SELECT crsql_finalize()").get(); } catch { /* closing anyway */ }
  db.close();
}

export async function runCli(argv: string[], io: Io, deps: CliDeps = {}): Promise<CliResult> {
  const { pos, opt } = parseArgs(argv);
  if (pos[0] !== "sync") { io.err(USAGE); return { code: 2 }; }
  const cmd = pos[1];
  const dir = deps.courierDir ?? defaultCourierDir();
  const files = courierFiles(dir);
  const ask = deps.ask ?? defaultAsk;
  const ctx: AutostartContext = {
    platform: process.platform,
    nodePath: process.execPath,
    binPath: fileURLToPath(new URL("./bin.js", import.meta.url)),
    home: homedir(),
    env: process.env,
    courierDir: dir,
    logPath: files.log,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    ...deps.autostartCtx,
  };
  const needConfig = () => {
    const cfg = readCourierConfig(dir);
    if (!cfg) throw new Error("this machine is not set up for sync yet: collab sync setup <join code>");
    return cfg;
  };
  const target = (): PostOfficeTarget => {
    const db = openReadable(needConfig().dbPath);
    try {
      const t = postOfficeTargetFromDb(db);
      if (!t) throw new Error("no post office is configured in the notes DB; run collab sync setup again");
      return t;
    } finally { closeReadable(db); }
  };
  const stopRunning = async (): Promise<boolean> => {
    const pid = readPid(files.pid);
    if (pid === null || !isAlive(pid)) { rmSync(files.pid, { force: true }); return false; }
    process.kill(pid, "SIGTERM"); // Windows: terminates at once; the bookmarks make that safe
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
    rmSync(files.pid, { force: true });
    return true;
  };

  try {
    switch (cmd) {
      case "setup": {
        const code = pos[2];
        if (!code) throw new Error("setup needs the join code from the post office owner: collab sync setup <join code>");
        let auto: boolean;
        if (opt.autostart === true) auto = true;
        else if (opt["no-autostart"] === true) auto = false;
        else auto = /^y(es)?$/i.test((await ask("Start sync automatically when you log in? [y/N] ")).trim());
        const dbPath = typeof opt.db === "string" ? opt.db : resolveDbPath().path;
        await setup({
          code, dbPath, courierDir: dir, autostart: auto,
          uploadExisting: opt["upload-existing"] === true, includeStaged: opt["include-staged"] === true,
          autostartCtx: ctx, autostartDeps: deps.autostartDeps, out: io.out,
        });
        return { code: 0 };
      }

      case "start": {
        needConfig();
        const pid = readPid(files.pid);
        if (pid !== null && isAlive(pid)) { io.out(`the courier is already running (pid ${pid})`); return { code: 0 }; }
        if (opt.foreground === true) return runCli(["sync", "run"], io, deps);
        mkdirSync(dir, { recursive: true });
        const launcher = deps.launcher ?? { file: process.execPath, args: [...process.execArgv, process.argv[1]] };
        const logFd = openSync(files.log, "a");
        const child = spawn(launcher.file, [...launcher.args, "sync", "run"], {
          detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env: process.env,
        });
        child.unref();
        closeSync(logFd);
        for (let i = 0; i < 50 && readPid(files.pid) === null; i++) await sleep(100);
        io.out(`the courier is running in the background (pid ${child.pid}); log: ${files.log}`);
        io.out(`stop it with: collab sync stop`);
        return { code: 0 };
      }

      case "run": {
        const cfg = needConfig();
        const other = readPid(files.pid);
        if (other !== null && other !== process.pid && isAlive(other)) throw new Error(`a courier is already running (pid ${other}); one per machine`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(files.pid, String(process.pid));
        const say = (line: string) => io.out(`${new Date().toISOString()} ${line}`);
        const courier = new Courier({
          dbPath: cfg.dbPath, ...deps.courierOptions, log: say,
          onStatus: (s: CourierStatus) => { try { writeFileSync(files.status, JSON.stringify({ ...s, pid: process.pid }, null, 2)); } catch { /* status is best effort */ } },
        });
        courier.start();
        say(`courier started for ${cfg.dbPath} -> ${cfg.postOffice}`);
        const stop = async () => {
          await courier.stop();
          if (readPid(files.pid) === process.pid) rmSync(files.pid, { force: true });
          say("courier stopped");
        };
        return { code: 0, courier, stop };
      }

      case "stop": {
        io.out((await stopRunning()) ? "the courier is stopped" : "the courier was not running");
        return { code: 0 };
      }

      case "status": {
        const cfg = readCourierConfig(dir);
        if (!cfg) { io.out("sync is not set up on this machine (collab sync setup <join code>)"); return { code: 0 }; }
        const pid = readPid(files.pid);
        const running = pid !== null && isAlive(pid);
        const st = existsSync(files.status) ? (JSON.parse(readFileSync(files.status, "utf8")) as CourierStatus) : null;
        const db = openReadable(cfg.dbPath);
        let sent = 0, recv = 0, unsent = 0;
        try {
          sent = Number(getSyncValue(db, COURIER_KEYS.sent) ?? 0);
          recv = Number(getSyncValue(db, COURIER_KEYS.recv) ?? 0);
          unsent = readOwnChanges(db, sent).length;
        } finally { closeReadable(db); }
        io.out(`notes DB:     ${cfg.dbPath}`);
        io.out(`post office:  ${cfg.postOffice} (this machine: ${cfg.device})`);
        io.out(`courier:      ${running ? `running (pid ${pid})` : "not running (collab sync start)"}${st ? `, last state: ${st.state}` : ""}`);
        if (st?.state === "revoked") io.out(`              ACCESS REVOKED: ask the post office owner for a new join code`);
        if (st?.lastError) io.out(`last error:   ${st.lastError}`);
        io.out(`bookmarks:    sent up to local version ${sent}; received up to delivery #${recv}`);
        io.out(`not yet sent: ${unsent} local change(s) (private-module changes are counted but never leave)`);
        io.out(`start at login: ${cfg.autostart ? "yes" : "no"}`);
        if (opt.team === true) {
          const r = await requestJson(target(), "GET", "/v1/status");
          io.out(`team (deliveries: ${r.body?.last_seq ?? "?"}):`);
          for (const m of (r.body?.members ?? []) as Array<{ device_id: string; name: string; state: string; behind: number; last_seen_at: string | null }>) {
            io.out(`  ${m.device_id.padEnd(14)}${m.name.padEnd(22)}${(m.state === "behind" ? `behind ${m.behind}` : m.state).padEnd(18)}${m.last_seen_at ?? "-"}`);
          }
        }
        return { code: 0 };
      }

      case "modules":
      case "share":
      case "unshare": {
        let r;
        if (cmd === "modules") r = await requestJson(target(), "GET", "/v1/modules");
        else {
          const slug = pos[2];
          if (!slug) throw new Error(`${cmd} needs a module slug`);
          r = await requestJson(target(), "POST", "/v1/modules", { slug, shared: cmd === "share" });
        }
        if (r.status !== 200) throw new Error(r.body?.error ?? `the post office answered ${r.status}`);
        io.out(`shared modules (for the whole team): ${(r.body.shared as string[]).join(", ") || "(none)"}`);
        return { code: 0 };
      }

      case "autostart": {
        const cfg = needConfig();
        const on = pos[2] === "on" ? true : pos[2] === "off" ? false : null;
        if (on === null) throw new Error("autostart on|off");
        const plan = autostartPlan(ctx);
        if (opt["dry-run"] === true) {
          io.out(`dry run: nothing is registered. ${on ? "autostart on" : "autostart off"} would:`);
          for (const f of plan.files) io.out(`  ${on ? "write" : "delete"} ${f.path}`);
          for (const c of on ? plan.install : [...plan.remove, ...plan.afterRemove]) io.out(`  run "${c.file}" ${c.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
          for (const line of plan.describe) io.out(`  ${line}`);
          return { code: 0 };
        }
        if (on) {
          installAutostart(plan, deps.autostartDeps);
          io.out("start at login: ON");
          for (const line of plan.describe) io.out(`  ${line}`);
        } else {
          const notes = removeAutostart(plan, deps.autostartDeps);
          io.out(`start at login: OFF${notes.length ? ` (notes: ${notes.join("; ")})` : ""}`);
        }
        writeCourierConfig(dir, { ...cfg, autostart: on });
        return { code: 0 };
      }

      case "uninstall": {
        if (opt.yes !== true && !/^y(es)?$/i.test((await ask("Remove sync from this machine (your notes stay)? [y/N] ")).trim())) {
          io.out("nothing removed");
          return { code: 0 };
        }
        await uninstall({ courierDir: dir, autostartCtx: ctx, autostartDeps: deps.autostartDeps, out: io.out, stopCourier: async () => { await stopRunning(); } });
        return { code: 0 };
      }

      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`collab sync: ${(e as Error).message}`);
    return { code: 1 };
  }
}
