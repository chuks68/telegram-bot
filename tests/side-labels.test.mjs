import assert from "node:assert/strict";
import test from "node:test";

import {
  winnerSideLabel,
  squadSideLabel,
  WINNER_SIDE,
  SQUAD_SIDE,
} from "../dist/stellar/decode.js";

// Documented enum mappings from mimir-market/src/types.rs and mimir-squad/src/types.rs
const EXPECTED_WINNER_SIDE = {
  0: "unresolved",
  1: "creator",
  2: "challengers",
  3: "draw",
  4: "unresolvable",
};

const EXPECTED_SQUAD_SIDE = {
  0: "pending",
  1: "Side A",
  2: "Side B",
  3: "cancelled",
};

test("winnerSideLabel: every known value maps to its documented label", () => {
  for (const [codeStr, expectedLabel] of Object.entries(EXPECTED_WINNER_SIDE)) {
    const code = Number(codeStr);
    assert.equal(WINNER_SIDE[code], expectedLabel);
    assert.equal(winnerSideLabel(code), expectedLabel);
  }
});

test("squadSideLabel: every known value maps to its documented label", () => {
  for (const [codeStr, expectedLabel] of Object.entries(EXPECTED_SQUAD_SIDE)) {
    const code = Number(codeStr);
    assert.equal(SQUAD_SIDE[code], expectedLabel);
    assert.equal(squadSideLabel(code), expectedLabel);
  }
});

test("winnerSideLabel: unknown values never throw and produce a stable fallback label including raw number", () => {
  const unknownInputs = [-1, 99, NaN];

  for (const input of unknownInputs) {
    let result;
    assert.doesNotThrow(() => {
      result = winnerSideLabel(input);
    });

    assert.equal(typeof result, "string");
    // Assert stable fallback format: "side <input>"
    assert.equal(result, `side ${input}`);
    assert.ok(result.includes(String(input)));
  }
});

test("squadSideLabel: unknown values never throw and produce a stable fallback label including raw number", () => {
  const unknownInputs = [-1, 99, NaN];

  for (const input of unknownInputs) {
    let result;
    assert.doesNotThrow(() => {
      result = squadSideLabel(input);
    });

    assert.equal(typeof result, "string");
    // Assert stable fallback format: "side <input>"
    assert.equal(result, `side ${input}`);
    assert.ok(result.includes(String(input)));
  }
});
