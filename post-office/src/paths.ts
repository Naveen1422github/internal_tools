// file: post-office/src/paths.ts
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** Where the post office keeps its store, certificate and key. Never inside the repo. */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab", "post-office");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab", "post-office");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "collab", "post-office");
}

export interface OfficeFiles { dir: string; store: string; cert: string; key: string; config: string }
export function officeFiles(dir: string): OfficeFiles {
  return { dir, store: join(dir, "store.db"), cert: join(dir, "cert.pem"), key: join(dir, "key.pem"), config: join(dir, "config.json") };
}
