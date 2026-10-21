import assert from "node:assert/strict";
import test from "node:test";

import { normalizeContractVersion } from "../dist/stellar/decode.js";

test("normalizeContractVersion maps undefined to default decoder key v1", () => {
  assert.equal(normalizeContractVersion(undefined), "v1");
});

test("normalizeContractVersion maps empty string to default decoder key v1", () => {
  assert.equal(normalizeContractVersion(""), "v1");
});

test("normalizeContractVersion maps v1 to decoder key v1", () => {
  assert.equal(normalizeContractVersion("v1"), "v1");
});

test("normalizeContractVersion maps V2 to normalized decoder key v2", () => {
  assert.equal(normalizeContractVersion("V2"), "v2");
});

test("normalizeContractVersion maps 2 to decoder key 2", () => {
  assert.equal(normalizeContractVersion("2"), "2");
});

test("normalizeContractVersion maps v2 to decoder key v2", () => {
  assert.equal(normalizeContractVersion("v2"), "v2");
});

test("normalizeContractVersion maps an unknown value to lowercased string key", () => {
  assert.equal(normalizeContractVersion("unknown"), "unknown");
  assert.equal(normalizeContractVersion("v3"), "v3");
});

test("normalizeContractVersion test matrix asserts exact returned string for all required cases", () => {
  const cases = [
    { input: undefined, expected: "v1" },
    { input: "", expected: "v1" },
    { input: "v1", expected: "v1" },
    { input: "V2", expected: "v2" },
    { input: "2", expected: "2" },
    { input: "v2", expected: "v2" },
    { input: "unknown", expected: "unknown" },
  ];

  for (const { input, expected } of cases) {
    const actual = normalizeContractVersion(input);
    assert.strictEqual(
      actual,
      expected,
      `Expected normalizeContractVersion(${JSON.stringify(input)}) to be "${expected}", got "${actual}"`
    );
  }
});
