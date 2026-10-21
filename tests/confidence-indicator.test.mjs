import assert from "node:assert/strict";
import test from "node:test";

import {
  confidenceIndicator,
  CONFIDENCE_BAR_STEPS,
  CONFIDENCE_BAR_FILLED,
  CONFIDENCE_BAR_EMPTY,
} from "../dist/notifications/confidence.js";

const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/;

test("confidence indicator bar characters are not MarkdownV2 reserved characters", () => {
  assert.equal(MDV2_RESERVED.test(CONFIDENCE_BAR_FILLED), false, "filled bar char must not be reserved in MarkdownV2");
  assert.equal(MDV2_RESERVED.test(CONFIDENCE_BAR_EMPTY), false, "empty bar char must not be reserved in MarkdownV2");
  assert.equal(CONFIDENCE_BAR_STEPS, 10);
});

test("confidenceIndicator: 0 renders all empty steps and 0%", () => {
  const result = confidenceIndicator(0);
  assert.equal(result, "░░░░░░░░░░ 0%");
  assert.equal(result.includes("(raw:"), false);
});

test("confidenceIndicator: 50 renders 5 filled steps and 50%", () => {
  const result = confidenceIndicator(50);
  assert.equal(result, "█████░░░░░ 50%");
  assert.equal(result.includes("(raw:"), false);
});

test("confidenceIndicator: 100 renders 10 filled steps and 100%", () => {
  const result = confidenceIndicator(100);
  assert.equal(result, "██████████ 100%");
  assert.equal(result.includes("(raw:"), false);
});

test("confidenceIndicator: -5 clamps to 0% and flags raw value suffix", () => {
  const result = confidenceIndicator(-5);
  assert.equal(result, "░░░░░░░░░░ 0% (raw: -5)");
});

test("confidenceIndicator: 250 clamps to 100% and flags raw value suffix", () => {
  const result = confidenceIndicator(250);
  assert.equal(result, "██████████ 100% (raw: 250)");
});

test("confidenceIndicator: NaN handles safely with empty bar and raw suffix", () => {
  const result = confidenceIndicator(NaN);
  assert.equal(result, "░░░░░░░░░░ 0% (raw: NaN)");
});

test("confidenceIndicator: non-integer values within range are handled and rendered", () => {
  const result1 = confidenceIndicator(73.4);
  assert.equal(result1, "███████░░░ 73.4%");

  const result2 = confidenceIndicator(25.5);
  assert.equal(result2, "███░░░░░░░ 25.5%");
});

test("confidenceIndicator: non-integer out-of-range values flag raw suffix", () => {
  const result = confidenceIndicator(-0.5);
  assert.equal(result, "░░░░░░░░░░ 0% (raw: -0.5)");

  const result2 = confidenceIndicator(105.2);
  assert.equal(result2, "██████████ 100% (raw: 105.2)");
});
