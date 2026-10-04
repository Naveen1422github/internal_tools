import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

// Spec P5/P6: every notebook has a folder in the per-user data folder, keyed
// by NAME, holding its runtime files (running/, backups/) wherever its .db is.

export const NOTEBOOK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function collabDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.COLLAB_DATA_DIR) return env.COLLAB_DATA_DIR;
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "collab");
}

export interface NotebookConfig {
  default: string | null;
  notebooks: Record<string, { path: string }>;
}

export class NotebookConfigError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[collab] ${file} can't be read: ${reason}. Fix the file by hand (it is never rewritten automatically); COLLAB_DB_PATH still works meanwhile.`);
    this.name = "NotebookConfigError";
  }
}

const configFile = (dataDir: string) => join(dataDir, "config.json");

export function readNotebookConfig(dataDir: string = collabDataDir()): NotebookConfig {
  const file = configFile(dataDir);
  if (!existsSync(file)) return { default: null, notebooks: {} };
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new NotebookConfigError(file, (e as Error).message); }
  if (!raw || typeof raw !== "object" || typeof raw.notebooks !== "object" || raw.notebooks === null) {
    throw new NotebookConfigError(file, 'expected { "default": ..., "notebooks": { ... } }');
  }
  for (const [name, v] of Object.entries(raw.notebooks)) {
    if (!NOTEBOOK_NAME.test(name) || typeof (v as any)?.path !== "string") throw new NotebookConfigError(file, `bad entry "${name}"`);
  }
  const def = raw.default ?? null;
  if (def !== null && !(def in raw.notebooks)) throw new NotebookConfigError(file, `default "${def}" is not in the list`);
  return { default: def, notebooks: raw.notebooks };
}

export function writeNotebookConfig(cfg: NotebookConfig, dataDir: string = collabDataDir()): void {
  mkdirSync(dataDir, { recursive: true });
  const file = configFile(dataDir);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, file);
}

export function notebookDataDir(name: string, dataDir: string = collabDataDir()): string {
  return join(dataDir, "notebooks", name);
}

/** Runtime folder for a notebook opened by path but not registered (COLLAB_DB_PATH, ./collab.db). */
export function unnamedDataDir(absPath: string, dataDir: string = collabDataDir()): string {
  const key = process.platform === "win32" ? resolve(absPath).toLowerCase() : resolve(absPath);
  return join(dataDir, "notebooks", "_path-" + createHash("sha256").update(key).digest("hex").slice(0, 12));
}

export function samePath(a: string, b: string): boolean {
  const ra = resolve(a), rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function addNotebook(name: string, path: string, dataDir: string = collabDataDir()): void {
  if (!NOTEBOOK_NAME.test(name)) throw new Error(`"${name}" is not a valid notebook name: use lowercase letters, digits and hyphens`);
  const cfg = readNotebookConfig(dataDir);
  if (cfg.notebooks[name]) throw new Error(`a notebook named "${name}" already exists (${cfg.notebooks[name].path})`);
  const other = Object.entries(cfg.notebooks).find(([, v]) => samePath(v.path, path));
  if (other) throw new Error(`${path} is already registered as "${other[0]}"`);
  cfg.notebooks[name] = { path: resolve(path) };
  if (cfg.default === null) cfg.default = name;
  writeNotebookConfig(cfg, dataDir);
}

export function setDefaultNotebook(name: string, dataDir: string = collabDataDir()): void {
  const cfg = readNotebookConfig(dataDir);
  if (!cfg.notebooks[name]) throw new Error(`no notebook named "${name}". Known: ${Object.keys(cfg.notebooks).join(", ") || "none"}`);
  cfg.default = name;
  writeNotebookConfig(cfg, dataDir);
}

export function nameForPath(path: string, dataDir: string = collabDataDir()): string | null {
  const cfg = readNotebookConfig(dataDir);
  return Object.entries(cfg.notebooks).find(([, v]) => samePath(v.path, path))?.[0] ?? null;
}
