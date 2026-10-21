import { test } from "node:test";
import assert from "node:assert";
import {
  parseLogLevel,
  parseLogFormat,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_FORMAT,
  LOG_LEVELS,
  LOG_FORMATS,
} from "../src/logger.js";

test("parseLogLevel resolves valid and invalid inputs", () => {
  const cases = [
    { description: "lowercase known level", input: "warn", expected: "WARN" },
    { description: "uppercase known level", input: "WARN", expected: "WARN" },
    { description: "mixed case known level", input: "Info", expected: "INFO" },
    { description: "whitespace around known level", input: " debug ", expected: "DEBUG" },
    { description: "unknown verbose level", input: "verbose", expected: DEFAULT_LOG_LEVEL },
    { description: "numeric zero", input: 0, expected: DEFAULT_LOG_LEVEL },
    { description: "null", input: null, expected: DEFAULT_LOG_LEVEL },
    { description: "undefined", input: undefined, expected: DEFAULT_LOG_LEVEL },
  ];

  for (const { description, input, expected } of cases) {
    assert.strictEqual(parseLogLevel(input), expected, description);
  }
});

test("parseLogLevel returns a valid level for every input", () => {
  const inputs = ["WARN", " JSON ", "verbose", 0, null, undefined];
  for (const input of inputs) {
    assert.ok(LOG_LEVELS.includes(parseLogLevel(input)), `${String(input)} should resolve to a known level`);
  }
});

test("parseLogFormat resolves valid and invalid inputs", () => {
  const cases = [
    { description: "lowercase known format", input: "json", expected: "JSON" },
    { description: "uppercase known format", input: "JSON", expected: "JSON" },
    { description: "whitespace around known format", input: " json ", expected: "JSON" },
    { description: "mixed case known format", input: "Pretty", expected: "PRETTY" },
    { description: "unknown verbose format", input: "verbose", expected: DEFAULT_LOG_FORMAT },
    { description: "numeric zero", input: 0, expected: DEFAULT_LOG_FORMAT },
    { description: "null", input: null, expected: DEFAULT_LOG_FORMAT },
    { description: "undefined", input: undefined, expected: DEFAULT_LOG_FORMAT },
  ];

  for (const { description, input, expected } of cases) {
    assert.strictEqual(parseLogFormat(input), expected, description);
  }
});

test("parseLogFormat returns a valid format for every input", () => {
  const inputs = ["WARN", " JSON ", "verbose", 0, null, undefined];
  for (const input of inputs) {
    assert.ok(LOG_FORMATS.includes(parseLogFormat(input)), `${String(input)} should resolve to a known format`);
  }
});
