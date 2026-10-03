#!/usr/bin/env node
// Reads codex-dispatch.sh output (mixed: script-echo + codex JSONL) on stdin
// and prints a clean, milestone-only stream. Full output is kept on disk
// by the wrapper that invokes this filter.
//
// Filtering rules:
//   - Non-JSON lines (the script's own ANSI banners) pass through untouched
//   - JSON lines are matched on `type` (or `msg.type`), only the listed
//     event kinds render; all others are dropped silently.
//
// To customise what gets shown, edit the SHOWN object below.

import readline from "node:readline";

const C = {
  reset: "\x1b[0m", dim: "\x1b[90m",
  cyan:  "\x1b[36m", yellow: "\x1b[33m",
  green: "\x1b[32m", red:    "\x1b[31m",
  magenta: "\x1b[35m", bold: "\x1b[1m",
};

const trunc = (s, n = 240) => (s ?? "").length > n ? s.slice(0, n) + "…" : s;

const handlers = {
  agent_message: (e) => {
    const msg = e.msg?.message ?? e.message ?? "";
    console.log(`${C.cyan}▌ AGENT${C.reset} ${trunc(msg, 400)}`);
  },
  exec_command_begin: (e) => {
    const cmd = e.msg?.command ?? e.command ?? [];
    const cwd = e.msg?.cwd ?? e.cwd ?? "";
    const cwdHint = cwd ? `${C.dim}(${cwd})${C.reset} ` : "";
    console.log(`${C.yellow}▌ EXEC${C.reset} ${cwdHint}${trunc(cmd.join(" "), 200)}`);
  },
  exec_command_end: (e) => {
    const code = e.msg?.exit_code ?? e.exit_code;
    const colour = code === 0 ? C.green : C.red;
    console.log(`  ${colour}└─ exit ${code}${C.reset}`);
  },
  patch_apply_begin: (e) => {
    const changes = e.msg?.changes ?? e.changes ?? {};
    for (const [path, v] of Object.entries(changes)) {
      const op = v?.add ? "ADD" : v?.delete ? "DEL" : v?.update ? "UPD" : "EDIT";
      console.log(`${C.magenta}▌ ${op}${C.reset} ${path}`);
    }
  },
  patch_apply_end: (e) => {
    const ok = e.msg?.success ?? e.success;
    if (ok === false) console.log(`  ${C.red}└─ patch FAILED${C.reset}`);
  },
  task_started: () => console.log(`${C.dim}▌ task_started${C.reset}`),
  task_complete: (e) => {
    const msg = e.msg?.last_agent_message ?? e.last_agent_message ?? "";
    console.log(`${C.green}${C.bold}▌ TASK COMPLETE${C.reset}`);
    if (msg) console.log(`  ${trunc(msg, 600)}`);
  },
  error: (e) => {
    const msg = e.msg?.message ?? e.message ?? JSON.stringify(e);
    console.log(`${C.red}▌ ERROR${C.reset} ${trunc(msg, 400)}`);
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t.startsWith("{")) { console.log(line); return; }
  let e;
  try { e = JSON.parse(t); } catch { return; }
  const type = e.type ?? e.msg?.type;
  const h = handlers[type];
  if (h) h(e);
});
