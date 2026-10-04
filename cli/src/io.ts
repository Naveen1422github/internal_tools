export interface Io { out(line: string): void; err(line: string): void }
export interface CliResult { code: number; stop?: () => Promise<void> }
export interface Deps { importModule?: (spec: string) => Promise<unknown> }
