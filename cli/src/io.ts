export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes/no question (bin.ts gives one when stdin is a terminal). Absent: nothing that needs a yes is done. */
  ask?(question: string): Promise<boolean>;
}
export interface CliResult { code: number; stop?: () => Promise<void> }
export interface Deps { importModule?: (spec: string) => Promise<unknown> }
