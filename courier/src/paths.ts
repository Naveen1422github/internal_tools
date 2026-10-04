// file: courier/src/paths.ts
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** The courier's folder: config, pid, status, log. Per user, never in a repo. */
export function courierDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.COLLAB_COURIER_DIR) return env.COLLAB_COURIER_DIR; // tests, and a second courier for a second notes DB
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "collab", "courier");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "collab", "courier");
  return posix.join(env.XDG_STATE_HOME || posix.join(home, ".local", "state"), "collab", "courier");
}

export interface CourierFiles { dir: string; config: string; pid: string; status: string; log: string }
export function courierFiles(dir: string): CourierFiles {
  return {
    dir,
    config: join(dir, "config.json"),
    pid: join(dir, "courier.pid"),
    status: join(dir, "status.json"),
    log: join(dir, "courier.log"),
  };
}
