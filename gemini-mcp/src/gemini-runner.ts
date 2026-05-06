/**
 * Context files flag: Gemini CLI doesn't expose a dedicated `--context-files` flag.
 * Instead, it supports `--prompt` (`-p`) and uses `@path` references *inside the prompt*
 * to explicitly load file contents. This runner prefixes the prompt with `@<file>`
 * lines when `contextFiles` is provided.
 */

import { spawn } from "node:child_process";

import type { RunnerError } from "./types.js";

export async function runGemini(args: {
  prompt: string;
  contextFiles?: string[];
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ stdout: string; stderr: string; durationMs: number } | RunnerError> {
  const startedAt = Date.now();

  const bin =
    process.env["GEMINI_BIN"] ||
    (process.platform === "win32" ? "gemini.cmd" : "gemini");
  const timeoutMs = args.timeoutMs ?? defaultTimeoutMs();

  const onProgress = args.onProgress;
  const contextFiles = (args.contextFiles || []).filter(Boolean);
  const prompt =
    contextFiles.length > 0
      ? `${contextFiles.map((p) => `@${p}`).join("\n")}\n\n${args.prompt}`
      : args.prompt;

  onProgress?.("Spawning Gemini…");

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let sawStdout = false;
    let settled = false;

    // Windows quirk: Node's spawn can't execute .cmd/.bat shims directly via
    // CreateProcess — those need cmd.exe to interpret them. shell:true makes
    // Node spawn `cmd.exe /d /s /c "<joined args>"`. Because shell:true joins
    // args with spaces, we must explicitly quote the prompt for cmd.exe.
    const isWindows = process.platform === "win32";
    const promptArg = isWindows
      ? `"${prompt.replace(/"/g, '\\"')}"`
      : prompt;

    const child = spawn(
      bin,
      ["--output-format", "text", "--prompt", promptArg],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
      },
    );

    const hardTimeout = setTimeout(() => {
      if (settled) return;
      stdout = stdout || "";
      try {
        child.kill("SIGTERM");
      } catch {
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 5000);
      killTimer.unref?.();

      settled = true;
      resolve({
        error: "timeout",
        partial_output: stdout,
        suggestion: "consider gemini-dispatch.sh for longer runs",
      });
    }, timeoutMs);

    hardTimeout.unref?.();

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      clearTimeout(hardTimeout);
      settled = true;
      if (err.code === "ENOENT") {
        resolve({ error: "cli_not_found" });
        return;
      }
      resolve({ error: "nonzero_exit", partial_output: stdout });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!sawStdout) {
        sawStdout = true;
        onProgress?.("Gemini reading files…");
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(hardTimeout);
      settled = true;

      if (code && code !== 0) {
        resolve({ error: "nonzero_exit", partial_output: stdout });
        return;
      }

      resolve({
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function defaultTimeoutMs(): number {
  const raw = process.env["GEMINI_MCP_TIMEOUT_MS"] || "180000";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 180000;
}

