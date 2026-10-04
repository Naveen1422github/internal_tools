import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collabDataDir } from "./notebooks.js";

// Spec P14: an installed collab has no repo .env, so the web server's port and
// AI key live in the per-user data folder. Never package-relative (E-550).
export function settingsPath(dataDir: string = collabDataDir()): string {
  return join(dataDir, "settings.env");
}

export function loadSettings(file: string = settingsPath(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (env[key] !== undefined) continue;
    env[key] = rawVal.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    set.push(key);
  }
  return set;
}
