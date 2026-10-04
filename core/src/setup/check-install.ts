import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "../install-root.js";
import { checkAddon } from "../addon.js";
import type { SetupCheck } from "./types.js";

const REBUILD_FIX = "npm rebuild -g @collab-mcp/collab (or reinstall collab)";

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

export function checkNode(): SetupCheck {
  const v = process.versions.node;
  const range: string = JSON.parse(readFileSync(join(installRoot(), "package.json"), "utf8")).engines?.node ?? ">=20.9.0";
  const m = range.match(/^>=\s*v?(\d+(?:\.\d+){0,2})$/);
  if (!m) return { group: "install", id: "install.node", mark: "warn", text: `Node ${v}; can't read collab's Node range "${range}"` };
  const min = m[1];
  if (older(parseVersion(v), parseVersion(min))) {
    return { group: "install", id: "install.node", mark: "error", text: `Node ${v} is older than collab needs (${range})`, fix: `install Node ${min} or newer from nodejs.org` };
  }
  return { group: "install", id: "install.node", mark: "ok", text: `Node ${v} (needs ${range})` };
}

export function checkSqlite(): SetupCheck {
  try {
    new Database(":memory:").close();
    return { group: "install", id: "install.sqlite", mark: "ok", text: "Database driver loads" };
  } catch (e) {
    const msg = (e as Error).message;
    if (/NODE_MODULE_VERSION|was compiled against a different Node/.test(msg)) {
      return { group: "install", id: "install.sqlite", mark: "error", text: "The database driver was built for a different Node version", fix: REBUILD_FIX };
    }
    return { group: "install", id: "install.sqlite", mark: "error", text: `The database driver doesn't load: ${msg}`, fix: REBUILD_FIX };
  }
}

export function checkAddonState(env: NodeJS.ProcessEnv): SetupCheck {
  const a = checkAddon({ env });
  const base = { group: "install" as const, id: "install.addon" };
  switch (a.state) {
    case "ok": return { ...base, mark: "ok", text: `Sync add-on ${a.version}, checked` };
    case "missing": return { ...base, mark: "error", text: "Sync add-on missing", fix: "collab doctor --fix" };
    case "hash-mismatch": return { ...base, mark: "error", text: "The sync add-on file was damaged or altered", fix: "collab doctor --fix" };
    case "unsupported": return { ...base, mark: "warn", text: `No sync add-on for ${a.key}: this computer can keep notes but can't share them` };
    case "override": return { ...base, mark: "warn", text: `Using a sync add-on from COLLAB_CRSQLITE_PATH (${a.path}); not checked` };
  }
}
