/**
 * i128 boundary amounts, end to end.
 *
 * Money on-chain is i128; the decoder turns it into a bigint, `formatUsdc`
 * renders it with seven decimals, and the notifications and `--json` report
 * both carry the result to a human. Every step here is lossless by contract,
 * so each boundary — 0, 1 atomic unit, 10^7 (one USDC), 2^63 (just past the
 * JS safe integer range) and 2^127-1 (the i128 maximum) — is asserted as an
 * exact string rather than a parsed number.
 *
 * Amounts are built with `nativeToScVal(..., { type: "i128" })`, the same
 * conversion the SDK applies to live RPC events, so the ScVal -> bigint path
 * under test is the production one. Negative i128 values are asserted to land
 * on the documented rejection path: an `unknown` payload whose reason names
 * the offending field, no notification, no amount in the JSON report.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent, formatUsdc, USDC_UNIT } from "../dist/stellar/decode.js";
import { formatEvent } from "../dist/notifications/format.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  formatScanJson,
} from "../dist/stellar/events.js";

// ── Deterministic identity and metadata ──────────────────────────────────────

const KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
const ADDR = KP.publicKey(); // GAQVF…ET46 once shortened
const TX_HASH = "ab".repeat(32); // 64 hex chars: a usable explorer link
const MARKET_CONTRACT = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_CONTRACT = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const LEDGER = 42;

const config = {
  marketContractId: MARKET_CONTRACT,
  squadContractId: SQUAD_CONTRACT,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
};

const EXPLORER_FOOTER =
  "\n_ledger 42_ · [tx](https://stellar.expert/explorer/testnet/tx/" + TX_HASH + ")";

// ── The boundary table ───────────────────────────────────────────────────────

/** Every boundary the contracts can hand the decoder, with its exact render. */
const BOUNDARIES = [
  { label: "zero", units: 0n, usdc: "0.0000000" },
  { label: "one atomic unit", units: 1n, usdc: "0.0000001" },
  { label: "one whole USDC", units: 10_000_000n, usdc: "1.0000000" },
  {
    label: "2^63, just past Number.MAX_SAFE_INTEGER",
    units: 9_223_372_036_854_775_808n,
    usdc: "922337203685.4775808",
  },
  {
    label: "2^127-1, the i128 maximum",
    units: 170_141_183_460_469_231_731_687_303_715_884_105_727n,
    usdc: "17014118346046923173168730371588.4105727",
  },
];

/** Exact channel text for each boundary's `withdrawal` notification. */
const EXPECTED_WITHDRAWALS = [
  "📤 *Withdrawal* — 0\\.0000000 USDC to `GAQVF…ET46`" + EXPLORER_FOOTER,
  "📤 *Withdrawal* — 0\\.0000001 USDC to `GAQVF…ET46`" + EXPLORER_FOOTER,
  "📤 *Withdrawal* — 1\\.0000000 USDC to `GAQVF…ET46`" + EXPLORER_FOOTER,
  "📤 *Withdrawal* — 922337203685\\.4775808 USDC to `GAQVF…ET46`" + EXPLORER_FOOTER,
  "📤 *Withdrawal* — 17014118346046923173168730371588\\.4105727 USDC to `GAQVF…ET46`" +
    EXPLORER_FOOTER,
];

// ── Event builders (ScVal, exactly as the RPC hands them over) ───────────────

const i128 = (units) => nativeToScVal(units, { type: "i128" });
const sym = (name) => nativeToScVal(name, { type: "symbol" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const addrVal = () => Address.account(Buffer.from(KP.rawPublicKey())).toScVal();

function rawEvent({ contractId, topic, value }) {
  return {
    id: "42-0",
    type: "contract",
    ledger: LEDGER,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    txHash: TX_HASH,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    contractId,
    topic,
    value,
  };
}

function withdrawalRaw(units) {
  return rawEvent({
    contractId: MARKET_CONTRACT,
    topic: [sym("withdrawal"), addrVal()],
    value: nativeToScVal({ amount: i128(units) }),
  });
}

function squadDepositedRaw(amount, shares) {
  return rawEvent({
    contractId: SQUAD_CONTRACT,
    topic: [sym("deposited"), u64(1), u32(1), addrVal()],
    value: nativeToScVal({ amount: i128(amount), shares: i128(shares) }),
  });
}

function marketSettledRaw({ totalPaid, totalFees, owedToChallengers, dust }) {
  return rawEvent({
    contractId: MARKET_CONTRACT,
    topic: [sym("market_settled"), u64(7)],
    value: nativeToScVal({
      total_paid: i128(totalPaid),
      total_fees: i128(totalFees),
      owed_to_challengers: i128(owedToChallengers),
      dust: i128(dust),
    }),
  });
}

/** The `--json` report for a single decoded event, parsed and raw. */
function scanJson(source, decoded) {
  const target = buildScanJsonTarget(
    {
      source,
      contractId: source === "market" ? MARKET_CONTRACT : SQUAD_CONTRACT,
      events: [decoded],
      cursor: "42-0",
      latestLedger: 50,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
      lastEventLedger: LEDGER,
    },
    5,
  );
  const text = formatScanJson(
    buildScanJsonReport({
      network: "testnet",
      rpcUrl: config.rpcUrl,
      oldestLedger: 1,
      latestLedger: 50,
      targets: [target],
    }),
  );
  return { text, parsed: JSON.parse(text), event: JSON.parse(text).targets[0].events[0] };
}

// ── Boundary sanity ──────────────────────────────────────────────────────────

test("the boundary table is the i128 range, not a typo of it", () => {
  assert.equal(BOUNDARIES[0].units, 0n);
  assert.equal(BOUNDARIES[1].units, 1n);
  assert.equal(BOUNDARIES[2].units, USDC_UNIT);
  assert.equal(BOUNDARIES[3].units, 2n ** 63n);
  assert.equal(BOUNDARIES[3].units > BigInt(Number.MAX_SAFE_INTEGER), true);
  assert.equal(BOUNDARIES[4].units, 2n ** 127n - 1n);
  assert.equal(BOUNDARIES.length, EXPECTED_WITHDRAWALS.length);
});

// ── Decode: exact bigints, no precision loss ─────────────────────────────────

test("every boundary decodes from i128 to the identical bigint", () => {
  for (const { label, units } of BOUNDARIES) {
    const decoded = decodeEvent("market", withdrawalRaw(units));
    assert.equal(decoded.payload.name, "withdrawal", label);
    assert.equal(typeof decoded.payload.amount, "bigint", label);
    assert.equal(decoded.payload.amount, units, label);
    // Strict equality of the rendered decimal, not of a rounded number.
    assert.equal(decoded.payload.amount.toString(10), units.toString(10), label);
  }
});

test("formatUsdc renders every boundary with exactly seven decimals", () => {
  for (const { label, units, usdc } of BOUNDARIES) {
    assert.equal(formatUsdc(units), usdc, label);
  }
  assert.equal(formatUsdc(0n).split(".")[1].length, 7);
  assert.equal(formatUsdc(2n ** 127n - 1n).split(".")[1].length, 7);
});

// ── Notify: exact channel text ───────────────────────────────────────────────

test("formatEvent renders each boundary as an exact notification string", () => {
  BOUNDARIES.forEach(({ label, units }, index) => {
    const decoded = decodeEvent("market", withdrawalRaw(units));
    assert.equal(formatEvent(config, decoded), EXPECTED_WITHDRAWALS[index], label);
  });
});

test("a squad deposit at the i128 maximum keeps amount and shares exact", () => {
  const max = 2n ** 127n - 1n;
  const decoded = decodeEvent("squad", squadDepositedRaw(max, max));
  assert.equal(decoded.payload.name, "deposited");
  assert.equal(decoded.payload.amount, max);
  assert.equal(decoded.payload.shares, max);

  const expected =
    "➕ *Squad \\#1* — 17014118346046923173168730371588\\.4105727 USDC on *Side A*\n" +
    "Participant: `GAQVF…ET46`" +
    EXPLORER_FOOTER;
  assert.equal(formatEvent(config, decoded), expected);
});

test("market_settled at the i128 maximum keeps every amount field exact", () => {
  const max = 2n ** 127n - 1n;
  const decoded = decodeEvent(
    "market",
    marketSettledRaw({
      totalPaid: max,
      totalFees: 0n,
      owedToChallengers: USDC_UNIT,
      dust: 1n,
    }),
  );
  assert.equal(decoded.payload.name, "market_settled");
  assert.equal(decoded.payload.totalPaid, max);
  assert.equal(decoded.payload.totalFees, 0n);
  assert.equal(decoded.payload.owedToChallengers, USDC_UNIT);
  assert.equal(decoded.payload.dust, 1n);

  const expected =
    "💰 *Claim \\#7 settled*\n" +
    "Paid out: *17014118346046923173168730371588\\.4105727 USDC* · fees 0\\.0000000 USDC\n" +
    "Owed to challengers: 1\\.0000000 USDC" +
    EXPLORER_FOOTER;
  assert.equal(formatEvent(config, decoded), expected);
});

// ── JSON report: exact decimal strings ──────────────────────────────────────

test("formatScanJson writes each boundary as the exact decimal string", () => {
  for (const { label, units } of BOUNDARIES) {
    const decoded = decodeEvent("market", withdrawalRaw(units));
    const { text, event } = scanJson("market", decoded);

    assert.equal(typeof event.payload.amount, "string", label);
    assert.equal(event.payload.amount, units.toString(10), label);
    assert.equal(BigInt(event.payload.amount), units, label);
    // The literal string is in the document, not a re-serialized float.
    // `formatScanJson` pretty-prints with two spaces: `"amount": "0"`.
    assert.ok(text.includes(`"amount": "${units}"`), `${label}: raw JSON`);
    // No lossy scientific notation may stand in for an integer of this size.
    assert.equal(text.includes("e+"), false, label);
  }
});

test("the squad and settlement summaries carry the rendered boundary amount", () => {
  const max = 2n ** 127n - 1n;
  const expectedAmount = "17014118346046923173168730371588.4105727";

  const squad = scanJson("squad", decodeEvent("squad", squadDepositedRaw(max, max)));
  assert.equal(squad.event.payload.amount, max.toString(10));
  assert.equal(squad.event.payload.shares, max.toString(10));
  assert.equal(
    squad.event.summary,
    `squad #1 side=1 GAQVF…ET46 deposited ${expectedAmount} USDC`,
  );

  const settled = scanJson(
    "market",
    decodeEvent(
      "market",
      marketSettledRaw({
        totalPaid: max,
        totalFees: 0n,
        owedToChallengers: USDC_UNIT,
        dust: 1n,
      }),
    ),
  );
  assert.equal(settled.event.payload.totalPaid, max.toString(10));
  assert.equal(settled.event.payload.dust, "1");
  assert.equal(
    settled.event.summary,
    `claim #7 settled paid=${expectedAmount} USDC fees=0.0000000 USDC`,
  );
});

// ── Negative amounts: the documented rejection path ─────────────────────────

test("negative i128 amounts are rejected as unknown payloads, end to end", () => {
  const cases = [
    { units: -1n, reason: "withdrawal.amount: expected non-negative amount, got -1" },
    {
      units: -(2n ** 127n),
      reason:
        "withdrawal.amount: expected non-negative amount, got -170141183460469231731687303715884105728",
    },
  ];

  for (const { units, reason } of cases) {
    let decoded;
    assert.doesNotThrow(() => {
      decoded = decodeEvent("market", withdrawalRaw(units));
    }, String(units));

    // The documented path: unknown payload, reason naming field and value.
    assert.equal(decoded.payload.name, "unknown", String(units));
    assert.equal(decoded.payload.eventName, "withdrawal", String(units));
    assert.equal(decoded.payload.reason, reason, String(units));

    // Nothing is sent to the channel, and the JSON report carries no amount.
    assert.equal(formatEvent(config, decoded), null, String(units));

    const { event } = scanJson("market", decoded);
    assert.equal(event.payload.amount, undefined, String(units));
    assert.equal(
      event.summary,
      `unknown "withdrawal" (${reason})`,
      String(units),
    );
  }
});

test("a negative amount in any field rejects the whole event", () => {
  const decoded = decodeEvent(
    "market",
    marketSettledRaw({
      totalPaid: 2n ** 127n - 1n,
      totalFees: -1n,
      owedToChallengers: 0n,
      dust: 0n,
    }),
  );
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(
    decoded.payload.reason,
    "market_settled.total_fees: expected non-negative amount, got -1",
  );
  assert.equal(formatEvent(config, decoded), null);
});
