#!/usr/bin/env node
/**
 * Parse Codex JSONL output into a draft entry.
 *
 * Input: Codex JSONL stream on stdin (as emitted by `codex exec --json ...`).
 * Behavior:
 *   - Extracts agent_message items and tool_call statuses.
 *   - Composes raw_text = concatenation of agent messages + tool-call log.
 *   - Calls parseIntoDraft(...) to shape a DraftEntry.
 *   - Prints draft_entry as JSON to stdout by default.
 *   - With --save, calls addEntry(...) to persist it and prints the inserted id.
 *
 * Usage (all flags optional):
 *   cat codex.jsonl | npx tsx src/scripts/parse-codex-output.ts \
 *     --source codex-dispatch \
 *     --task T-001 \
 *     --module custom-reports \
 *     --agent Codex \
 *     --changed-files src/foo.ts,src/bar.ts \
 *     --type-hint handoff \
 *     --save
 *
 * Flags:
 *   --source <name>          codex-dispatch | codex-review | manual | session-end  (default: codex-dispatch)
 *   --task <id>              task id, e.g. T-001
 *   --module <slug>          module slug
 *   --agent <name>           Claude | Codex | Gemini | User (default: Codex)
 *   --changed-files <csv>    comma-separated repo-relative paths -> file refs
 *   --type-hint <type>       override default type (see IngestSource -> EntryType map)
 *   --save                   persist the draft via addEntry and print {id: N}
 *   --input <path>           read from file path instead of stdin
 */
import { readFileSync } from "node:fs";
import { getDb, migrate, closeDb } from "../db.js";
import { addEntry } from "../tools/add.js";
import {
  parseIntoDraft,
  type IngestArgs,
  type IngestContext,
  type IngestSource,
} from "../tools/ingest.js";
import type { EntryType, Agent, RefInput } from "../tools/add.js";

// ------------------------------------------------------------
// Arg parsing
// ------------------------------------------------------------
function parseArgs(argv: string[]): {
  source: IngestSource;
  task?: string;
  module?: string;
  agent?: Agent;
  changed_files?: string[];
  type_hint?: EntryType;
  save: boolean;
  input?: string;
  prompt_chars?: number;
  wall_ms?: number;
  exit_code?: number;
} {
  const out: ReturnType<typeof parseArgs> = {
    source: "codex-dispatch",
    save: false,
  };
  const num = (s: string | undefined): number | undefined => {
    if (s == null) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case "--source":
        out.source = take() as IngestSource;
        break;
      case "--task":
        out.task = take();
        break;
      case "--module":
        out.module = take();
        break;
      case "--agent":
        out.agent = take() as Agent;
        break;
      case "--changed-files":
        out.changed_files = take()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--type-hint":
        out.type_hint = take() as EntryType;
        break;
      case "--save":
        out.save = true;
        break;
      case "--input":
        out.input = take();
        break;
      case "--prompt-chars":
        out.prompt_chars = num(take());
        break;
      case "--wall-ms":
        out.wall_ms = num(take());
        break;
      case "--exit-code":
        out.exit_code = num(take());
        break;
      default:
        // ignore unknown flags for forward-compat
        break;
    }
  }
  return out;
}

// Token usage extracted from Codex JSONL token_count events.
// Codex emits multiple token_count events per turn; total_token_usage is
// cumulative, so the LAST event in the stream is the final dispatch total.
type CodexTokens = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

function extractTokenUsage(jsonl: string): CodexTokens | null {
  let last: CodexTokens | null = null;
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Two known shapes:
    //   1) session rollouts:  { type: "event_msg", payload: { type: "token_count", info: {...} } }
    //   2) `codex exec --json`: { type: "token_count", info: {...} } OR nested via item.completed
    const payload =
      event?.payload?.type === "token_count" ? event.payload :
      event?.type === "token_count" ? event : null;
    const usage = payload?.info?.total_token_usage;
    if (usage && typeof usage.total_tokens === "number") {
      last = {
        input_tokens: usage.input_tokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      };
    }
  }
  return last;
}

// ------------------------------------------------------------
// JSONL extractor — mirrors the Python logic in codex-dispatch.sh
// ------------------------------------------------------------
function extractFromJsonl(jsonl: string): string {
  const messages: string[] = [];
  const toolLog: string[] = [];
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "item.completed") {
      const item = event.item ?? {};
      if (item.type === "agent_message") {
        const text = typeof item.text === "string" ? item.text : "";
        if (text) messages.push(text);
      } else if (item.type === "tool_call") {
        const tool = item.tool ?? "unknown";
        const status = item.status ?? "";
        toolLog.push(`[Tool: ${tool}] ${status}`);
      }
    }
  }
  const parts: string[] = [];
  if (messages.length > 0) parts.push(messages.join("\n\n"));
  if (toolLog.length > 0) parts.push("\n--- Tool calls ---\n" + toolLog.join("\n"));
  return parts.join("\n").trim();
}

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const rawInput = args.input ? readFileSync(args.input, "utf-8") : readStdinSync();
const rawText = extractFromJsonl(rawInput) || rawInput.trim();
const tokenUsage = extractTokenUsage(rawInput);

if (!rawText) {
  console.error("[parse-codex-output] no input text; provide JSONL on stdin or via --input");
  process.exit(1);
}

const context: IngestContext = {
  task_id: args.task,
  module: args.module,
  agent: args.agent ?? "Codex",
  changed_files: args.changed_files,
  type_hint: args.type_hint,
};

const ingestArgs: IngestArgs = {
  source: args.source,
  raw_text: rawText,
  context,
};

const result = parseIntoDraft(ingestArgs);

if (!args.save) {
  // Emit draft JSON on stdout for downstream piping / human review
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// --save: print a human-readable summary to stderr, persist via addEntry,
// and print {id, confidence} JSON on stdout for programmatic callers.
process.stderr.write("=== Codex Results ===\n");
process.stderr.write(rawText + "\n\n");

const db = getDb();
migrate(db);

const refs: RefInput[] | undefined = result.draft_entry.refs;
const saved = addEntry(db, {
  type: result.draft_entry.type,
  title: result.draft_entry.title,
  summary: result.draft_entry.summary,
  description: result.draft_entry.description,
  agent: result.draft_entry.agent,
  module: result.draft_entry.module,
  task_id: result.draft_entry.task_id,
  refs,
});

process.stderr.write(
  `=== Saved to collab.db ===\n` +
    `  id:         ${saved.id}\n` +
    `  type:       ${result.draft_entry.type}\n` +
    `  title:      ${result.draft_entry.title}\n` +
    `  module:     ${result.draft_entry.module ?? "(none)"}\n` +
    `  task:       ${result.draft_entry.task_id ?? "(none)"}\n` +
    `  confidence: ${result.confidence}\n`,
);

// Persist dispatch metrics if any of (token usage | wall-clock | prompt-chars)
// were provided. All fields are optional individually; backward-compatible
// with old call sites that pass none of the new flags.
let dispatchId: number | null = null;
const haveDispatchSignal =
  tokenUsage !== null ||
  args.wall_ms !== undefined ||
  args.prompt_chars !== undefined ||
  args.exit_code !== undefined;

if (haveDispatchSignal && (args.agent ?? "Codex") !== "Claude" && (args.agent ?? "Codex") !== "User") {
  const promptChars = args.prompt_chars ?? 0;
  const promptTokensEst = Math.ceil(promptChars / 4);
  const dispatchAgent = args.agent ?? "Codex";
  const stmt = db.prepare(`
    INSERT INTO dispatches (
      entry_id, agent, prompt_chars, prompt_tokens_est,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
      wall_clock_ms, exit_code, module, task_id, source
    ) VALUES (
      @entry_id, @agent, @prompt_chars, @prompt_tokens_est,
      @input_tokens, @cached_input_tokens, @output_tokens, @reasoning_tokens, @total_tokens,
      @wall_clock_ms, @exit_code, @module, @task_id, @source
    )
  `);
  const info = stmt.run({
    entry_id: saved.id,
    agent: dispatchAgent,
    prompt_chars: promptChars,
    prompt_tokens_est: promptTokensEst,
    input_tokens: tokenUsage?.input_tokens ?? null,
    cached_input_tokens: tokenUsage?.cached_input_tokens ?? null,
    output_tokens: tokenUsage?.output_tokens ?? null,
    reasoning_tokens: tokenUsage?.reasoning_output_tokens ?? null,
    total_tokens: tokenUsage?.total_tokens ?? null,
    wall_clock_ms: args.wall_ms ?? 0,
    exit_code: args.exit_code ?? 0,
    module: result.draft_entry.module ?? null,
    task_id: result.draft_entry.task_id ?? null,
    source: args.source,
  });
  dispatchId = Number(info.lastInsertRowid);
  const net = (tokenUsage?.output_tokens ?? 0) - promptTokensEst;
  process.stderr.write(
    `=== Dispatch metrics ===\n` +
      `  dispatch_id:   ${dispatchId}\n` +
      `  prompt_tokens: ~${promptTokensEst} (${promptChars} chars)\n` +
      `  output_tokens: ${tokenUsage?.output_tokens ?? "n/a"}\n` +
      `  net (B):       ${tokenUsage ? net : "n/a"}\n` +
      `  wall_ms:       ${args.wall_ms ?? 0}\n`,
  );
}

console.log(
  JSON.stringify(
    { id: saved.id, dispatch_id: dispatchId, confidence: result.confidence },
    null,
    2,
  ),
);
closeDb();
