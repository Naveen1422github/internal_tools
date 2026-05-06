import { readdirSync } from "node:fs";
import process from "node:process";

import { getTests } from "./harness.js";

const testDir = new URL(".", import.meta.url);
const testFiles = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => new URL(f, testDir));

for (const fileUrl of testFiles) {
  await import(fileUrl.href);
}

let failed = 0;
for (const { name, fn } of getTests()) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`not ok - ${name}\n`);
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    process.stdout.write(`${msg}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} test(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${getTests().length} test(s) passed.\n`);
}
