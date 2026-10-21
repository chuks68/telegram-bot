import test from "node:test";
import assert from "node:assert";
import { isUsableTxHash } from "../dist/stellar/decode.js";

const VALID_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const cases = [
  { name: "valid 64-hex hash", input: VALID_HASH, expected: true },
  { name: "uppercase hex", input: VALID_HASH.toUpperCase(), expected: true },
  { name: "63 characters", input: VALID_HASH.slice(0, 63), expected: false },
  { name: "65 characters", input: VALID_HASH + "0", expected: false },
  { name: "non-hex characters", input: "z1" + VALID_HASH.slice(2), expected: false },
  { name: "empty string", input: "", expected: false },
  { name: "all-zero hash", input: "0".repeat(64), expected: false },
];

for (const { name, input, expected } of cases) {
  test(`isUsableTxHash: ${name}`, () => {
    assert.strictEqual(isUsableTxHash(input), expected);
  });
}
