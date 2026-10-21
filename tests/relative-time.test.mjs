/**
 * tests/relative-time.test.mjs
 *
 * Test suite for relative deadline formatting in squad markets:
 *   - formatRelative: seconds, minutes, hours, days, past values, boundary cases
 *   - formatDeadline: relative context + absolute UTC time
 *   - formatEvent / formatPlainTextEvent: market_created deadline formatting with nowMs injection
 *   - MarkdownV2 escaping and plain-text cleanliness
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  formatRelative,
  formatDeadline,
} from "../dist/notifications/time.js";

import {
  formatEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";

// ── Shared fixtures ─────────────────────────────────────────────────────────

const BASE_NOW_SEC = 1_700_000_000;
const BASE_NOW_MS = BASE_NOW_SEC * 1000;

function dummyConfig(overrides = {}) {
  return {
    marketContractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
    squadContractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatIds: ["-1001234567890"],
    ...overrides,
  };
}

function sampleSquadMarketCreated(deadlineSec, overrides = {}) {
  return {
    source: "squad",
    contractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    version: "v1",
    ledger: 1000,
    txHash: "",
    at: BASE_NOW_SEC,
    eventId: "1000-0",
    eventType: "contract",
    transactionIndex: null,
    operationIndex: null,
    inSuccessfulContractCall: null,
    payload: {
      name: "market_created",
      marketId: 42,
      captain: "GCAPTAINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      feeBps: 200,
      question: "Will Soroban reach 1000 TPS?",
      deadline: deadlineSec,
      ...overrides,
    },
  };
}

// ── formatDuration tests ───────────────────────────────────────────────────

test("formatDuration: formats seconds under a minute", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(1), "1s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(59), "59s");
});

test("formatDuration: formats minutes", () => {
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(12 * 60), "12m");
  assert.equal(formatDuration(12 * 60 + 35), "12m"); // sub-minute discarded
  assert.equal(formatDuration(59 * 60), "59m");
});

test("formatDuration: formats hours and hours+minutes", () => {
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(2 * 3600), "2h");
  assert.equal(formatDuration(2 * 3600 + 15 * 60), "2h 15m");
  assert.equal(formatDuration(2 * 3600 + 15 * 60 + 40), "2h 15m"); // seconds omitted
  assert.equal(formatDuration(23 * 3600), "23h");
});

test("formatDuration: formats days and days+hours", () => {
  assert.equal(formatDuration(86400), "1d");
  assert.equal(formatDuration(3 * 86400), "3d");
  assert.equal(formatDuration(3 * 86400 + 4 * 3600), "3d 4h");
  assert.equal(formatDuration(3 * 86400 + 4 * 3600 + 20 * 60), "3d 4h"); // minutes omitted
});

// ── formatRelative: Future durations ───────────────────────────────────────

test("formatRelative: seconds in the future", () => {
  assert.equal(formatRelative(BASE_NOW_SEC + 1, BASE_NOW_MS), "in 1s");
  assert.equal(formatRelative(BASE_NOW_SEC + 45, BASE_NOW_MS), "in 45s");
  assert.equal(formatRelative(BASE_NOW_SEC + 59, BASE_NOW_MS), "in 59s");
});

test("formatRelative: minutes in the future", () => {
  assert.equal(formatRelative(BASE_NOW_SEC + 60, BASE_NOW_MS), "in 1m");
  assert.equal(formatRelative(BASE_NOW_SEC + 12 * 60, BASE_NOW_MS), "in 12m");
  assert.equal(formatRelative(BASE_NOW_SEC + 45 * 60, BASE_NOW_MS), "in 45m");
});

test("formatRelative: hours in the future", () => {
  assert.equal(formatRelative(BASE_NOW_SEC + 2 * 3600, BASE_NOW_MS), "in 2h");
  assert.equal(formatRelative(BASE_NOW_SEC + 2 * 3600 + 15 * 60, BASE_NOW_MS), "in 2h 15m");
  assert.equal(formatRelative(BASE_NOW_SEC + 18 * 3600, BASE_NOW_MS), "in 18h");
});

test("formatRelative: days in the future", () => {
  assert.equal(formatRelative(BASE_NOW_SEC + 3 * 86400 + 4 * 3600, BASE_NOW_MS), "in 3d 4h");
  assert.equal(formatRelative(BASE_NOW_SEC + 3 * 86400, BASE_NOW_MS), "in 3d");
  assert.equal(formatRelative(BASE_NOW_SEC + 7 * 86400 + 12 * 3600, BASE_NOW_MS), "in 7d 12h");
});

// ── formatRelative: Past durations (Acceptance: labelled as ended) ─────────

test("formatRelative: past seconds are labelled as ended with duration", () => {
  assert.equal(formatRelative(BASE_NOW_SEC - 1, BASE_NOW_MS), "ended 1s ago");
  assert.equal(formatRelative(BASE_NOW_SEC - 45, BASE_NOW_MS), "ended 45s ago");
});

test("formatRelative: past minutes are labelled as ended with duration", () => {
  assert.equal(formatRelative(BASE_NOW_SEC - 12 * 60, BASE_NOW_MS), "ended 12m ago");
  assert.equal(formatRelative(BASE_NOW_SEC - 30 * 60, BASE_NOW_MS), "ended 30m ago");
});

test("formatRelative: past hours are labelled as ended with duration", () => {
  assert.equal(formatRelative(BASE_NOW_SEC - 2 * 3600, BASE_NOW_MS), "ended 2h ago");
  assert.equal(formatRelative(BASE_NOW_SEC - (2 * 3600 + 15 * 60), BASE_NOW_MS), "ended 2h 15m ago");
});

test("formatRelative: past days are labelled as ended with duration", () => {
  assert.equal(formatRelative(BASE_NOW_SEC - (3 * 86400 + 4 * 3600), BASE_NOW_MS), "ended 3d 4h ago");
  assert.equal(formatRelative(BASE_NOW_SEC - 5 * 86400, BASE_NOW_MS), "ended 5d ago");
});

test("formatRelative: zero difference is labelled as ended", () => {
  assert.equal(formatRelative(BASE_NOW_SEC, BASE_NOW_MS), "ended");
});

test("formatRelative: invalid/non-finite inputs degrade safely to empty string", () => {
  assert.equal(formatRelative(NaN, BASE_NOW_MS), "");
  assert.equal(formatRelative(Infinity, BASE_NOW_MS), "");
  assert.equal(formatRelative(-Infinity, BASE_NOW_MS), "");
});

// ── formatDeadline: relative + absolute UTC time ────────────────────────────

test("formatDeadline combines relative duration and absolute UTC ISO timestamp", () => {
  const targetSec = BASE_NOW_SEC + 3 * 86400 + 4 * 3600;
  const iso = new Date(targetSec * 1000).toISOString();
  const deadlineStr = formatDeadline(targetSec, BASE_NOW_MS);

  assert.equal(deadlineStr, `in 3d 4h (${iso})`);
});

test("formatDeadline for past deadline uses ended label and absolute UTC ISO timestamp", () => {
  const targetSec = BASE_NOW_SEC - 2 * 3600;
  const iso = new Date(targetSec * 1000).toISOString();
  const deadlineStr = formatDeadline(targetSec, BASE_NOW_MS);

  assert.equal(deadlineStr, `ended 2h ago (${iso})`);
});

// ── Integration: formatEvent (MarkdownV2) ───────────────────────────────────

test("formatEvent: renders relative deadline and absolute UTC time in MarkdownV2", () => {
  const deadlineSec = BASE_NOW_SEC + 3 * 86400 + 4 * 3600;
  const event = sampleSquadMarketCreated(deadlineSec);
  const result = formatEvent(dummyConfig(), event, BASE_NOW_MS);

  assert.ok(result !== null);
  assert.match(result, /🆕 \*New squad market\* \\#42/);
  assert.match(result, /deadline in 3d 4h/);
  // Verify MarkdownV2 escaped ISO date and parentheses
  const isoPart = new Date(deadlineSec * 1000).toISOString().replace(/[-.]/g, "\\$&");
  assert.ok(result.includes(`\\(${isoPart}\\)`), "Parentheses and date must be MarkdownV2 escaped");
});

test("formatEvent: past deadline renders ended label and escaped parentheses", () => {
  const deadlineSec = BASE_NOW_SEC - 2 * 3600;
  const event = sampleSquadMarketCreated(deadlineSec);
  const result = formatEvent(dummyConfig(), event, BASE_NOW_MS);

  assert.ok(result !== null);
  assert.match(result, /deadline ended 2h ago/);
  const isoPart = new Date(deadlineSec * 1000).toISOString().replace(/[-.]/g, "\\$&");
  assert.ok(result.includes(`\\(${isoPart}\\)`), "Past deadline parentheses must be MarkdownV2 escaped");
});

test("formatEvent: respects config.nowMs when 3rd arg is omitted", () => {
  const deadlineSec = BASE_NOW_SEC + 12 * 60;
  const event = sampleSquadMarketCreated(deadlineSec);
  const config = dummyConfig({ nowMs: BASE_NOW_MS });
  const result = formatEvent(config, event);

  assert.ok(result !== null);
  assert.match(result, /deadline in 12m/);
});

// ── Integration: formatPlainTextEvent (Plain text) ──────────────────────────

test("formatPlainTextEvent: renders relative deadline and absolute UTC time without Markdown escaping", () => {
  const deadlineSec = BASE_NOW_SEC + 3 * 86400 + 4 * 3600;
  const event = sampleSquadMarketCreated(deadlineSec);
  const result = formatPlainTextEvent(dummyConfig(), event, BASE_NOW_MS);

  assert.ok(result !== null);
  assert.match(result, /New squad market #42/);
  assert.match(result, /deadline in 3d 4h/);
  const iso = new Date(deadlineSec * 1000).toISOString();
  assert.ok(result.includes(`(${iso})`), "Unescaped parentheses in plain text");
  assert.equal(result.includes("\\"), false, "Plain text must not contain backslash escapes");
  assert.equal(result.includes("*"), false, "Plain text must not contain markdown asterisks");
});

test("formatPlainTextEvent: past deadline renders ended label in plain text", () => {
  const deadlineSec = BASE_NOW_SEC - 2 * 3600;
  const event = sampleSquadMarketCreated(deadlineSec);
  const result = formatPlainTextEvent(dummyConfig(), event, BASE_NOW_MS);

  assert.ok(result !== null);
  assert.match(result, /deadline ended 2h ago/);
  const iso = new Date(deadlineSec * 1000).toISOString();
  assert.ok(result.includes(`(${iso})`));
  assert.equal(result.includes("\\"), false);
});
