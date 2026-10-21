import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaimArg,
  claimTimelineMessage,
  CLAIM_USAGE_MESSAGE,
} from "../dist/commands/claim.js";
import { escapeMd } from "../dist/notifications/format.js";

function fakeConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN",
    chatIds: ["-1001234567890"],
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 30_000,
    ...overrides,
  };
}

const CREATOR = "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const CHALLENGER = "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const TX_HASH_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_HASH_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const TX_HASH_3 = "3333333333333333333333333333333333333333333333333333333333333333";

test("parseClaimArg validates non-negative integers correctly", () => {
  assert.equal(parseClaimArg("0"), 0);
  assert.equal(parseClaimArg("42"), 42);
  assert.equal(parseClaimArg("  100  "), 100);
  assert.equal(parseClaimArg("/claim 7"), 7);
  assert.equal(parseClaimArg("/claim 0"), 0);
  assert.equal(parseClaimArg("/claim   99"), 99);

  // Invalid inputs
  assert.equal(parseClaimArg("-1"), null);
  assert.equal(parseClaimArg("/claim -5"), null);
  assert.equal(parseClaimArg("abc"), null);
  assert.equal(parseClaimArg("/claim abc"), null);
  assert.equal(parseClaimArg("/claim"), null);
  assert.equal(parseClaimArg(""), null);
  assert.equal(parseClaimArg("   "), null);
  assert.equal(parseClaimArg("12.34"), null);
  assert.equal(parseClaimArg("1 2"), null);
  assert.equal(parseClaimArg(null), null);
  assert.equal(parseClaimArg(undefined), null);
});

test("claimTimelineMessage replies with usage text on invalid arguments", () => {
  const config = fakeConfig();
  const events = [];

  assert.equal(claimTimelineMessage(null, events, config), CLAIM_USAGE_MESSAGE);
  assert.equal(claimTimelineMessage(undefined, events, config), CLAIM_USAGE_MESSAGE);
  assert.equal(claimTimelineMessage(-1, events, config), CLAIM_USAGE_MESSAGE);
  assert.equal(claimTimelineMessage("invalid", events, config), CLAIM_USAGE_MESSAGE);
  assert.equal(claimTimelineMessage(3.14, events, config), CLAIM_USAGE_MESSAGE);

  assert.match(CLAIM_USAGE_MESSAGE, /usage/i);
  assert.match(CLAIM_USAGE_MESSAGE, /\/claim/);
  assert.match(CLAIM_USAGE_MESSAGE, /non\\-negative integer/);
});

test("claimTimelineMessage replies with clear not seen recently message for unknown claim ids", () => {
  const config = fakeConfig();
  const events = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 1000,
      txHash: TX_HASH_1,
      at: 1000000,
      eventId: "1000-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_created",
        claimId: 1,
        category: "crypto",
        creator: CREATOR,
      },
    },
  ];

  const reply = claimTimelineMessage(999, events, config);
  assert.match(reply, /not seen recently/i);
  assert.match(reply, /999/);
});

test("claimTimelineMessage renders created-only timeline", () => {
  const config = fakeConfig();
  const events = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 5000,
      txHash: TX_HASH_1,
      at: 1000000,
      eventId: "5000-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_created",
        claimId: 42,
        category: "defi.protocol",
        creator: CREATOR,
      },
    },
  ];

  const reply = claimTimelineMessage(42, events, config);
  assert.ok(reply.includes("*Claim \\#42*"));
  assert.ok(reply.includes("ledger 5000"));
  assert.ok(reply.includes(`[tx](https://stellar.expert/explorer/testnet/tx/${TX_HASH_1})`));
  assert.ok(reply.includes("Created: defi\\.protocol by GBMGZ…PKZI"));
});

test("claimTimelineMessage renders challenged+resolved timeline in compareEvents order", () => {
  const config = fakeConfig();

  // Supply events in reverse order to verify sorting by compareEvents
  const events = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 6020,
      txHash: TX_HASH_3,
      at: 1000020,
      eventId: "6020-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_resolved",
        claimId: 7,
        winnerSide: 2, // challengers
        confidence: 95,
        summary: "Audit completed, vulnerability verified",
        evidenceHash: "beef",
      },
    },
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 6010,
      txHash: TX_HASH_2,
      at: 1000010,
      eventId: "6010-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_challenged",
        claimId: 7,
        challenger: CHALLENGER,
        stake: 50_000_000n, // 5.0000000 USDC
      },
    },
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 6000,
      txHash: TX_HASH_1,
      at: 1000000,
      eventId: "6000-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_created",
        claimId: 7,
        category: "security",
        creator: CREATOR,
      },
    },
  ];

  const reply = claimTimelineMessage(7, events, config);

  const lines = reply.split("\n");
  assert.equal(lines[0], "*Claim \\#7*");
  assert.equal(lines[1], "");

  // Check ordering: created (6000), challenged (6010), resolved (6020)
  assert.ok(lines[2].includes("ledger 6000"));
  assert.ok(lines[2].includes("Created: security by GBMGZ…PKZI"));
  assert.ok(lines[2].includes(`[tx](https://stellar.expert/explorer/testnet/tx/${TX_HASH_1})`));

  assert.ok(lines[3].includes("ledger 6010"));
  assert.ok(lines[3].includes("Challenged: 5\\.0000000 USDC by GDZCB…PKZI"));
  assert.ok(lines[3].includes(`[tx](https://stellar.expert/explorer/testnet/tx/${TX_HASH_2})`));

  assert.ok(lines[4].includes("ledger 6020"));
  assert.ok(lines[4].includes("Resolved: winner challengers (95% confidence) — _Audit completed, vulnerability verified_"));
  assert.ok(lines[4].includes(`[tx](https://stellar.expert/explorer/testnet/tx/${TX_HASH_3})`));
});

test("claimTimelineMessage properly filters out unrelated events and escapes dynamic text", () => {
  const config = fakeConfig();
  const events = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 7000,
      txHash: TX_HASH_1,
      at: 1000000,
      eventId: "7000-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_created",
        claimId: 10,
        category: "special_category*with#chars",
        creator: CREATOR,
      },
    },
    // Another market claim event
    {
      source: "market",
      contractId: config.marketContractId,
      version: "v1",
      ledger: 7010,
      txHash: TX_HASH_2,
      at: 1000010,
      eventId: "7010-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "claim_created",
        claimId: 20,
        category: "other",
        creator: CREATOR,
      },
    },
    // Squad event (marketId 10)
    {
      source: "squad",
      contractId: config.squadContractId,
      version: "v1",
      ledger: 7020,
      txHash: TX_HASH_3,
      at: 1000020,
      eventId: "7020-0",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "market_created",
        marketId: 10,
        question: "Will it rain?",
        captain: CREATOR,
        feeBps: 100,
        deadline: 1800000,
      },
    },
  ];

  const reply = claimTimelineMessage(10, events, config);

  // Escaping check: special_category*with#chars
  assert.ok(reply.includes(escapeMd("special_category*with#chars")));
  // Should NOT contain claim 20 or squad question
  assert.ok(!reply.includes("other"));
  assert.ok(!reply.includes("Will it rain"));
});
