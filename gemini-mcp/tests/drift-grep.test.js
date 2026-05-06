import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "./harness.js";

import { scanForDrift } from "../dist/drift-grep.js";

const allowlist = JSON.parse(
  readFileSync(new URL("../drift-allowlist.json", import.meta.url), "utf8"),
);

describe("scanForDrift", () => {
  it("flags at-mention path pattern", () => {
    const text = ["ok", "check @some/path for details"].join("\n");
    const warnings = scanForDrift(text, allowlist);
    assert.ok(warnings.length > 0);
    assert.equal(warnings[0]?.pattern, "@\\w+[\\\\/]");
    assert.equal(warnings[0]?.line, 2);
    assert.ok(warnings[0]?.context.includes("@some/"));
  });

  it("flags temaplates typo", () => {
    const text = ["a", "temaplates folder", "c"].join("\n");
    const warnings = scanForDrift(text, allowlist);
    assert.ok(warnings.some((w) => w.pattern === "temaplates"));
    const w = warnings.find((x) => x.pattern === "temaplates");
    assert.equal(w?.line, 2);
    assert.ok(w?.context.includes("temaplates"));
  });

  it("flags unknown emp1st-* service name", () => {
    const text = "use emp1st-fakeservice/src/index.ts";
    const warnings = scanForDrift(text, allowlist);
    assert.ok(warnings.some((w) => w.pattern === "emp1st_unknown"));
    const w = warnings.find((x) => x.pattern === "emp1st_unknown");
    assert.equal(w?.line, 1);
    assert.ok(w?.context.includes("emp1st-fakeservice"));
  });

  it("does not flag known emp1st-* service name", () => {
    const text = "use emp1st-leave-service/src/index.ts";
    const warnings = scanForDrift(text, allowlist);
    assert.ok(!warnings.some((w) => w.pattern === "emp1st_unknown"));
  });

  it("flags unknown ingxt-* app name", () => {
    const text = "the ingxt-foo app";
    const warnings = scanForDrift(text, allowlist);
    assert.ok(warnings.some((w) => w.pattern === "ingxt_unknown"));
    const w = warnings.find((x) => x.pattern === "ingxt_unknown");
    assert.equal(w?.line, 1);
    assert.ok(w?.context.includes("ingxt-foo"));
  });

  it("returns empty result for clean text", () => {
    const text = "everything is fine";
    assert.deepEqual(scanForDrift(text, allowlist), []);
  });
});
