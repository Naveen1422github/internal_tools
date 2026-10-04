import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Code belongs to the install; data belongs to the user (spec rule 1). The
// install root is the folder holding addon-manifest.json: the repo root in a
// checkout, the package folder when installed. Found by walking up, so it
// works from core/src (tsx), core/dist (built) and node_modules/@collab-mcp/core/dist.
let cached: string | null = null;

export function installRoot(): string {
  if (process.env.COLLAB_INSTALL_ROOT) return process.env.COLLAB_INSTALL_ROOT;
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "addon-manifest.json"))) return (cached = dir);
    const up = dirname(dir);
    if (up === dir) throw new Error("[collab] install root not found: no addon-manifest.json above " + fileURLToPath(import.meta.url));
    dir = up;
  }
}
