import assert from "node:assert/strict";
import test from "node:test";

import { parseBoolFlag } from "../dist/notifications/featureFlags.js";

const FLAG_NAME = "NOTIFY_MARKET";

const validCases = [
  ["true", true],
  ["false", false],
  ["1", true],
  ["0", false],
  ["yes", true],
  ["no", false],
  ["on", true],
  ["off", false],
  ["TrUe", true],
  ["FaLsE", false],
  ["YeS", true],
  ["nO", false],
  ["oN", true],
  ["OfF", false],
  [" TRUE ", true],
  ["\tfalse\n", false],
  [" yes\t", true],
  ["\non \t", true],
  [" off ", false],
  [" 0 ", false],
  ["\t1\r", true],
];

for (const [raw, expected] of validCases) {
  test(`parseBoolFlag: ${JSON.stringify(raw)} parses as ${expected}`, () => {
    for (const fallback of [true, false]) {
      assert.deepEqual(
        parseBoolFlag(FLAG_NAME, raw, fallback),
        { value: expected, problems: [] },
        `raw=${JSON.stringify(raw)}, fallback=${fallback}`,
      );
    }
  });
}

for (const raw of [undefined, "", " ", "\t", "\n \t"]) {
  test(`parseBoolFlag: ${JSON.stringify(raw)} uses the fallback`, () => {
    for (const fallback of [true, false]) {
      assert.deepEqual(
        parseBoolFlag(FLAG_NAME, raw, fallback),
        { value: fallback, problems: [] },
        `raw=${JSON.stringify(raw)}, fallback=${fallback}`,
      );
    }
  });
}

const invalidCases = [
  "maybe",
  "2",
  "-1",
  "y",
  "n",
  "enabled",
  "disabled",
  "true-ish",
  "false true",
  "1 0",
  "null",
  "  MAYBE \t",
];

for (const raw of invalidCases) {
  test(`parseBoolFlag: ${JSON.stringify(raw)} reports an exact warning`, () => {
    for (const fallback of [true, false]) {
      assert.deepEqual(
        parseBoolFlag(FLAG_NAME, raw, fallback),
        {
          value: fallback,
          problems: [
            `${FLAG_NAME} must be a boolean (true/false, 1/0, yes/no, on/off); got "${raw.trim()}"`,
          ],
        },
        `raw=${JSON.stringify(raw)}, fallback=${fallback}`,
      );
    }
  });
}

test("parseBoolFlag: invalid warning uses the supplied flag name", () => {
  assert.deepEqual(parseBoolFlag("NOTIFY_SQUAD", "  unknown  ", false), {
    value: false,
    problems: [
      'NOTIFY_SQUAD must be a boolean (true/false, 1/0, yes/no, on/off); got "unknown"',
    ],
  });
});
