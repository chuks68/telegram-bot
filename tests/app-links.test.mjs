import assert from "node:assert/strict";
import test from "node:test";

import { appTargetFor, appUrlFor } from "../dist/notifications/app-links.js";
import {
  eventExplorerUrl,
  explorerKeyboard,
} from "../dist/notifications/format.js";
import { EXPLORER_BUTTON_TEXT, MIMIR_APP_BUTTON_TEXT } from "../dist/i18n.js";

const VALID_TX = "0123456789abcdef".repeat(4);
assert.equal(VALID_TX.length, 64);

const APP = "https://app.mimir.example";

function config(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatId: "-1001234567890",
    ...overrides,
  };
}

function event(payload, overrides = {}) {
  return {
    source: "market",
    contractId: "market",
    ledger: 4226692,
    txHash: VALID_TX,
    at: 0,
    eventId: "0018276211125911551-0000000001",
    payload,
    ...overrides,
  };
}

const CLAIM_EVENTS = [
  { name: "claim_created", claimId: 7, creator: "GABCD", category: "crypto" },
  { name: "claim_challenged", claimId: 7, challenger: "GABCD", stake: 20_000_000n },
  {
    name: "claim_resolved",
    claimId: 7,
    winnerSide: 1,
    summary: "",
    confidence: 80,
    evidenceHash: "ab".repeat(32),
  },
  { name: "claim_cancelled", claimId: 7 },
  {
    name: "market_settled",
    claimId: 7,
    totalPaid: 100n,
    totalFees: 1n,
    owedToChallengers: 99n,
    dust: 0n,
  },
  {
    name: "challenger_paid",
    claimId: 7,
    challenger: "GABCD",
    stake: 20n,
    gross: 40n,
    fee: 1n,
    net: 39n,
  },
];

const SQUAD_EVENTS = [
  {
    name: "market_created",
    marketId: 3,
    captain: "GABCD",
    deadline: 1_770_000_000,
    feeBps: 100,
    question: "Will Stellar ship it?",
  },
  {
    name: "deposited",
    marketId: 3,
    side: 1,
    participant: "GABCD",
    amount: 5n,
    shares: 5n,
  },
  { name: "withdrawn", marketId: 3, side: 2, participant: "GABCD", amount: 5n },
  { name: "resolved", marketId: 3, result: 1, poolA: 10n, poolB: 10n },
  {
    name: "claimed",
    marketId: 3,
    participant: "GABCD",
    gross: 10n,
    fee: 1n,
    net: 9n,
  },
];

// ── URL building ─────────────────────────────────────────────────────────────

test("claim events build /claims/<id> URLs", () => {
  for (const payload of CLAIM_EVENTS) {
    assert.equal(
      appUrlFor(event(payload), APP),
      `${APP}/claims/${payload.claimId}`,
      payload.name,
    );
  }
});

test("squad events build /squads/<id> URLs", () => {
  for (const payload of SQUAD_EVENTS) {
    assert.equal(
      appUrlFor(event(payload), APP),
      `${APP}/squads/${payload.marketId}`,
      payload.name,
    );
  }
});

test("events with no page of their own return null", () => {
  const pageless = [
    { name: "fee_claimed", recipient: "GABCD", amount: 1n },
    { name: "withdrawal", to: "GABCD", amount: 1n },
    { name: "withdrawal_pending", to: "GABCD", amount: 1n },
    { name: "fees_claimed", recipient: "GABCD", amount: 1n },
    { name: "oracle_changed", newOracle: "GABCD" },
    { name: "admin" },
    { name: "unknown", eventName: "mystery", reason: "no decoder" },
  ];

  for (const payload of pageless) {
    assert.equal(appUrlFor(event(payload), APP), null, payload.name);
  }
});

test("appTargetFor reports the route and id for mappable events", () => {
  assert.deepEqual(appTargetFor(event(CLAIM_EVENTS[0])), { route: "claims", id: "7" });
  assert.deepEqual(appTargetFor(event(SQUAD_EVENTS[0])), { route: "squads", id: "3" });
  assert.equal(appTargetFor(event(pagelessPayload())), null);
});

function pagelessPayload() {
  return { name: "withdrawal", to: "GABCD", amount: 1n };
}

test("no base URL means no link", () => {
  for (const base of [null, undefined, ""]) {
    assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), base), null, String(base));
  }
});

test("a missing or unusable payload id produces no link", () => {
  const missing = event({ name: "claim_created", creator: "GABCD", category: "crypto" });
  assert.equal(appUrlFor(missing, APP), null);

  const notFinite = event({ name: "claim_created", claimId: Number.NaN, creator: "G", category: "c" });
  assert.equal(appUrlFor(notFinite, APP), null);

  const oversized = event({ name: "claim_created", claimId: "x".repeat(65), creator: "G", category: "c" });
  assert.equal(appUrlFor(oversized, APP), null);
});

test("a non-https or unparseable base URL produces no link", () => {
  assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), "http://app.mimir.example"), null);
  assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), "javascript:alert(1)"), null);
  assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), "not a url"), null);
});

test("base URL trailing slashes and paths collapse to one separator", () => {
  assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), `${APP}/`), `${APP}/claims/7`);
  assert.equal(appUrlFor(event(CLAIM_EVENTS[0]), `${APP}//`), `${APP}/claims/7`);
  assert.equal(
    appUrlFor(event(CLAIM_EVENTS[0]), "https://app.mimir.example/mimir/"),
    "https://app.mimir.example/mimir/claims/7",
  );
});

test("base URL path and payload ids are percent-encoded", () => {
  const encodedBase = appUrlFor(event(CLAIM_EVENTS[0]), "https://app.mimir.example/my app/");
  assert.equal(encodedBase, "https://app.mimir.example/my%20app/claims/7");
  assert.ok(!/\s/.test(encodedBase), "no raw whitespace survives");

  const oddId = event({
    name: "claim_created",
    claimId: "7/../../etc?x=1#y",
    creator: "GABCD",
    category: "crypto",
  });
  const url = appUrlFor(oddId, APP);
  assert.equal(url, `${APP}/claims/7%2F..%2F..%2Fetc%3Fx%3D1%23y`);
  assert.ok(!url.includes(" "), "no raw space in the id");
});

test("a query or fragment on the base URL is dropped, not glued to the path", () => {
  assert.equal(
    appUrlFor(event(CLAIM_EVENTS[0]), `${APP}?ref=telegram`),
    `${APP}/claims/7`,
  );
  assert.equal(
    appUrlFor(event(CLAIM_EVENTS[0]), `${APP}#section`),
    `${APP}/claims/7`,
  );
});

// ── Keyboard composition ─────────────────────────────────────────────────────

test("without MIMIR_APP_URL the explorer keyboard is unchanged", () => {
  const cfg = config();
  const explorerUrl = eventExplorerUrl(cfg, event(CLAIM_EVENTS[0]));

  for (const base of [undefined, null, ""]) {
    const keyboard = explorerKeyboard({ ...cfg, mimirAppUrl: base }, event(CLAIM_EVENTS[0]));
    assert.deepEqual(keyboard, {
      inline_keyboard: [[{ text: EXPLORER_BUTTON_TEXT, url: explorerUrl }]],
    });
  }
});

test("MIMIR_APP_URL adds an app button beside the explorer button", () => {
  const cfg = config({ mimirAppUrl: APP });
  const explorerUrl = eventExplorerUrl(cfg, event(CLAIM_EVENTS[1]));

  const keyboard = explorerKeyboard(cfg, event(CLAIM_EVENTS[1]));
  assert.deepEqual(keyboard, {
    inline_keyboard: [
      [
        { text: EXPLORER_BUTTON_TEXT, url: explorerUrl },
        { text: MIMIR_APP_BUTTON_TEXT, url: `${APP}/claims/7` },
      ],
    ],
  });
});

test("squad notifications link to the squad page", () => {
  const cfg = config({ mimirAppUrl: `${APP}/` });
  const keyboard = explorerKeyboard(cfg, event(SQUAD_EVENTS[1]));
  assert.deepEqual(keyboard, {
    inline_keyboard: [
      [
        { text: EXPLORER_BUTTON_TEXT, url: eventExplorerUrl(cfg, event(SQUAD_EVENTS[1])) },
        { text: MIMIR_APP_BUTTON_TEXT, url: `${APP}/squads/3` },
      ],
    ],
  });
});

test("an event with no app page keeps the explorer-only keyboard", () => {
  const cfg = config({ mimirAppUrl: APP });
  const withdrawal = event({ name: "withdrawal", to: "GABCD", amount: 1n });
  const explorerUrl = eventExplorerUrl(cfg, withdrawal);

  assert.deepEqual(explorerKeyboard(cfg, withdrawal), {
    inline_keyboard: [[{ text: EXPLORER_BUTTON_TEXT, url: explorerUrl }]],
  });
});

test("an event with no usable tx hash gets the app button alone", () => {
  const cfg = config({ mimirAppUrl: APP });
  const broken = event(CLAIM_EVENTS[0], { txHash: "not-a-hash" });

  assert.deepEqual(explorerKeyboard(cfg, broken), {
    inline_keyboard: [[{ text: MIMIR_APP_BUTTON_TEXT, url: `${APP}/claims/7` }]],
  });
});

test("no tx hash and no MIMIR_APP_URL still means no keyboard", () => {
  const cfg = config();
  assert.equal(explorerKeyboard(cfg, event(CLAIM_EVENTS[0], { txHash: "" })), undefined);
  assert.equal(explorerKeyboard(cfg, event(pagelessPayload(), { txHash: "" })), undefined);
});
