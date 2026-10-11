#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main } from "./main.js";
import type { Io } from "./io.js";

/** A yes/no question on the terminal; only offered when stdin is one (collab copy, rule 7). */
async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l), ...(process.stdin.isTTY ? { ask } : {}) };
const r = await main(process.argv.slice(2), io);
if (r.stop) {
  const stop = () => { void r.stop!().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  process.exitCode = r.code;
}
