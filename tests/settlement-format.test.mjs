import test from "node:test";
import assert from "node:assert/strict";

import {
  settlementLines,
  settlementBreakdown,
  formatPercentage,
} from "../dist/notifications/settlement.js";
import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

const USDC_SCALE = 10_000_000n;

const TEST_CONFIG = {
  marketContractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
  squadContractId: "CFIXTURESQUAD00000000000000000000000000000000000000000",
  networkPassphrase: "Test SDF Future Network ; October 2022",
  rpcUrl: "https://example.invalid/soroban/rpc",
  horizonUrl: "https://example.invalid",
};

function makeMarketSettledEvent(payload, overrides = {}) {
  return {
    source: "market",
    contractId: TEST_CONFIG.marketContractId,
    version: "v1",
    ledger: overrides.ledger ?? 12345,
    txHash: overrides.txHash ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: overrides.at ?? 1700000000,
    eventId: overrides.eventId ?? "12345-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "market_settled",
      claimId: payload.claimId ?? 1,
      totalPaid: payload.totalPaid ?? 0n,
      totalFees: payload.totalFees ?? 0n,
      owedToChallengers: payload.owedToChallengers ?? 0n,
      dust: payload.dust ?? 0n,
    },
  };
}

function extractNumbers(text) {
  // Strip Markdown backslashes to compare underlying plain numbers
  const unescaped = text.replace(/\\([_.[\]()~`>#+\-=|{}!\\])/g, "$1");
  const matches = unescaped.match(/\d+(?:\.\d+)?%?/g);
  return matches ?? [];
}

// ── formatPercentage unit tests ──────────────────────────────────────────────

test("formatPercentage computes bigint fixed-point with two decimals", () => {
  assert.equal(formatPercentage(160n * USDC_SCALE, 180n * USDC_SCALE), "88.89%");
  assert.equal(formatPercentage(20n * USDC_SCALE, 180n * USDC_SCALE), "11.11%");
  assert.equal(formatPercentage(50n * USDC_SCALE, 100n * USDC_SCALE), "50.00%");
  assert.equal(formatPercentage(100n * USDC_SCALE, 100n * USDC_SCALE), "100.00%");
  assert.equal(formatPercentage(0n, 100n * USDC_SCALE), "0.00%");
});

test("formatPercentage safely handles zero gross without division errors", () => {
  assert.equal(formatPercentage(0n, 0n), "0.00%");
  assert.equal(formatPercentage(10n, 0n), "0.00%");
});

// ── Normal payload ────────────────────────────────────────────────────────────

test("normal payload: settlementLines returns labelled amounts and percentages", () => {
  const payload = {
    claimId: 7,
    totalPaid: 18n * USDC_SCALE,
    totalFees: 2n * USDC_SCALE,
    owedToChallengers: 16n * USDC_SCALE,
    dust: 0n,
  };

  const lines = settlementLines(payload);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Owed to challengers: 16.0000000 USDC (88.89%)");
  assert.equal(lines[1], "Total fees: 2.0000000 USDC (11.11%)");
  assert.equal(lines[2], "Dust: 0.0000000 USDC (0.00%)");

  const breakdown = settlementBreakdown(payload);
  assert.equal(breakdown[0].percent, "88.89%");
  assert.equal(breakdown[1].percent, "11.11%");
  assert.equal(breakdown[2].percent, "0.00%");
});

test("normal payload: MarkdownV2 and plain text renderers contain the same numbers", () => {
  const payload = {
    claimId: 7,
    totalPaid: 18n * USDC_SCALE,
    totalFees: 2n * USDC_SCALE,
    owedToChallengers: 16n * USDC_SCALE,
    dust: 0n,
  };
  const event = makeMarketSettledEvent(payload);

  const md = formatEvent(TEST_CONFIG, event);
  const plain = formatPlainTextEvent(TEST_CONFIG, event);

  assert.ok(md);
  assert.ok(plain);

  // Both messages must contain the proportion lines
  assert.ok(plain.includes("Owed to challengers: 16.0000000 USDC (88.89%)"));
  assert.ok(plain.includes("Total fees: 2.0000000 USDC (11.11%)"));
  assert.ok(plain.includes("Dust: 0.0000000 USDC (0.00%)"));

  assert.ok(md.includes("Owed to challengers: 16\\.0000000 USDC \\(88\\.89%\\)"));
  assert.ok(md.includes("Total fees: 2\\.0000000 USDC \\(11\\.11%\\)"));
  assert.ok(md.includes("Dust: 0\\.0000000 USDC \\(0\\.00%\\)"));

  // Acceptance criteria: Plain and MarkdownV2 outputs contain the same numbers
  assert.deepEqual(extractNumbers(md), extractNumbers(plain));
});

// ── Zero-fee payload ──────────────────────────────────────────────────────────

test("zero-fee payload: settlementLines formats zero fees accurately", () => {
  const payload = {
    claimId: 10,
    totalPaid: 50n * USDC_SCALE,
    totalFees: 0n,
    owedToChallengers: 50n * USDC_SCALE,
    dust: 0n,
  };

  const lines = settlementLines(payload);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Owed to challengers: 50.0000000 USDC (100.00%)");
  assert.equal(lines[1], "Total fees: 0.0000000 USDC (0.00%)");
  assert.equal(lines[2], "Dust: 0.0000000 USDC (0.00%)");
});

test("zero-fee payload: Plain and MarkdownV2 renderers contain the same numbers", () => {
  const payload = {
    claimId: 10,
    totalPaid: 50n * USDC_SCALE,
    totalFees: 0n,
    owedToChallengers: 50n * USDC_SCALE,
    dust: 0n,
  };
  const event = makeMarketSettledEvent(payload);

  const md = formatEvent(TEST_CONFIG, event);
  const plain = formatPlainTextEvent(TEST_CONFIG, event);

  assert.ok(md);
  assert.ok(plain);

  assert.ok(plain.includes("Total fees: 0.0000000 USDC (0.00%)"));
  assert.ok(plain.includes("Owed to challengers: 50.0000000 USDC (100.00%)"));

  assert.ok(md.includes("Total fees: 0\\.0000000 USDC \\(0\\.00%\\)"));
  assert.ok(md.includes("Owed to challengers: 50\\.0000000 USDC \\(100\\.00%\\)"));

  assert.deepEqual(extractNumbers(md), extractNumbers(plain));
});

// ── Dust-only payload ─────────────────────────────────────────────────────────

test("dust-only payload: settlementLines formats dust as 100% of gross", () => {
  const payload = {
    claimId: 11,
    totalPaid: 0n,
    totalFees: 0n,
    owedToChallengers: 0n,
    dust: 5n * USDC_SCALE,
  };

  const lines = settlementLines(payload);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Owed to challengers: 0.0000000 USDC (0.00%)");
  assert.equal(lines[1], "Total fees: 0.0000000 USDC (0.00%)");
  assert.equal(lines[2], "Dust: 5.0000000 USDC (100.00%)");
});

test("dust-only payload: Plain and MarkdownV2 renderers contain the same numbers", () => {
  const payload = {
    claimId: 11,
    totalPaid: 0n,
    totalFees: 0n,
    owedToChallengers: 0n,
    dust: 5n * USDC_SCALE,
  };
  const event = makeMarketSettledEvent(payload);

  const md = formatEvent(TEST_CONFIG, event);
  const plain = formatPlainTextEvent(TEST_CONFIG, event);

  assert.ok(md);
  assert.ok(plain);

  assert.ok(plain.includes("Dust: 5.0000000 USDC (100.00%)"));
  assert.ok(md.includes("Dust: 5\\.0000000 USDC \\(100\\.00%\\)"));

  assert.deepEqual(extractNumbers(md), extractNumbers(plain));
});

// ── Zero totals (acceptance criterion) ────────────────────────────────────────

test("zero totals payload renders safely without division errors", () => {
  const payload = {
    claimId: 12,
    totalPaid: 0n,
    totalFees: 0n,
    owedToChallengers: 0n,
    dust: 0n,
  };

  assert.doesNotThrow(() => {
    const lines = settlementLines(payload);
    assert.equal(lines[0], "Owed to challengers: 0.0000000 USDC (0.00%)");
    assert.equal(lines[1], "Total fees: 0.0000000 USDC (0.00%)");
    assert.equal(lines[2], "Dust: 0.0000000 USDC (0.00%)");
  });

  const event = makeMarketSettledEvent(payload);
  const md = formatEvent(TEST_CONFIG, event);
  const plain = formatPlainTextEvent(TEST_CONFIG, event);

  assert.ok(md);
  assert.ok(plain);
  assert.deepEqual(extractNumbers(md), extractNumbers(plain));
});
