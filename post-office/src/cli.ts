// file: post-office/src/cli.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import Database from "better-sqlite3";
import { generateSelfSignedCert, formatJoinCode, describeMemberState, TEAM_STATUS_NOTE, formatEntryRef } from "@collab-mcp/core";
import {
  createStore, openStore, closeStore, addMember, revokeMember, teamStatus, setModuleShared, sharedModules,
  nextNumber, JOIN_TTL_HOURS, StoreError, type Store,
} from "./store.js";
import { lastSeq } from "./deliveries.js";
import { startPostOffice, type PostOffice } from "./server.js";
import { defaultDataDir, officeFiles } from "./paths.js";

export interface Io { out(line: string): void; err(line: string): void }
export interface OfficeConfig { url: string; port: number; fingerprint: string }
export const DEFAULT_PORT = 7443;

export const USAGE = `collab-post-office: the sync v1 post office

  init --seed-from <main laptop's notes .db> | --seed-max-id <n>
       [--url https://<address>:<port>] [--port ${DEFAULT_PORT}]
  serve [--host 0.0.0.0]
  add-member <name>            prints a ONE-TIME join code (valid ${JOIN_TTL_HOURS / 24} days)
  revoke <device-id | name>
  status
  share <module> | unshare <module> | modules

Every command takes --data <dir> (default: ${defaultDataDir()}).`;

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opt[a.slice(2)] = next; i++; } else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "127.0.0.1";
}

/** The highest E-number the main laptop has used (max id, or its local counter if higher). Read-only. */
export function seedFromNotesDb(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const max = (db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM entries`).get() as { m: number }).m;
    const hasCounter = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_counters'`).get();
    const counter = hasCounter
      ? ((db.prepare(`SELECT value FROM local_counters WHERE name = 'entry_number'`).get() as { value: number } | undefined)?.value ?? 0)
      : 0;
    return Math.max(max, counter);
  } finally {
    db.close();
  }
}

function readConfig(dir: string): OfficeConfig {
  const f = officeFiles(dir);
  if (!existsSync(f.config)) throw new StoreError(`no post office in ${dir}; run \`collab-post-office init\` first`);
  return JSON.parse(readFileSync(f.config, "utf8")) as OfficeConfig;
}

function withStore<T>(dir: string, fn: (s: Store) => T): T {
  const s = openStore(officeFiles(dir).store);
  try { return fn(s); } finally { closeStore(s); }
}

export async function runCli(argv: string[], io: Io): Promise<{ code: number; office?: PostOffice }> {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos[0];
  const dir = typeof opt.data === "string" ? opt.data : defaultDataDir();
  const f = officeFiles(dir);
  try {
    switch (cmd) {
      case "init": {
        if (existsSync(f.store)) throw new StoreError(`a post office already exists in ${dir}`);
        let seed: number;
        if (typeof opt["seed-from"] === "string") seed = seedFromNotesDb(opt["seed-from"]);
        else if (typeof opt["seed-max-id"] === "string" && /^\d+$/.test(opt["seed-max-id"])) seed = Number(opt["seed-max-id"]);
        else throw new StoreError("init needs --seed-from <the main laptop's notes DB> or --seed-max-id <n>: new note numbers must continue after the highest one already used");
        const port = typeof opt.port === "string" ? Number(opt.port) : DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StoreError(`not a port: ${String(opt.port)}`);
        const url = typeof opt.url === "string" ? opt.url : `https://${lanAddress()}:${port}`;
        if (!url.startsWith("https://")) throw new StoreError("the post office URL must start with https://");
        mkdirSync(dir, { recursive: true });
        const cert = generateSelfSignedCert();
        writeFileSync(f.cert, cert.certPem);
        writeFileSync(f.key, cert.keyPem, { mode: 0o600 });
        const config: OfficeConfig = { url, port, fingerprint: cert.fingerprint };
        writeFileSync(f.config, JSON.stringify(config, null, 2) + "\n");
        closeStore(createStore(f.store, { seedMaxId: seed }));
        io.out(`post office created in ${dir}`);
        io.out(`  store.db     every shared note + members + the number counter`);
        io.out(`  cert.pem     its HTTPS certificate (self-signed)`);
        io.out(`  key.pem      the certificate's private key: keep it private`);
        io.out(`  config.json  address ${url}`);
        io.out(`certificate fingerprint: ${cert.fingerprint}`);
        io.out(`the next new note will be ${formatEntryRef(seed + 1)}`);
        io.out(`next: collab-post-office serve, then collab-post-office add-member "<machine name>" for each machine`);
        io.out(`to remove it: stop serve and delete ${dir}`);
        return { code: 0 };
      }
      case "serve": {
        const cfg = readConfig(dir);
        const store = openStore(f.store);
        const office = await startPostOffice({
          store,
          certPem: readFileSync(f.cert, "utf8"),
          keyPem: readFileSync(f.key, "utf8"),
          host: typeof opt.host === "string" ? opt.host : "0.0.0.0",
          port: cfg.port,
          log: (line) => io.out(`${new Date().toISOString()} ${line}`),
        });
        io.out(`post office listening on port ${office.port}; members reach it at ${cfg.url}`);
        io.out(`certificate fingerprint ${cfg.fingerprint}`);
        return {
          code: 0,
          office: { ...office, close: async () => { await office.close(); closeStore(store); } },
        };
      }
      case "add-member": {
        const name = pos.slice(1).join(" ").trim();
        if (!name) throw new StoreError("add-member needs a name, e.g. add-member \"second laptop\"");
        const cfg = readConfig(dir);
        const { deviceId, secret } = withStore(dir, (s) => addMember(s, name));
        const code = formatJoinCode({ url: cfg.url, fingerprint: cfg.fingerprint, device: deviceId, secret });
        io.out(`member "${name}" added as ${deviceId}. One-time join code (valid ${JOIN_TTL_HOURS / 24} days; treat it like a password):`);
        io.out("");
        io.out(code);
        io.out("");
        io.out(`on that machine: collab sync setup <the code above>`);
        return { code: 0 };
      }
      case "revoke": {
        const who = pos.slice(1).join(" ").trim();
        if (!who) throw new StoreError("revoke needs a device id or a member name");
        const m = withStore(dir, (s) => revokeMember(s, who));
        io.out(`revoked ${m.name} (${m.device_id}): every request from it is now refused`);
        return { code: 0 };
      }
      case "status": {
        const cfg = readConfig(dir);
        withStore(dir, (s) => {
          io.out(`post office ${cfg.url}   deliveries ${lastSeq(s)}   next new note ${formatEntryRef(nextNumber(s))}`);
          const shared = sharedModules(s);
          io.out(`shared modules: ${shared.length ? shared.join(", ") : "(none yet: collab-post-office share <module>)"}`);
          const rows = teamStatus(s);
          if (rows.length === 0) { io.out("no members yet: collab-post-office add-member <name>"); return; }
          io.out(`${"DEVICE".padEnd(14)}${"NAME".padEnd(22)}${"STATE".padEnd(20)}LAST SEEN`);
          for (const r of rows) {
            const state = describeMemberState(r.state, r.behind);
            io.out(`${r.device_id.padEnd(14)}${r.name.padEnd(22)}${state.padEnd(20)}${r.last_seen_at ?? "-"}`);
          }
          io.out(TEAM_STATUS_NOTE);
        });
        return { code: 0 };
      }
      case "share":
      case "unshare": {
        const slug = pos[1];
        if (!slug) throw new StoreError(`${cmd} needs a module slug`);
        const shared = withStore(dir, (s) => setModuleShared(s, slug, cmd === "share"));
        io.out(`shared modules: ${shared.join(", ") || "(none)"}`);
        return { code: 0 };
      }
      case "modules": {
        io.out(`shared modules: ${withStore(dir, sharedModules).join(", ") || "(none)"}`);
        return { code: 0 };
      }
      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`collab-post-office: ${(e as Error).message}`);
    return { code: 1 };
  }
}
