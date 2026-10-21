import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidThresholdError,
  meetsThreshold,
  parseUsdcThreshold,
} from "../dist/notifications/amount-threshold.js";

test("parseUsdcThreshold: parses whole integer USDC amounts (positive)", () => {
  assert.equal(parseUsdcThreshold("0"), 0n);
  assert.equal(parseUsdcThreshold("1"), 10_000_000n);
  assert.equal(parseUsdcThreshold("10"), 100_000_000n);
  assert.equal(parseUsdcThreshold("100"), 1_000_000_000n);
  assert.equal(parseUsdcThreshold("  25  "), 250_000_000n);
});

test("parseUsdcThreshold: parses fractional USDC amounts up to 7 decimals (positive)", () => {
  assert.equal(parseUsdcThreshold("0.5"), 5_000_000n);
  assert.equal(parseUsdcThreshold("0.05"), 500_000n);
  assert.equal(parseUsdcThreshold("0.0000001"), 1n);
  assert.equal(parseUsdcThreshold("1.0000001"), 10_000_001n);
  assert.equal(parseUsdcThreshold("123.4567890"), 1_234_567_890n);
  assert.equal(parseUsdcThreshold("0.1234567"), 1_234_567n);
});

test("parseUsdcThreshold: rejects negative amounts with InvalidThresholdError (negative)", () => {
  assert.throws(
    () => parseUsdcThreshold("-1"),
    (err) => err instanceof InvalidThresholdError && /negative/.test(err.message),
  );
  assert.throws(
    () => parseUsdcThreshold("-0.5"),
    (err) => err instanceof InvalidThresholdError && /negative/.test(err.message),
  );
  assert.throws(
    () => parseUsdcThreshold("  -10  "),
    (err) => err instanceof InvalidThresholdError && /negative/.test(err.message),
  );
});

test("parseUsdcThreshold: rejects malformed and non-decimal input (negative)", () => {
  const malformedInputs = [
    "",
    "   ",
    "abc",
    "12a3",
    "+5",
    "1.2.3",
    ".5",
    "5.",
    "1e6",
    "0x10",
    "NaN",
    "Infinity",
  ];

  for (const input of malformedInputs) {
    assert.throws(
      () => parseUsdcThreshold(input),
      (err) => err instanceof InvalidThresholdError,
      `Expected InvalidThresholdError for input: "${input}"`,
    );
  }
});

test("parseUsdcThreshold: rejects precision beyond 7 decimals (negative)", () => {
  assert.throws(
    () => parseUsdcThreshold("0.00000001"),
    (err) => err instanceof InvalidThresholdError && /precision/.test(err.message),
  );
  assert.throws(
    () => parseUsdcThreshold("1.12345678"),
    (err) => err instanceof InvalidThresholdError && /precision/.test(err.message),
  );
});

// Helper to construct a mock DecodedEvent
function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    version: "v1",
    ledger: 1000,
    txHash: "0000000000000000000000000000000000000000000000000000000000000000",
    at: 1700000000,
    eventId: "1000-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("meetsThreshold: 0 or unset means no filtering (boundary)", () => {
  const challengeEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 5_000_000n, // 0.5 USDC
  });

  const depositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: 1_000_000n, // 0.1 USDC
    shares: 1_000_000n,
  });

  // When thresholds object is undefined
  assert.equal(meetsThreshold(challengeEvent, undefined), true);
  assert.equal(meetsThreshold(depositEvent, undefined), true);

  // When thresholds are empty object / unset
  assert.equal(meetsThreshold(challengeEvent, {}), true);
  assert.equal(meetsThreshold(depositEvent, {}), true);

  // When thresholds are 0n
  assert.equal(
    meetsThreshold(challengeEvent, { marketChallenge: 0n, squadDeposit: 0n }),
    true,
  );
  assert.equal(
    meetsThreshold(depositEvent, { marketChallenge: 0n, squadDeposit: 0n }),
    true,
  );
});

test("meetsThreshold: filters market claim_challenged by stake (positive/boundary)", () => {
  const threshold = 10_000_000n; // 1 USDC
  const thresholds = { marketChallenge: threshold };

  const lowStakeEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 9_999_999n,
  });

  const exactStakeEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 10_000_000n,
  });

  const highStakeEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 20_000_000n,
  });

  assert.equal(meetsThreshold(lowStakeEvent, thresholds), false);
  assert.equal(meetsThreshold(exactStakeEvent, thresholds), true);
  assert.equal(meetsThreshold(highStakeEvent, thresholds), true);
});

test("meetsThreshold: filters squad deposited by amount (positive/boundary)", () => {
  const threshold = 50_000_000n; // 5 USDC
  const thresholds = { squadDeposit: threshold };

  const lowDepositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: 49_999_999n,
    shares: 49_999_999n,
  });

  const exactDepositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: 50_000_000n,
    shares: 50_000_000n,
  });

  const highDepositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: 100_000_000n,
    shares: 100_000_000n,
  });

  assert.equal(meetsThreshold(lowDepositEvent, thresholds), false);
  assert.equal(meetsThreshold(exactDepositEvent, thresholds), true);
  assert.equal(meetsThreshold(highDepositEvent, thresholds), true);
});

test("meetsThreshold: supports separate thresholds independently (positive)", () => {
  const thresholds = {
    marketChallenge: 10_000_000n, // 1 USDC
    squadDeposit: 50_000_000n,    // 5 USDC
  };

  const challengeEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 15_000_000n, // meets 1 USDC
  });

  const depositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: 20_000_000n, // fails 5 USDC
    shares: 20_000_000n,
  });

  assert.equal(meetsThreshold(challengeEvent, thresholds), true);
  assert.equal(meetsThreshold(depositEvent, thresholds), false);
});

test("meetsThreshold: other events always pass regardless of thresholds (boundary)", () => {
  const thresholds = {
    marketChallenge: 1_000_000_000n,
    squadDeposit: 1_000_000_000n,
  };

  const otherEvents = [
    mockEvent("market", {
      name: "claim_created",
      claimId: 1,
      creator: "G...",
      description: "test",
      deadline: 1700000000,
    }),
    mockEvent("market", {
      name: "claim_resolved",
      claimId: 1,
      side: 1,
    }),
    mockEvent("market", {
      name: "market_settled",
      marketId: 1,
      settledAt: 1700000000,
    }),
    mockEvent("squad", {
      name: "market_created",
      marketId: 1,
      name: "Squad A",
      metadata: "{}",
    }),
    mockEvent("squad", {
      name: "withdrawn",
      marketId: 1,
      participant: "G...",
      amount: 1n,
    }),
    mockEvent("squad", {
      name: "resolved",
      marketId: 1,
      winner: 1,
    }),
    mockEvent("market", {
      name: "unknown",
      eventName: "some_future_event",
    }),
  ];

  for (const event of otherEvents) {
    assert.equal(
      meetsThreshold(event, thresholds),
      true,
      `Event "${event.payload.name}" should always pass threshold`,
    );
  }
});
