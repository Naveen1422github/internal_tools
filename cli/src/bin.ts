#!/usr/bin/env node
import { main } from "./main.js";

const r = await main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
if (r.stop) {
  const stop = () => { void r.stop!().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  process.exitCode = r.code;
}
