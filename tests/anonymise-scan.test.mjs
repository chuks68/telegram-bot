import assert from "node:assert/strict";
import test from "node:test";
import { StrKey } from "@stellar/stellar-sdk";

import { ScanAnonymiser, anonymiseScan, DEFAULT_SALT } from "../scripts/anonymise-scan.mjs";
import { formatEvent } from "../dist/notifications/format.js";

/** Sample report mirroring `npm run scan -- --json` (mimir-scan-v1) */
function createSampleReport() {
  return {
    format: "mimir-scan-v1",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    ledgers: { oldest: 100000, latest: 105000 },
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        pages: 2,
        eventCount: 3,
        truncated: false,
        lastEventLedger: 104500,
        cursor: "0018276211125911551-4294967295",
        startLedger: 100000,
        startClamped: false,
        histogram: {
          claim_created: 1,
          claim_challenged: 1,
          oracle_changed: 1,
        },
        events: [
          {
            ledger: 104100,
            txHash: "1111111111111111111111111111111111111111111111111111111111111111",
            eventId: "104100-0",
            summary: "claim #10 created by GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5 [crypto]",
            payload: {
              name: "claim_created",
              claimId: 10,
              creator: "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5",
              category: "crypto",
            },
          },
          {
            ledger: 104200,
            txHash: "2222222222222222222222222222222222222222222222222222222222222222",
            eventId: "104200-0",
            summary: "claim #10 challenged by GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV for 20.0000000 USDC",
            payload: {
              name: "claim_challenged",
              claimId: 10,
              challenger: "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV",
              stake: "200000000",
            },
          },
          {
            ledger: 104300,
            txHash: "3333333333333333333333333333333333333333333333333333333333333333",
            eventId: "104300-0",
            summary: "oracle changed to GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5",
            payload: {
              name: "oracle_changed",
              newOracle: "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5",
              admin: "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV",
              details: {
                previousOracle: "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5",
              },
            },
          },
        ],
      },
      {
        source: "squad",
        contractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
        pages: 1,
        eventCount: 1,
        truncated: false,
        lastEventLedger: 104400,
        cursor: "0018276211125911552-4294967295",
        startLedger: 100000,
        startClamped: false,
        histogram: {
          deposited: 1,
        },
        events: [
          {
            ledger: 104400,
            txHash: "4444444444444444444444444444444444444444444444444444444444444444",
            eventId: "104400-0",
            summary: "squad #1 side=1 GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5 deposited 50.0000000 USDC",
            payload: {
              name: "deposited",
              marketId: 1,
              side: 1,
              participant: "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5",
              amount: "500000000",
              shares: "500000000",
            },
          },
        ],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance Criteria: Determinism
// ─────────────────────────────────────────────────────────────────────────────

test("the same input and salt give the same output", () => {
  const sample1 = createSampleReport();
  const sample2 = createSampleReport();

  const out1 = anonymiseScan(sample1, "fixed-salt-123");
  const out2 = anonymiseScan(sample2, "fixed-salt-123");

  assert.deepEqual(out1, out2);
});

test("different salts give different fake addresses and hashes", () => {
  const sample1 = createSampleReport();
  const sample2 = createSampleReport();

  const out1 = anonymiseScan(sample1, "salt-A");
  const out2 = anonymiseScan(sample2, "salt-B");

  assert.notDeepEqual(out1, out2);
  const addr1 = out1.targets[0].events[0].payload.creator;
  const addr2 = out2.targets[0].events[0].payload.creator;
  assert.notEqual(addr1, addr2);
});

test("same address occurring multiple times gets identical fake address", () => {
  const sample = createSampleReport();
  const out = anonymiseScan(sample, "test-salt");

  const creator = out.targets[0].events[0].payload.creator;
  const newOracle = out.targets[0].events[2].payload.newOracle;
  const previousOracle = out.targets[0].events[2].payload.details.previousOracle;
  const participant = out.targets[1].events[0].payload.participant;

  // In the sample report, all 4 are originally GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5
  assert.equal(creator, newOracle);
  assert.equal(creator, previousOracle);
  assert.equal(creator, participant);
});

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance Criteria: No original address appears in output
// ─────────────────────────────────────────────────────────────────────────────

test("no original address appears in output", () => {
  const original = createSampleReport();
  const originalJson = JSON.stringify(original);

  const realAddr1 = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
  const realAddr2 = "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";
  const realTx1 = "1111111111111111111111111111111111111111111111111111111111111111";

  assert.ok(originalJson.includes(realAddr1));
  assert.ok(originalJson.includes(realAddr2));
  assert.ok(originalJson.includes(realTx1));

  const anonymised = anonymiseScan(original, "test-salt");
  const anonymisedJson = JSON.stringify(anonymised);

  assert.ok(!anonymisedJson.includes(realAddr1), "Original address 1 leaked into output");
  assert.ok(!anonymisedJson.includes(realAddr2), "Original address 2 leaked into output");
  assert.ok(!anonymisedJson.includes(realTx1), "Original tx hash 1 leaked into output");
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope: Valid-looking strkeys decoders and formatters accept
// ─────────────────────────────────────────────────────────────────────────────

test("fake addresses are valid StrKeys accepted by decoders and formatters", () => {
  const sample = createSampleReport();
  const out = anonymiseScan(sample, "test-salt");

  const fakeCreator = out.targets[0].events[0].payload.creator;
  const fakeChallenger = out.targets[0].events[1].payload.challenger;

  assert.ok(StrKey.isValidEd25519PublicKey(fakeCreator));
  assert.ok(StrKey.isValidEd25519PublicKey(fakeChallenger));

  // Verify decoders / regex acceptance (/^[GC][A-Z2-7]{55}$/)
  assert.match(fakeCreator, /^G[A-Z2-7]{55}$/);
  assert.match(fakeChallenger, /^G[A-Z2-7]{55}$/);

  // Verify formatEvent accepts the anonymised event without fallback errors
  const challengeEvent = {
    source: "market",
    contractId: out.targets[0].contractId,
    ledger: out.targets[0].events[1].ledger,
    txHash: out.targets[0].events[1].txHash,
    at: 1724000000,
    eventId: out.targets[0].events[1].eventId,
    payload: {
      ...out.targets[0].events[1].payload,
      stake: BigInt(out.targets[0].events[1].payload.stake),
    },
  };

  const formatted = formatEvent(
    {
      chatIds: ["-100123"],
      marketContractId: out.targets[0].contractId,
      squadContractId: out.targets[1].contractId,
      rpcUrl: "https://example.invalid",
    },
    challengeEvent
  );

  assert.ok(formatted, "formatEvent returned null or empty");
  assert.doesNotMatch(formatted, /Fallback|Reason:/);
  assert.match(formatted, /Claim \\#10 challenged/);
  assert.match(formatted, /Challenger:/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope: Preserving contract ids, event names, ledgers, and amounts
// ─────────────────────────────────────────────────────────────────────────────

test("preserves contract ids, event names, ledgers, amounts, and metadata", () => {
  const sample = createSampleReport();
  const out = anonymiseScan(sample, "test-salt");

  // Contract ids preserved
  assert.equal(out.targets[0].contractId, "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI");
  assert.equal(out.targets[1].contractId, "CFIXTURESQUAD0000000000000000000000000000000000000000000");

  // Event names preserved
  assert.equal(out.targets[0].events[0].payload.name, "claim_created");
  assert.equal(out.targets[0].events[1].payload.name, "claim_challenged");
  assert.equal(out.targets[0].events[2].payload.name, "oracle_changed");
  assert.equal(out.targets[1].events[0].payload.name, "deposited");

  // Ledgers preserved
  assert.equal(out.targets[0].events[0].ledger, 104100);
  assert.equal(out.targets[0].events[1].ledger, 104200);

  // Amounts preserved
  assert.equal(out.targets[0].events[1].payload.stake, "200000000");
  assert.equal(out.targets[1].events[0].payload.amount, "500000000");
  assert.equal(out.targets[1].events[0].payload.shares, "500000000");

  // Non-sensitive payload fields preserved
  assert.equal(out.targets[0].events[0].payload.claimId, 10);
  assert.equal(out.targets[0].events[0].payload.category, "crypto");
  assert.equal(out.targets[1].events[0].payload.side, 1);
});

test("anonymiseSummary updates short addresses in summary", () => {
  const sample = createSampleReport();
  const out = anonymiseScan(sample, "test-salt");

  const summary = out.targets[0].events[0].summary;
  assert.ok(!summary.includes("GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5"));
  const fakeCreator = out.targets[0].events[0].payload.creator;
  const fakeShort = `${fakeCreator.slice(0, 5)}…${fakeCreator.slice(-4)}`;
  assert.ok(summary.includes(fakeCreator) || summary.includes(fakeShort));
});
