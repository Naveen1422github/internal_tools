import assert from "node:assert/strict";

import { describe, it } from "./harness.js";
import {
  extractCodeBlocks,
  extractFilesRead,
  parseLocateMatches,
  stripAnsi,
} from "../dist/output-parser.js";

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    const input = "\u001b[31mred\u001b[0m";
    assert.equal(stripAnsi(input), "red");
  });
});

describe("extractFilesRead", () => {
  it("extracts Reading: paths", () => {
    const text = "Reading: src/foo.ts\nReading: src/bar.ts";
    assert.deepEqual(extractFilesRead(text), ["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts comma-separated lists", () => {
    const text = "I read the following files: a.ts, b.ts";
    assert.deepEqual(extractFilesRead(text), ["a.ts", "b.ts"]);
  });

  it("dedupes results", () => {
    const text = "Reading: a.ts\nI read the following files: a.ts, b.ts";
    assert.deepEqual(extractFilesRead(text), ["a.ts", "b.ts"]);
  });

  it("returns [] when no patterns are present", () => {
    assert.deepEqual(extractFilesRead("nothing here"), []);
  });
});

describe("extractCodeBlocks", () => {
  it("extracts triple-backtick fences", () => {
    const text = [
      "before",
      "```ts",
      "const x = 1;",
      "```",
      "mid",
      "```",
      "plain",
      "```",
      "after",
    ].join("\n");

    const blocks = extractCodeBlocks(text);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { lang: "ts", content: "const x = 1;" });
    assert.deepEqual(blocks[1], { lang: "", content: "plain" });
  });
});

describe("parseLocateMatches", () => {
  it("extracts path:line references with snippets", () => {
    const text = [
      "src/a.ts:12 doThing()",
      "something else",
      "src/b.ts:3:1 hello",
    ].join("\n");

    const matches = parseLocateMatches(text);
    assert.equal(matches.length, 2);
    assert.deepEqual(matches[0], {
      file: "src/a.ts",
      line: 12,
      snippet: "src/a.ts:12 doThing()",
    });
    assert.deepEqual(matches[1], {
      file: "src/b.ts",
      line: 3,
      snippet: "src/b.ts:3:1 hello",
    });
  });

  it("returns [] on malformed input", () => {
    assert.deepEqual(parseLocateMatches("no refs"), []);
  });
});

