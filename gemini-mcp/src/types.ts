export interface DriftWarning {
  pattern: string;
  line: number;
  context: string;
}

export interface SkimResult {
  response: string;
  files_read: string[];
  drift_warnings: DriftWarning[];
  tokens_used?: number;
  duration_ms: number;
}

export interface LocateMatch {
  file: string;
  line: number;
  snippet: string;
}

export interface LocateResult {
  matches: LocateMatch[];
  summary: string;
  drift_warnings: DriftWarning[];
  duration_ms: number;
}

export interface RunnerError {
  error: "timeout" | "cli_not_found" | "nonzero_exit";
  partial_output?: string;
  suggestion?: string;
}

