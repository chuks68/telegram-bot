/**
 * Hostile-payload boundary tests for `summarizePayloadForLog`.
 *
 * `summarizePayloadForLog` in `src/stellar/decode.ts` is used when logging
 * unknown and admin events. Because payload strings and nested details come
 * from on-chain contracts, they can carry megabyte-sized strings, embedded
 * newlines, ASCII/C1 control characters, ANSI escape sequences, deeply or
 * arbitrarily ordered nested objects, and huge `bigint` values.
 *
 * These tests guarantee that every summary remains:
 *  - Strictly bounded in length (per-field cap of 240 chars, document cap of 4096 chars)
 *  - Single-line (no `\r`, `\n`, `\u2028`, `\u2029`)
 *  - Free of ASCII/C1 control characters and ANSI terminal escape codes
 *  - Deterministic in key order across top-level and nested objects
 */
import assert from "node:assert/strict";
import test from "node:test";

import { summarizePayloadForLog } from "../dist/stellar/decode.js";

const DEFAULT_MAX_LOG_CHARS = 4_096;
const MAX_FIELD_CHARS = 240;
const CONTROL_OR_NEWLINE_RE = /[\x00-\x1f\x7f-\x9f\r\n\u2028\u2029]/;
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/;

function assertSafeSummary(out, maxLen = DEFAULT_MAX_LOG_CHARS) {
  assert.equal(typeof out, "string");
  assert.ok(
    out.length <= maxLen,
    `expected summary length <= ${maxLen}, got ${out.length}`,
  );
  assert.doesNotMatch(
    out,
    CONTROL_OR_NEWLINE_RE,
    "summary must not contain newlines or control characters",
  );
  assert.doesNotMatch(
    out,
    ANSI_ESCAPE_RE,
    "summary must not contain ANSI escape sequences",
  );
  assert.ok(!out.includes("\\n"), "summary must not contain escaped \\n sequences");
  assert.ok(!out.includes("\\r"), "summary must not contain escaped \\r sequences");
  assert.ok(!out.includes("\\t"), "summary must not contain escaped \\t sequences");
  assert.ok(!out.includes("\\u001b"), "summary must not contain escaped ANSI ESC (\\u001b)");
  assert.ok(!out.includes("\\u0000"), "summary must not contain escaped NUL (\\u0000)");
}

test("1 MB string fields are capped per-field and within total output bound", () => {
  const oneMb = "A".repeat(1024 * 1024);
  const payload = {
    name: "unknown",
    eventName: oneMb,
    reason: oneMb,
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  assert.equal(parsed.name, "unknown");
  assert.equal(parsed.eventName.length, MAX_FIELD_CHARS);
  assert.ok(parsed.eventName.endsWith("…"));
  assert.equal(parsed.reason.length, MAX_FIELD_CHARS);
  assert.ok(parsed.reason.endsWith("…"));
});

test("multi-megabyte payload across many fields is capped at document limit", () => {
  const chunk = "B".repeat(1024 * 1024);
  const details = {};
  for (let i = 0; i < 40; i += 1) {
    details[`field_${String(i).padStart(2, "0")}`] = `${i}_${chunk}`;
  }
  const payload = {
    name: "admin",
    action: "admin_bulk_update",
    details,
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out, DEFAULT_MAX_LOG_CHARS);
  assert.equal(out.length, DEFAULT_MAX_LOG_CHARS);
  assert.ok(out.endsWith("…"));
});

test("newlines and multi-line whitespace are collapsed into single spaces", () => {
  const payload = {
    name: "unknown",
    eventName: "claim_created\nwith\r\ninjected\rFAKE LOG LINE",
    reason: "line1\n\n\t  line2\u2028line3\u2029line4\v\fend",
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  assert.equal(parsed.eventName, "claim_created with injected FAKE LOG LINE");
  assert.equal(parsed.reason, "line1 line2 line3 line4 end");
});

test("ANSI escape sequences and ASCII/C1 control characters are stripped", () => {
  const payload = {
    name: "admin",
    action: "\x1b[31m\x1b[1madmin_override\x1b[0m\x1b[2J\x1b[H",
    details: {
      alert: "normal\x00null\x07bell\x08bs\x1b[32mgreen\x1b[0m\x7fdel\x85next\x9b31mcsi_c1",
      cursorMove: "\x1b[999;999H\x1b[6n\x1bMinjected",
      oscTitle: "\x1b]0;malicious-title\x07safe_value\x1b]2;another\x1b\\",
    },
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  assert.equal(parsed.action, "admin_override");
  assert.equal(parsed.details.alert, "normal null bell bsgreen del next 31mcsi_c1");
  assert.equal(parsed.details.cursorMove, "injected");
  assert.equal(parsed.details.oscTitle, "safe_value");
});

test("nested details objects are sanitized and bounded at every depth", () => {
  const hugeNested = "Z".repeat(1024 * 1024);
  const payload = {
    name: "oracle_changed",
    newOracle: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    details: {
      level1: {
        level2: {
          note: "nested\nmultiline\x1b[33mwarning\x1b[0m\x00text",
          oversized: hugeNested,
          numbers: [1, 2n ** 1000n, "lineA\nlineB\x07"],
        },
      },
    },
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  assert.equal(parsed.details.level1.level2.note, "nested multilinewarning text");
  assert.equal(parsed.details.level1.level2.oversized.length, MAX_FIELD_CHARS);
  assert.ok(parsed.details.level1.level2.oversized.endsWith("…"));
  assert.equal(parsed.details.level1.level2.numbers[0], 1);
  assert.equal(parsed.details.level1.level2.numbers[1].length, MAX_FIELD_CHARS);
  assert.equal(parsed.details.level1.level2.numbers[2], "lineA lineB");
});

test("huge bigints are stringified without throwing and capped to field bound", () => {
  const smallBig = 123_456_789_012_345_678_901_234_567_890n;
  const negativeHugeBig = -(10n ** 10_000n);
  const massiveBig = 10n ** 50_000n;

  const payload = {
    name: "fee_accrued",
    amount: massiveBig,
    details: {
      small: smallBig,
      negativeHuge: negativeHugeBig,
    },
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  assert.equal(parsed.details.small, smallBig.toString());
  assert.equal(parsed.amount.length, MAX_FIELD_CHARS);
  assert.ok(parsed.amount.startsWith("1000000000"));
  assert.ok(parsed.amount.endsWith("…"));
  assert.equal(parsed.details.negativeHuge.length, MAX_FIELD_CHARS);
  assert.ok(parsed.details.negativeHuge.startsWith("-100000000"));
  assert.ok(parsed.details.negativeHuge.endsWith("…"));
});

test("object key order is stable regardless of insertion order across top-level and nested objects", () => {
  const payloadA = {
    reason: "unexpected shape",
    eventName: "claim_created",
    name: "unknown",
    details: {
      zeta: 1,
      alpha: "first",
      middle: {
        d: true,
        a: 10n,
        c: "three",
        b: 2,
      },
    },
  };

  const payloadB = {
    name: "unknown",
    details: {
      middle: {
        a: 10n,
        b: 2,
        c: "three",
        d: true,
      },
      alpha: "first",
      zeta: 1,
    },
    eventName: "claim_created",
    reason: "unexpected shape",
  };

  const outA = summarizePayloadForLog(payloadA);
  const outB = summarizePayloadForLog(payloadB);

  assertSafeSummary(outA);
  assert.equal(outA, outB);

  const parsed = JSON.parse(outA);
  assert.deepEqual(Object.keys(parsed), ["details", "eventName", "name", "reason"]);
  assert.deepEqual(Object.keys(parsed.details), ["alpha", "middle", "zeta"]);
  assert.deepEqual(Object.keys(parsed.details.middle), ["a", "b", "c", "d"]);
});

test("hostile object keys containing newlines, ANSI codes, or huge strings are sanitized", () => {
  const hugeKey = `${"k".repeat(1_000)}\n\x1b[31mboom\x00`;
  const payload = {
    name: "admin",
    action: "custom",
    details: {
      [hugeKey]: "val",
      "key\nwith\tnewlines\x07": 42,
    },
  };

  const out = summarizePayloadForLog(payload);
  assertSafeSummary(out);

  const parsed = JSON.parse(out);
  const detailKeys = Object.keys(parsed.details);
  assert.equal(detailKeys.length, 2);
  for (const key of detailKeys) {
    assert.ok(key.length <= MAX_FIELD_CHARS);
    assert.doesNotMatch(key, CONTROL_OR_NEWLINE_RE);
    assert.doesNotMatch(key, ANSI_ESCAPE_RE);
  }
});
