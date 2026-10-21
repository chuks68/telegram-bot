import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HUGE_THRESHOLD,
  DEFAULT_LARGE_THRESHOLD,
  DEFAULT_MARKERS,
  DEFAULT_THRESHOLDS,
  InvalidMarkerError,
  MDV2_RESERVED,
  USDC_UNIT,
  highlightLevel,
  highlightMarker,
  prefixFirstLine,
  validateMarker,
} from "../dist/notifications/highlights.js";

import {
  formatEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";

const TEST_CONFIG = {
  networkPassphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  marketContractId: "CB...MARKET",
  squadContractId: "CB...SQUAD",
};

function makeMarketEvent(name, payloadOverrides = {}) {
  return {
    source: "market",
    contractId: "CB...MARKET",
    version: "v1",
    ledger: 1000,
    txHash: "a".repeat(64),
    at: 1700000000,
    eventId: "1000-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      ...payloadOverrides,
    },
  };
}

function makeSquadEvent(name, payloadOverrides = {}) {
  return {
    source: "squad",
    contractId: "CB...SQUAD",
    version: "v1",
    ledger: 1000,
    txHash: "a".repeat(64),
    at: 1700000000,
    eventId: "1000-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      ...payloadOverrides,
    },
  };
}

// ── highlightLevel: claim_challenged boundaries ──────────────────────────────

test("highlightLevel: claim_challenged exact boundaries with custom thresholds", () => {
  const thresholds = {
    large: 100n * USDC_UNIT,
    huge: 1000n * USDC_UNIT,
  };

  // Zero & below large
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 0n }), thresholds),
    "none",
  );
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 99n * USDC_UNIT + 9_999_999n }), thresholds),
    "none",
  );

  // Exact large boundary
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 100n * USDC_UNIT }), thresholds),
    "large",
  );

  // Between large and huge
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 100n * USDC_UNIT + 1n }), thresholds),
    "large",
  );
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 999n * USDC_UNIT + 9_999_999n }), thresholds),
    "large",
  );

  // Exact huge boundary
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 1000n * USDC_UNIT }), thresholds),
    "huge",
  );

  // Above huge
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 1000n * USDC_UNIT + 1n }), thresholds),
    "huge",
  );
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 50_000n * USDC_UNIT }), thresholds),
    "huge",
  );
});

// ── highlightLevel: deposited boundaries ─────────────────────────────────────

test("highlightLevel: squad deposited exact boundaries with custom thresholds", () => {
  const thresholds = {
    large: 50n * USDC_UNIT,
    huge: 500n * USDC_UNIT,
  };

  // Zero & below large
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 0n }), thresholds),
    "none",
  );
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 49n * USDC_UNIT + 9_999_999n }), thresholds),
    "none",
  );

  // Exact large boundary
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 50n * USDC_UNIT }), thresholds),
    "large",
  );

  // Between large and huge
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 250n * USDC_UNIT }), thresholds),
    "large",
  );
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 499n * USDC_UNIT + 9_999_999n }), thresholds),
    "large",
  );

  // Exact huge boundary
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 500n * USDC_UNIT }), thresholds),
    "huge",
  );

  // Above huge
  assert.equal(
    highlightLevel(makeSquadEvent("deposited", { amount: 10_000n * USDC_UNIT }), thresholds),
    "huge",
  );
});

// ── highlightLevel: default thresholds in module ─────────────────────────────

test("highlightLevel: uses module default thresholds when thresholds parameter is omitted", () => {
  // Below default large (100 USDC)
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 50n * USDC_UNIT })),
    "none",
  );

  // At default large (100 USDC)
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: DEFAULT_LARGE_THRESHOLD })),
    "large",
  );

  // Between default large (100 USDC) and huge (1,000 USDC)
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 500n * USDC_UNIT })),
    "large",
  );

  // At default huge (1,000 USDC)
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: DEFAULT_HUGE_THRESHOLD })),
    "huge",
  );

  // Above default huge
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 2000n * USDC_UNIT })),
    "huge",
  );
});

test("highlightLevel: falls back to defaults for partial thresholds", () => {
  // Only huge specified
  const thresholdsOnlyHuge = { huge: 200n * USDC_UNIT };
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: DEFAULT_LARGE_THRESHOLD }), thresholdsOnlyHuge),
    "large",
  );
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 200n * USDC_UNIT }), thresholdsOnlyHuge),
    "huge",
  );

  // Only large specified
  const thresholdsOnlyLarge = { large: 10n * USDC_UNIT };
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: 10n * USDC_UNIT }), thresholdsOnlyLarge),
    "large",
  );
  assert.equal(
    highlightLevel(makeMarketEvent("claim_challenged", { stake: DEFAULT_HUGE_THRESHOLD }), thresholdsOnlyLarge),
    "huge",
  );
});

// ── highlightLevel: other event types ────────────────────────────────────────

test("highlightLevel: non-stake/deposit event types always return 'none'", () => {
  const hugeAmount = 1_000_000n * USDC_UNIT;
  const thresholds = { large: 10n * USDC_UNIT, huge: 100n * USDC_UNIT };

  const nonStakeEvents = [
    makeMarketEvent("claim_created", { claimId: 1, creator: "GABC", category: "crypto" }),
    makeMarketEvent("claim_resolved", { claimId: 1, winnerSide: 1, confidence: 95 }),
    makeMarketEvent("claim_cancelled", { claimId: 1 }),
    makeMarketEvent("market_settled", { claimId: 1, totalPaid: hugeAmount, totalFees: hugeAmount, owedToChallengers: hugeAmount }),
    makeMarketEvent("challenger_paid", { claimId: 1, challenger: "GABC", stake: hugeAmount, net: hugeAmount, gross: hugeAmount, fee: 0n }),
    makeMarketEvent("fee_claimed", { amount: hugeAmount, recipient: "GABC" }),
    makeMarketEvent("withdrawal", { amount: hugeAmount, to: "GABC" }),
    makeMarketEvent("withdrawal_pending", { amount: hugeAmount, to: "GABC" }),
    makeSquadEvent("market_created", { marketId: 1, question: "Will it rain?", captain: "GABC", feeBps: 100, deadline: 1700000000 }),
    makeSquadEvent("withdrawn", { marketId: 1, participant: "GABC", amount: hugeAmount, side: 1 }),
    makeSquadEvent("resolved", { marketId: 1, result: 1, poolA: hugeAmount, poolB: hugeAmount }),
    makeSquadEvent("claimed", { marketId: 1, participant: "GABC", net: hugeAmount, gross: hugeAmount, fee: 0n }),
    makeSquadEvent("fees_claimed", { amount: hugeAmount, recipient: "GABC" }),
    makeMarketEvent("oracle_changed", {}),
    makeMarketEvent("admin", {}),
    makeMarketEvent("unknown", { eventName: "some_unrecognized_event" }),
  ];

  for (const event of nonStakeEvents) {
    assert.equal(
      highlightLevel(event, thresholds),
      "none",
      `Event ${event.payload.name} should return 'none'`,
    );
  }
});

// ── highlightLevel: malformed & edge cases ───────────────────────────────────

test("highlightLevel: handles malformed and edge-case events gracefully", () => {
  const thresholds = { large: 10n * USDC_UNIT, huge: 100n * USDC_UNIT };

  assert.equal(highlightLevel(null, thresholds), "none");
  assert.equal(highlightLevel(undefined, thresholds), "none");
  assert.equal(highlightLevel({}, thresholds), "none");
  assert.equal(highlightLevel({ payload: null }, thresholds), "none");
  assert.equal(highlightLevel({ payload: {} }, thresholds), "none");
  assert.equal(highlightLevel(makeMarketEvent("claim_challenged", { stake: -10n * USDC_UNIT }), thresholds), "none");
  assert.equal(highlightLevel(makeMarketEvent("claim_challenged", { stake: "invalid" }), thresholds), "none");
  assert.equal(highlightLevel(makeMarketEvent("claim_challenged", {}), thresholds), "none");
  assert.equal(highlightLevel(makeSquadEvent("deposited", { amount: null }), thresholds), "none");
});

// ── Marker Safety & Acceptance Criteria ──────────────────────────────────────

test("acceptance criteria: default markers contain no MarkdownV2 reserved characters", () => {
  // Telegram MarkdownV2 reserved characters: _*[\]()~`>#+-=|{}.!\
  assert.equal(MDV2_RESERVED.test(DEFAULT_MARKERS.large), false, "Default large marker must not contain reserved chars");
  assert.equal(MDV2_RESERVED.test(DEFAULT_MARKERS.huge), false, "Default huge marker must not contain reserved chars");

  assert.doesNotThrow(() => validateMarker(DEFAULT_MARKERS.large));
  assert.doesNotThrow(() => validateMarker(DEFAULT_MARKERS.huge));
});

test("validateMarker: throws InvalidMarkerError for any MarkdownV2 reserved character", () => {
  const reservedChars = ["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!", "\\"];

  for (const ch of reservedChars) {
    assert.throws(
      () => validateMarker(`ALERT${ch}`),
      (err) => err instanceof InvalidMarkerError && err.message.includes("MarkdownV2 reserved characters"),
      `Should reject marker containing "${ch}"`,
    );
  }
});

test("highlightMarker: returns correct markers and supports custom safe markers", () => {
  assert.equal(highlightMarker("none"), "");
  assert.equal(highlightMarker("large"), DEFAULT_MARKERS.large);
  assert.equal(highlightMarker("huge"), DEFAULT_MARKERS.huge);

  const custom = {
    markers: {
      large: "⚡",
      huge: "💥",
    },
  };
  assert.equal(highlightMarker("large", custom), "⚡");
  assert.equal(highlightMarker("huge", custom), "💥");

  const unsafeCustom = {
    markers: {
      large: "[LARGE]",
    },
  };
  assert.throws(
    () => highlightMarker("large", unsafeCustom),
    (err) => err instanceof InvalidMarkerError,
  );
});

test("prefixFirstLine: prefixes only the first line with formatted marker", () => {
  assert.equal(prefixFirstLine("", "🔥"), "");
  assert.equal(prefixFirstLine("Single line", ""), "Single line");
  assert.equal(prefixFirstLine("Single line", "🔥"), "🔥 Single line");
  assert.equal(prefixFirstLine("Single line", "🔥 "), "🔥 Single line");
  assert.equal(
    prefixFirstLine("Line 1\nLine 2\nLine 3", "🔥"),
    "🔥 Line 1\nLine 2\nLine 3",
  );
});

// ── Renderer: formatEvent (MarkdownV2) ───────────────────────────────────────

test("formatEvent: default rendering is unchanged when thresholds are not passed", () => {
  const event = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 50_000n * USDC_UNIT, // Extremely large stake
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });

  const outputWithoutThresholds = formatEvent(TEST_CONFIG, event);
  assert.ok(outputWithoutThresholds !== null);
  // Must NOT contain highlight marker when thresholds are not passed
  assert.equal(outputWithoutThresholds.includes(DEFAULT_MARKERS.large), false);
  assert.equal(outputWithoutThresholds.includes(DEFAULT_MARKERS.huge), false);
  assert.ok(outputWithoutThresholds.startsWith("⚔️ *Claim \\#7 challenged*"));
});

test("formatEvent: prefixes first line with marker when thresholds are passed", () => {
  const thresholds = {
    large: 100n * USDC_UNIT,
    huge: 1000n * USDC_UNIT,
  };

  const largeEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 100n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const largeOutput = formatEvent(TEST_CONFIG, largeEvent, thresholds);
  assert.ok(largeOutput !== null);
  assert.ok(largeOutput.startsWith(`${DEFAULT_MARKERS.large} ⚔️ *Claim \\#7 challenged*`));

  const hugeEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 1000n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const hugeOutput = formatEvent(TEST_CONFIG, hugeEvent, thresholds);
  assert.ok(hugeOutput !== null);
  assert.ok(hugeOutput.startsWith(`${DEFAULT_MARKERS.huge} ⚔️ *Claim \\#7 challenged*`));

  const smallEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 10n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const smallOutput = formatEvent(TEST_CONFIG, smallEvent, thresholds);
  assert.ok(smallOutput !== null);
  assert.ok(smallOutput.startsWith("⚔️ *Claim \\#7 challenged*"));
  assert.equal(smallOutput.includes(DEFAULT_MARKERS.large), false);
  assert.equal(smallOutput.includes(DEFAULT_MARKERS.huge), false);
});

test("formatEvent: supports squad deposited highlight markers", () => {
  const thresholds = {
    large: 50n * USDC_UNIT,
    huge: 500n * USDC_UNIT,
  };

  const hugeDeposit = makeSquadEvent("deposited", {
    marketId: 42,
    amount: 1000n * USDC_UNIT,
    side: 1,
    participant: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const output = formatEvent(TEST_CONFIG, hugeDeposit, thresholds);
  assert.ok(output !== null);
  assert.ok(output.startsWith(`${DEFAULT_MARKERS.huge} ➕ *Squad \\#42*`));
});

// ── Renderer: formatPlainTextEvent (Plain text) ──────────────────────────────

test("formatPlainTextEvent: default rendering is unchanged when thresholds are not passed", () => {
  const event = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 50_000n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });

  const output = formatPlainTextEvent(TEST_CONFIG, event);
  assert.ok(output !== null);
  assert.equal(output.includes(DEFAULT_MARKERS.large), false);
  assert.equal(output.includes(DEFAULT_MARKERS.huge), false);
  assert.ok(output.startsWith("Claim #7 challenged"));
});

test("formatPlainTextEvent: prefixes first line with marker when thresholds are passed", () => {
  const thresholds = {
    large: 100n * USDC_UNIT,
    huge: 1000n * USDC_UNIT,
  };

  const largeEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 200n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const largeOutput = formatPlainTextEvent(TEST_CONFIG, largeEvent, thresholds);
  assert.ok(largeOutput !== null);
  assert.ok(largeOutput.startsWith(`${DEFAULT_MARKERS.large} Claim #7 challenged`));

  const hugeEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 2000n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const hugeOutput = formatPlainTextEvent(TEST_CONFIG, hugeEvent, thresholds);
  assert.ok(hugeOutput !== null);
  assert.ok(hugeOutput.startsWith(`${DEFAULT_MARKERS.huge} Claim #7 challenged`));

  const smallEvent = makeMarketEvent("claim_challenged", {
    claimId: 7,
    stake: 10n * USDC_UNIT,
    challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  });
  const smallOutput = formatPlainTextEvent(TEST_CONFIG, smallEvent, thresholds);
  assert.ok(smallOutput !== null);
  assert.ok(smallOutput.startsWith("Claim #7 challenged"));
  assert.equal(smallOutput.includes(DEFAULT_MARKERS.large), false);
  assert.equal(smallOutput.includes(DEFAULT_MARKERS.huge), false);
});
