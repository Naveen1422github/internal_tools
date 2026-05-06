#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { scanForDrift } from "./drift-grep.js";
import { runGemini } from "./gemini-runner.js";
import { extractFilesRead, parseLocateMatches } from "./output-parser.js";
import type { RunnerError } from "./types.js";

type Allowlist = { emp1st_prefixes: string[]; ingxt_prefixes: string[] };

const server = new McpServer({
  name: "gemini-mcp",
  version: "0.1.0",
});

const structured = <T>(v: T): Record<string, unknown> =>
  v as unknown as Record<string, unknown>;

function loadAllowlist(): Allowlist {
  const raw = readFileSync(new URL("../drift-allowlist.json", import.meta.url), "utf8");
  return JSON.parse(raw) as Allowlist;
}

function makeProgress(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ServerNotification) => Promise<void>;
}) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return (_msg: string) => {};
  let progress = 0;
  return (message: string) => {
    progress += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, message },
      } as unknown as ServerNotification)
      .catch(() => {
        // Swallow notification failures — they should never crash the server.
        // Common cause: client disconnected mid-call, or transport closed.
      });
  };
}

process.on("unhandledRejection", (reason) => {
  console.error("[gemini-mcp] unhandledRejection:", reason);
});

function isRunnerError(
  v: { stdout: string; stderr: string; durationMs: number } | RunnerError,
): v is RunnerError {
  return typeof (v as RunnerError).error === "string";
}

// ------------------------------------------------------------
// Tool: gemini_skim
// ------------------------------------------------------------
server.registerTool(
  "gemini_skim",
  {
    title: "Gemini skim",
    description: "Single-shot read-side Gemini query (skim + summarize).",
    inputSchema: {
      prompt: z.string().describe("The question to ask Gemini."),
      context_files: z
        .array(z.string())
        .optional()
        .describe("Optional explicit list of files to include as context."),
      drift_check: z
        .boolean()
        .optional()
        .default(true)
        .describe("Run literal drift-grep after Gemini returns (default true)."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args, extra) => {
    const allowlist = loadAllowlist();
    const onProgress = makeProgress(extra);

    const ran = await runGemini({
      prompt: args.prompt,
      contextFiles: args.context_files,
      onProgress,
    });

    if (isRunnerError(ran)) {
      return {
        content: [{ type: "text", text: `Gemini runner error: ${ran.error}` }],
        structuredContent: structured(ran),
      };
    }

    const filesRead = extractFilesRead(ran.stdout);
    let driftWarnings = [] as ReturnType<typeof scanForDrift>;

    if (args.drift_check !== false) {
      onProgress("Running drift-grep…");
      driftWarnings = scanForDrift(ran.stdout, allowlist);
    }

    const driftNote =
      driftWarnings.length > 0
        ? `⚠ Drift-grep flagged ${driftWarnings.length} literal(s); see drift_warnings.\n\n`
        : "";

    const result = {
      response: `${driftNote}${ran.stdout}`,
      files_read: filesRead,
      drift_warnings: driftWarnings,
      duration_ms: ran.durationMs,
    };

    return {
      content: [{ type: "text", text: result.response }],
      structuredContent: structured(result),
    };
  },
);

// ------------------------------------------------------------
// Tool: gemini_locate
// ------------------------------------------------------------
server.registerTool(
  "gemini_locate",
  {
    title: "Gemini locate",
    description: "Locate where something lives in the repo (best-effort).",
    inputSchema: {
      query: z.string().describe("What to locate in the codebase."),
      scope: z
        .string()
        .optional()
        .describe("Optional path scope/glob to constrain the search."),
      drift_check: z
        .boolean()
        .optional()
        .default(true)
        .describe("Run literal drift-grep after Gemini returns (default true)."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args, extra) => {
    const allowlist = loadAllowlist();
    const onProgress = makeProgress(extra);

    const internalPrompt = `Find all references to '${args.query}' in the codebase${
      args.scope ? ` under ${args.scope}` : ""
    }. Return file:line and a one-line snippet for each match, plus a short summary.`;

    const ran = await runGemini({
      prompt: internalPrompt,
      onProgress,
    });

    if (isRunnerError(ran)) {
      return {
        content: [{ type: "text", text: `Gemini runner error: ${ran.error}` }],
        structuredContent: structured(ran),
      };
    }

    const matches = parseLocateMatches(ran.stdout);
    let driftWarnings = [] as ReturnType<typeof scanForDrift>;

    if (args.drift_check !== false) {
      onProgress("Running drift-grep…");
      driftWarnings = scanForDrift(ran.stdout, allowlist);
    }

    const driftNote =
      driftWarnings.length > 0
        ? `⚠ Drift-grep flagged ${driftWarnings.length} literal(s); see drift_warnings.\n\n`
        : "";

    const result = {
      matches,
      summary: `${driftNote}${ran.stdout}`,
      drift_warnings: driftWarnings,
      duration_ms: ran.durationMs,
    };

    const matchLines =
      matches.length > 0
        ? matches
            .slice(0, 50)
            .map((m) => `- ${m.file}:${m.line} ${m.snippet}`)
            .join("\n")
        : "- (no matches parsed)";

    return {
      content: [{ type: "text", text: `${result.summary}\n\n${matchLines}` }],
      structuredContent: structured(result),
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
