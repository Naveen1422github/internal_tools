import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "./install-root.js";

export interface BuildInfo { version: string; build: string; builtAt: string }

/** Read fresh every call: doctor compares what's installed NOW with what a program started with. */
export function readBuildInfo(): BuildInfo {
  const f = join(installRoot(), "build-info.json");
  if (!existsSync(f)) return { version: "dev", build: "unknown", builtAt: "" };
  try { return JSON.parse(readFileSync(f, "utf8")) as BuildInfo; } catch { return { version: "dev", build: "unknown", builtAt: "" }; }
}
