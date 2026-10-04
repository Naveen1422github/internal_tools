// Setup doctor (spec P10): one report for the terminal, the web UI and the MCP.
export type GroupId = "install" | "notebook" | "version" | "programs" | "sync" | "claude" | "notes";
export type Mark = "ok" | "warn" | "error" | "skipped";
export interface SetupCheck { group: GroupId; id: string; mark: Mark; text: string; fix?: string }
export interface SetupReport {
  checks: SetupCheck[];
  errors: number;
  warnings: number;
  exitCode: 0 | 1 | 2;
  notebook: { name: string | null; path: string; source: string; described: string } | null;
}
export interface SetupContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  now: Date;
  /** Network probe of the post office; doctor never opens a socket in tests unless a stub is given. */
  probePostOffice: ((db: import("../db.js").DB) => Promise<"ok" | "unreachable" | "cert-changed">) | null;
  claudeConfigFiles: string[];
  isAlive: (pid: number) => boolean;
  /** Only these groups run (startup checks use ["install", "notebook"]). */
  groups?: GroupId[];
}
export interface GroupState { resolution: import("../db.js").DbPathResolution | null; db: import("../db.js").DB | null; dbOpenError: string | null }
export type GroupRunner = (ctx: SetupContext, st: GroupState) => Promise<SetupCheck[]> | SetupCheck[];
