import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collabDataDir, notebookDataDir, unnamedDataDir } from "./notebooks.js";

// Spec P9: "I'm alive" files so doctor can tell which code a running program
// has loaded. Always in the DATA folder (P5), never next to an adopted .db.

export type ProgramName = "mcp" | "courier" | "web";
export interface Heartbeat {
  program: ProgramName; version: string; build: string; pid: number;
  startedAt: string; beatAt: string; dbPath: string; notebook: string | null;
}
const STALE_MS = 90_000;

export function runtimeDirFor(r: { path: string; name: string | null }, dataDir: string = collabDataDir()): string {
  return r.name ? notebookDataDir(r.name, dataDir) : unnamedDataDir(r.path, dataDir);
}

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
};

export function startHeartbeat(
  runtimeDir: string,
  hb: { program: ProgramName; version: string; build: string; dbPath: string; notebook: string | null },
  opts: { intervalMs?: number } = {},
): { stop(): void } {
  const dir = join(runtimeDir, "running");
  const file = join(dir, `${hb.program}-${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const body: Heartbeat = { ...hb, pid: process.pid, startedAt, beatAt: new Date().toISOString() };
      writeFileSync(file + ".tmp", JSON.stringify(body));
      renameSync(file + ".tmp", file);
    } catch { /* spec failure table: the program keeps running; doctor reports "can't see running programs" */ }
  };
  write();
  const timer = setInterval(write, opts.intervalMs ?? 30_000);
  timer.unref();
  const remove = () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } };
  const onExit = () => remove();
  process.once("exit", onExit);
  return {
    stop() { clearInterval(timer); process.removeListener("exit", onExit); remove(); },
  };
}

export function readHeartbeats(
  runtimeDir: string,
  now: Date = new Date(),
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Array<Heartbeat & { file: string; stale: boolean }> {
  const dir = join(runtimeDir, "running");
  if (!existsSync(dir)) return [];
  const out: Array<Heartbeat & { file: string; stale: boolean }> = [];
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(dir, n);
    try {
      const h = JSON.parse(readFileSync(file, "utf8")) as Heartbeat;
      const stale = !isAlive(h.pid) || now.getTime() - Date.parse(h.beatAt) > STALE_MS;
      out.push({ ...h, file, stale });
    } catch {
      const m = n.match(/^(mcp|courier|web)-(\d+)\.json$/);
      out.push({ program: (m?.[1] ?? "mcp") as ProgramName, version: "?", build: "?", pid: Number(m?.[2] ?? 0), startedAt: "", beatAt: "", dbPath: "", notebook: null, file, stale: true });
    }
  }
  return out;
}

export function removeStaleHeartbeats(runtimeDir: string, now?: Date, isAlive?: (pid: number) => boolean): string[] {
  const gone = readHeartbeats(runtimeDir, now, isAlive).filter((h) => h.stale).map((h) => h.file);
  for (const f of gone) rmSync(f, { force: true });
  return gone;
}
