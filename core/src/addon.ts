import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "./install-root.js";

// Spec P3/P4: the cr-sqlite add-on is downloaded per OS/CPU from a pinned
// version and checked against SHA-256 values shipped in the package before it
// is ever loaded. A damaged or altered file is deleted, never loaded.

export interface AddonManifest {
  version: string;
  platforms: Record<string, { asset: string; zipSha256: string; lib: string; libSha256: string }>;
}
export type AddonState =
  | { state: "ok"; path: string; version: string }
  | { state: "missing"; key: string }
  | { state: "unsupported"; key: string }
  | { state: "hash-mismatch"; path: string }
  | { state: "override"; path: string };

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;
export function readAddonManifest(root: string = installRoot()): AddonManifest {
  return JSON.parse(readFileSync(join(root, "addon-manifest.json"), "utf8"));
}
const vendorDir = (root: string) => join(root, "vendor", "crsqlite");

export function checkAddon(o: { root?: string; platform?: string; arch?: string; env?: NodeJS.ProcessEnv } = {}): AddonState {
  const env = o.env ?? process.env;
  if (env.COLLAB_CRSQLITE_PATH) return { state: "override", path: env.COLLAB_CRSQLITE_PATH };
  const root = o.root ?? installRoot();
  const m = readAddonManifest(root);
  const key = platformKey(o.platform, o.arch);
  const p = m.platforms[key];
  if (!p) return { state: "unsupported", key };
  const file = join(vendorDir(root), p.lib);
  if (!existsSync(file)) return { state: "missing", key };
  if (sha256File(file) !== p.libSha256) return { state: "hash-mismatch", path: file };
  return { state: "ok", path: file, version: m.version };
}

export async function installAddon(o: { root?: string; fetchImpl?: typeof fetch; platform?: string; arch?: string } = {}): Promise<AddonState> {
  const root = o.root ?? installRoot();
  const m = readAddonManifest(root);
  const key = platformKey(o.platform, o.arch);
  const p = m.platforms[key];
  if (!p) return { state: "unsupported", key };
  const out = vendorDir(root);
  mkdirSync(out, { recursive: true });
  const url = `https://github.com/vlcn-io/cr-sqlite/releases/download/${m.version}/${p.asset}`;
  const res = await (o.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== p.zipSha256) return { state: "hash-mismatch", path: url };
  const staging = join(out, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const zip = join(staging, p.asset);
  writeFileSync(zip, bytes);
  // Windows: the OS tar by full path (under Git Bash, plain `tar` is GNU tar and misreads "C:\").
  if (process.platform === "win32") execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", staging]);
  else execFileSync("unzip", ["-o", zip, "-d", staging]);
  const lib = readdirSync(staging).find((f) => f === p.lib);
  if (!lib || sha256File(join(staging, lib)) !== p.libSha256) {
    rmSync(staging, { recursive: true, force: true });
    return { state: "hash-mismatch", path: join(staging, p.lib) };
  }
  renameSync(join(staging, lib), join(out, p.lib));
  rmSync(staging, { recursive: true, force: true });
  return checkAddon({ root, platform: o.platform, arch: o.arch, env: {} });
}
