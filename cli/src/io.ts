export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes/no question (bin.ts gives one when stdin is a terminal). Absent: nothing that needs a yes is done. */
  ask?(question: string): Promise<boolean>;
}
export interface CliResult { code: number; stop?: () => Promise<void> }
export interface Deps { importModule?: (spec: string) => Promise<unknown> }

/**
 * A command's failure. A role refusal (R8) prints as its one plain sentence;
 * everything else keeps the `collab:` prefix. Exit 1 either way.
 */
export function failPlain(io: Io, e: unknown): CliResult {
  const msg = (e as Error).message ?? String(e);
  io.err((e as Error)?.name === "AccessDeniedError" ? msg : `collab: ${msg.replace(/^\[collab(-mcp)?\] /, "")}`);
  return { code: 1 };
}
