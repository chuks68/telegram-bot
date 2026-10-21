import test from "node:test";
import assert from "node:assert";
import {
  buildActivitySummary,
  activitySummaryMessage,
} from "../src/notifications/activity-summary.js";

test("buildActivitySummary counts events within the window", () => {
  const events = [
    { type: "claim_created", at: 1000, stake: 100n },
    { type: "claim_challenged", at: 2000, stake: 50n },
    { type: "claim_resolved", at: 3000, stake: 20n },
    { type: "squad_deposit", at: 4000, amount: 500n },
    { type: "squad_withdrawal", at: 5000, amount: 200n },
  ];

  const summary = buildActivitySummary(events, { from: 1000, to: 5000 });

  assert.strictEqual(summary.claimsCreated, 1);
  assert.strictEqual(summary.claimsChallenged, 1);
  assert.strictEqual(summary.claimsResolved, 1);
  assert.strictEqual(summary.squadDeposits, 1);
  assert.strictEqual(summary.squadWithdrawals, 1);
  assert.strictEqual(summary.other, 0);
  assert.strictEqual(summary.totalStake, 170n);
  assert.strictEqual(summary.totalDepositVolume, 500n);
});

test("buildActivitySummary ignores events outside the window", () => {
  const events = [
    { type: "claim_created", at: 999, stake: 1000n },
    { type: "claim_created", at: 1000, stake: 10n },
    { type: "claim_created", at: 5000, stake: 20n },
    { type: "claim_created", at: 5001, stake: 3000n },
  ];

  const summary = buildActivitySummary(events, { from: 1000, to: 5000 });

  assert.strictEqual(summary.claimsCreated, 2);
  assert.strictEqual(summary.totalStake, 30n);
});

test("buildActivitySummary counts unknown and admin events as other", () => {
  const events = [
    { type: "admin_pause", at: 1000 },
    { type: "unknown_event", at: 2000 },
    { type: "claim_created", at: 3000, stake: 5n },
  ];

  const summary = buildActivitySummary(events, { from: 1000, to: 3000 });

  assert.strictEqual(summary.other, 2);
  assert.strictEqual(summary.claimsCreated, 1);
});

test("activitySummaryMessage renders counts and volumes", () => {
  const summary = buildActivitySummary(
    [
      { type: "claim_created", at: 1000, stake: 100n },
      { type: "squad_deposit", at: 2000, amount: 500n },
    ],
    { from: 1000, to: 2000 },
  );

  const message = activitySummaryMessage(summary);

  assert.matches(message, /Claims created: 1/);
  assert.matches(message, /Squad deposits: 1/);
  assert.matches(message, /Total stake:/);
  assert.matches(message, /Total deposit volume:/);
});
