/**
 * Tests for src/notifications/startup.ts → dist/notifications/startup.js
 *
 * Covers:
 *  - Cold start: all targets show "cold start", no ledger numbers
 *  - Resumed: targets show their resume ledger
 *  - Webhook mode: mode line says "webhook" not "long-polling"
 *  - Long-polling mode (default): mode line says "long-polling"
 *  - Mixed: one target cold, one resumed
 *  - Safety: no tokens, no chat ids; contract ids appear only as shortAddress
 *  - MarkdownV2: contract ids and dynamic values are escaped
 *  - Output fits in one Telegram message (≤ 4096 chars)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startupMessage } from "../dist/notifications/startup.js";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../dist/notifications/format.js";

// ── Minimal config fixture ────────────────────────────────────────────────────

const BASE_CONFIG = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  marketContractId:  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  squadContractId:   "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4A",
  marketContractVersion: "v1",
  squadContractVersion:  "v1",
  pollIntervalMs: 30_000,
  telegramWebhookUrl: null,   // long-polling by default
  // Required by StellarConfig (used internally by networkLabel)
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
};

// ── Cold start ────────────────────────────────────────────────────────────────

test("cold start: header includes network", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  assert.ok(msg.includes("testnet"), "expected network label in output");
});

test("cold start: both targets show 'cold start'", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  const coldCount = (msg.match(/cold start/g) ?? []).length;
  assert.equal(coldCount, 2, "expected two 'cold start' labels, one per target");
});

test("cold start: no ledger numbers appear", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  assert.doesNotMatch(
    msg,
    /resuming from ledger/,
    "cold start must not mention 'resuming from ledger'",
  );
});

test("cold start: market target is listed", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  assert.match(msg, /mimir\\-market/, "expected mimir-market target line");
});

test("cold start: squad target is listed", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  assert.match(msg, /mimir\\-squad/, "expected mimir-squad target line");
});

test("cold start: version defaults to 'unknown' when omitted", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  assert.match(msg, /unknown/, "expected 'unknown' version fallback");
});

test("cold start: explicit version appears in output", () => {
  const msg = startupMessage({ config: BASE_CONFIG, version: "1.2.3" });
  // escapeMd turns "1.2.3" into "1\.2\.3" — check for the escaped form
  assert.ok(msg.includes("1\\.2\\.3"), "expected escaped version string '1\\.2\\.3'");
});

// ── Resumed ───────────────────────────────────────────────────────────────────

test("resumed: both targets show their ledger numbers", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    resumeLedgers: [
      { source: "market", ledger: 5_100_000 },
      { source: "squad",  ledger: 5_100_050 },
    ],
  });
  assert.match(msg, /5100000/, "expected market resume ledger");
  assert.match(msg, /5100050/, "expected squad resume ledger");
});

test("resumed: 'resuming from ledger' appears for each target", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    resumeLedgers: [
      { source: "market", ledger: 1_000_000 },
      { source: "squad",  ledger: 1_000_001 },
    ],
  });
  const resumeCount = (msg.match(/resuming from ledger/g) ?? []).length;
  assert.equal(resumeCount, 2, "expected two 'resuming from ledger' labels");
});

test("resumed: 'cold start' does not appear when all targets have a ledger", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    resumeLedgers: [
      { source: "market", ledger: 42 },
      { source: "squad",  ledger: 43 },
    ],
  });
  assert.doesNotMatch(msg, /cold start/, "fully resumed start must not say 'cold start'");
});

// ── Mixed: one cold, one resumed ──────────────────────────────────────────────

test("mixed: market cold, squad resumed — each is labelled correctly", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    resumeLedgers: [
      { source: "market", ledger: null },
      { source: "squad",  ledger: 9_999_999 },
    ],
  });
  assert.match(msg, /cold start/, "market target must say 'cold start'");
  assert.match(msg, /9999999/,    "squad target must show its resume ledger");
});

test("mixed: market resumed, squad cold — each is labelled correctly", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    resumeLedgers: [
      { source: "market", ledger: 7_654_321 },
      { source: "squad",  ledger: null },
    ],
  });
  assert.match(msg, /7654321/,   "market target must show its resume ledger");
  assert.match(msg, /cold start/, "squad target must say 'cold start'");
});

// ── Polling mode ──────────────────────────────────────────────────────────────

test("long-polling mode: mode line says 'long-polling'", () => {
  const msg = startupMessage({ config: { ...BASE_CONFIG, telegramWebhookUrl: null } });
  // escapeMd turns "long-polling" into "long\-polling" in the output string
  assert.ok(msg.includes("long\\-polling"), "expected 'long\\-polling' in mode line");
  assert.doesNotMatch(msg, /webhook/, "must not say 'webhook' in long-polling mode");
});

test("webhook mode: mode line says 'webhook'", () => {
  const msg = startupMessage({
    config: { ...BASE_CONFIG, telegramWebhookUrl: "https://bot.example.com" },
  });
  assert.match(msg, /webhook/, "expected 'webhook' in mode line");
  assert.doesNotMatch(msg, /long.polling/, "must not say 'long-polling' in webhook mode");
});

test("webhook mode: URL is not echoed in the output", () => {
  const webhookUrl = "https://bot.example.com/secret-path";
  const msg = startupMessage({
    config: { ...BASE_CONFIG, telegramWebhookUrl: webhookUrl },
  });
  assert.doesNotMatch(
    msg,
    /example\.com/,
    "webhook URL must not appear in the startup message",
  );
});

// ── Poll interval ─────────────────────────────────────────────────────────────

test("poll interval is rendered in seconds", () => {
  const msg = startupMessage({ config: { ...BASE_CONFIG, pollIntervalMs: 15_000 } });
  assert.match(msg, /15s/, "expected poll interval in seconds");
});

// ── Network label ─────────────────────────────────────────────────────────────

test("mainnet passphrase resolves to 'public' label", () => {
  // When network field is absent, networkLabel infers from the passphrase.
  // Explicitly setting network: "mainnet" returns "mainnet", not "public".
  const { network: _omit, ...configWithoutNetwork } = BASE_CONFIG;
  const msg = startupMessage({
    config: {
      ...configWithoutNetwork,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    },
  });
  assert.match(msg, /public/, "mainnet passphrase should produce 'public' label");
});

// ── Safety: no secrets ────────────────────────────────────────────────────────

test("full contract ids do not appear (shortAddress is used instead)", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  // shortAddress truncates addresses longer than 12 chars, so the full 56-char
  // strkey must not appear verbatim.
  assert.doesNotMatch(
    msg,
    new RegExp(BASE_CONFIG.marketContractId),
    "full market contract id must not appear in output",
  );
  assert.doesNotMatch(
    msg,
    new RegExp(BASE_CONFIG.squadContractId),
    "full squad contract id must not appear in output",
  );
});

// ── MarkdownV2 escaping ───────────────────────────────────────────────────────

test("output contains no bare unescaped hyphens in mimir-source lines", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  // The source label is escaped as "mimir\-market" / "mimir\-squad"
  assert.match(msg, /mimir\\-market/, "hyphen in 'mimir-market' must be escaped");
  assert.match(msg, /mimir\\-squad/,  "hyphen in 'mimir-squad' must be escaped");
});

test("contract version parentheses are escaped", () => {
  const msg = startupMessage({ config: BASE_CONFIG });
  // escapeMd turns "(v1)" into "\(v1\)" — check for the literal escaped form
  assert.ok(msg.includes("\\(v1\\)"), "version parentheses must be MarkdownV2-escaped");
});

// ── Size bound ────────────────────────────────────────────────────────────────

test("output fits in a single Telegram message", () => {
  const msg = startupMessage({
    config: BASE_CONFIG,
    version: "0.1.0",
    resumeLedgers: [
      { source: "market", ledger: 9_999_999 },
      { source: "squad",  ledger: 9_999_998 },
    ],
  });
  assert.ok(
    msg.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `message length ${msg.length} exceeds Telegram limit of ${TELEGRAM_MAX_MESSAGE_LENGTH}`,
  );
});
