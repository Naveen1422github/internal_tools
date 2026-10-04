#!/usr/bin/env node
import { installAddon } from "@collab-mcp/core";

// Spec P4: an install without internet must not fail. The add-on is then
// missing; `collab doctor` reports it and `collab doctor --fix` fetches it.
if (process.env.COLLAB_SKIP_ADDON !== "1") {
  try {
    const r = await installAddon();
    if (r.state === "ok") console.log(`collab: sync add-on ${r.version} installed and checked`);
    else console.log(`collab: the sync add-on could not be downloaded now (${r.state}). Run "collab doctor --fix" later.`);
  } catch (e) {
    console.log(`collab: the sync add-on could not be downloaded now (${(e as Error).message}). Run "collab doctor --fix" later.`);
  }
}
process.exitCode = 0;
