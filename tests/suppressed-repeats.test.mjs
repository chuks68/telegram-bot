import assert from "node:assert/strict";
import test from "node:test";

import { formatSuppressedRepeats } from "../dist/log-sampler.js";

test("formatSuppressedRepeats returns empty string when nothing was suppressed", () => {
  assert.equal(formatSuppressedRepeats(0, 1_000), "");
  assert.equal(formatSuppressedRepeats(-1, 60_000), "");
  assert.equal(formatSuppressedRepeats(-42, 300_000), "");
});

test("formatSuppressedRepeats uses singular wording for 1 suppressed repeat across window durations", () => {
  // Below one second (clamped to 1s)
  assert.equal(
    formatSuppressedRepeats(1, 0),
    " (suppressed 1 identical repeat in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 100),
    " (suppressed 1 identical repeat in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 499),
    " (suppressed 1 identical repeat in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 500),
    " (suppressed 1 identical repeat in the previous 1s)",
  );

  // At one second and below one minute
  assert.equal(
    formatSuppressedRepeats(1, 1_000),
    " (suppressed 1 identical repeat in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 1_499),
    " (suppressed 1 identical repeat in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 1_500),
    " (suppressed 1 identical repeat in the previous 2s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 30_000),
    " (suppressed 1 identical repeat in the previous 30s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 59_000),
    " (suppressed 1 identical repeat in the previous 59s)",
  );

  // At and above one minute
  assert.equal(
    formatSuppressedRepeats(1, 60_000),
    " (suppressed 1 identical repeat in the previous 60s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 90_000),
    " (suppressed 1 identical repeat in the previous 90s)",
  );
  assert.equal(
    formatSuppressedRepeats(1, 300_000),
    " (suppressed 1 identical repeat in the previous 300s)",
  );
});

test("formatSuppressedRepeats uses plural wording for many suppressed repeats across window durations", () => {
  // Below one second (clamped to 1s)
  assert.equal(
    formatSuppressedRepeats(2, 1),
    " (suppressed 2 identical repeats in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(5, 250),
    " (suppressed 5 identical repeats in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(10, 999),
    " (suppressed 10 identical repeats in the previous 1s)",
  );

  // At one second and below one minute
  assert.equal(
    formatSuppressedRepeats(2, 1_000),
    " (suppressed 2 identical repeats in the previous 1s)",
  );
  assert.equal(
    formatSuppressedRepeats(3, 5_000),
    " (suppressed 3 identical repeats in the previous 5s)",
  );
  assert.equal(
    formatSuppressedRepeats(42, 30_000),
    " (suppressed 42 identical repeats in the previous 30s)",
  );
  assert.equal(
    formatSuppressedRepeats(99, 59_400),
    " (suppressed 99 identical repeats in the previous 59s)",
  );

  // At and above one minute
  assert.equal(
    formatSuppressedRepeats(2, 60_000),
    " (suppressed 2 identical repeats in the previous 60s)",
  );
  assert.equal(
    formatSuppressedRepeats(15, 120_000),
    " (suppressed 15 identical repeats in the previous 120s)",
  );
  assert.equal(
    formatSuppressedRepeats(100, 300_000),
    " (suppressed 100 identical repeats in the previous 300s)",
  );
});
