import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { StoreError } from "./store.js";
import { officeFiles } from "./paths.js";

// A move to another machine (DEPLOY.md): one .tgz of the data dir that the
// container's entrypoint can unpack from COLLAB_OFFICE_BOOTSTRAP. store.db is
// copied with VACUUM INTO (a consistent copy, WAL included), never as raw
// files. The office must be STOPPED: anything it writes after the snapshot is
// lost, and a counter that ran on in two places hands out a number twice.

/** Hosts commonly cap one env var near 128 KB; base64 above this will not fit. */
export const ENV_VAR_LIMIT = 100_000;
const FILES = ["store.db", "cert.pem", "key.pem", "config.json"] as const;

export interface Bundle { out: string; bytes: number; base64Out: string; base64Length: number; url: string }

/** True when something already listens on `port`: the office is probably still running. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "EADDRINUSE"));
    s.listen(port, "0.0.0.0", () => s.close(() => done(false)));
  });
}

/** The OS tar (Windows: by full path, as in core's addon.ts; Git Bash's GNU tar misreads "C:\"). */
function tarBin(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

export async function bundleOffice(dir: string, out: string, o: { url?: string; force?: boolean; port?: number } = {}): Promise<Bundle> {
  const f = officeFiles(dir);
  for (const p of [f.store, f.cert, f.key, f.config]) {
    if (!existsSync(p)) throw new StoreError(`no post office in ${dir} (missing ${p})`);
  }
  const cfg = JSON.parse(readFileSync(f.config, "utf8")) as { url: string; port: number };
  const port = o.port ?? cfg.port;
  if (!o.force && port > 0 && (await portInUse(port))) {
    throw new StoreError(`port ${port} is in use: stop the post office first (or pass --force if something else holds that port)`);
  }
  const target = resolve(out);
  if (existsSync(target)) throw new StoreError(`${target} already exists; pick another name or delete it`);
  const staging = mkdtempSync(join(tmpdir(), "collab-po-bundle-"));
  try {
    // Plain read-only connection: no migrations, no cr-sqlite needed to copy pages.
    const db = new Database(f.store, { readonly: true, fileMustExist: true });
    try { db.exec(`VACUUM INTO '${join(staging, "store.db").replace(/'/g, "''")}'`); } finally { db.close(); }
    copyFileSync(f.cert, join(staging, "cert.pem"));
    copyFileSync(f.key, join(staging, "key.pem"));
    // --url is set-url on the snapshot only: the local data dir keeps its address.
    const url = o.url ?? cfg.url;
    writeFileSync(join(staging, "config.json"), JSON.stringify({ ...cfg, url }, null, 2) + "\n");
    execFileSync(tarBin(), ["-czf", target, "-C", staging, ...FILES]);
    chmodSync(target, 0o600); // it holds key.pem
    const b64 = readFileSync(target).toString("base64");
    const base64Out = target + ".b64";
    writeFileSync(base64Out, b64, { mode: 0o600 });
    return { out: target, bytes: statSync(target).size, base64Out, base64Length: b64.length, url };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
