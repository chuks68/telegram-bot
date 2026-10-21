import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as exitCodes from "../dist/exitCodes.js";

const sourcePath = new URL("../src/exitCodes.ts", import.meta.url);
const source = await readFile(sourcePath, "utf8");

// Extract all comment blocks (/* ... */ and // ...) from src/exitCodes.ts
const commentBlocks = (
  source.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? []
).join("\n");

const exitEntries = Object.entries(exitCodes).filter(([name]) =>
  name.startsWith("EXIT_"),
);

test("dist/exitCodes.js exports EXIT_* constants", () => {
  assert.ok(
    exitEntries.length > 0,
    "Expected at least one EXIT_* export from dist/exitCodes.js",
  );
});

test("every EXIT_* export is an integer in 0-125", () => {
  for (const [name, value] of exitEntries) {
    assert.equal(
      typeof value,
      "number",
      `${name} must be a number, got ${typeof value}`,
    );
    assert.ok(
      Number.isInteger(value),
      `${name} must be an integer, got ${value}`,
    );
    assert.ok(
      value >= 0 && value <= 125,
      `${name} must be in range 0-125, got ${value}`,
    );
  }
});

test("every EXIT_* export has a unique value", () => {
  const seen = new Map();
  for (const [name, value] of exitEntries) {
    assert.ok(
      !seen.has(value),
      `Duplicate exit code ${value} shared by ${seen.get(value)} and ${name}`,
    );
    seen.set(value, name);
  }
});

test("every EXIT_* constant name is documented in src/exitCodes.ts comment block", () => {
  assert.ok(
    commentBlocks.length > 0,
    "Expected header comment block in src/exitCodes.ts",
  );
  for (const [name] of exitEntries) {
    const pattern = new RegExp(`\\b${name}\\b`);
    assert.match(
      commentBlocks,
      pattern,
      `${name} is not documented in src/exitCodes.ts comment block`,
    );
  }
});
