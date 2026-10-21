/**
 * Notifier empty-text guard.
 *
 * Telegram rejects empty or whitespace-only `sendMessage` text with a 400,
 * so no notifier code path may send one. The formatters can return empty
 * strings, whitespace-only strings, or null for unusual payloads, so the
 * notifier — the single choke point every send goes through — must skip
 * those renders instead of forwarding them to the Bot API.
 *
 * Covers:
 *   - MarkdownV2 path: empty, whitespace-only, null, non-string and
 *     oversized-blank renders are skipped before any API call
 *   - Plain-text fallback: a blank `extra.plainText` never retries
 *   - Digest path: `formatDigest([])` is null and is skipped; a real digest
 *     still sends exactly once
 *   - Every `sendMessage` call carries non-blank text
 *   - Skipped sends are counted (`notifierSkips`) and logged, never silent
 *
 * No live network calls.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GrammyError } from "grammy";

import { createNotifier, notifierSkips } from "../dist/bot.js";
import {
  formatDigest,
  formatEvent,
  formatPlainTextEvent,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";

const VALID_TX = "0123456789abcdef".repeat(4);

function testnetConfig(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatId: "-1001234567890",
    marketChatId: "-1001234567891",
    squadChatId: "-1001234567892",
    ...overrides,
  };
}

function claimChallengedEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "market",
    ledger: 4226692,
    txHash: VALID_TX,
    at: 0,
    eventId: "0018276211125911551-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
    ...overrides,
  };
}

/** Real grammy error shape for a MarkdownV2 entity rejection. */
function parseError() {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code: 400,
      description:
        "Bad Request: can't parse entities: character '.' is reserved and must be escaped with a preceding '\\'",
    },
    "sendMessage",
    {},
  );
}

/** Fake Bot API that records every `sendMessage` call, optionally scripted. */
function collectingBot(behavior = async () => ({})) {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return behavior(sent.length, args);
      },
    },
  };
  return { fakeBot, sent };
}

/**
 * The invariant every test in this file leans on: a call into the Telegram
 * API never carries empty or whitespace-only text.
 */
function assertNoEmptySends(sent) {
  for (const [chatId, text] of sent) {
    assert.equal(
      typeof text,
      "string",
      `sendMessage text must be a string, got ${typeof text} for chat ${chatId}`,
    );
    assert.ok(
      text.trim() !== "",
      `sendMessage must never carry empty or whitespace-only text (got ${JSON.stringify(text)} for chat ${chatId})`,
    );
  }
}

/** Run `fn` with `console.warn` captured, returning the collected lines. */
async function captureWarns(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (message) => {
    lines.push(String(message));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

/** Counter delta helper: the skip counter is process-wide and cumulative. */
function skipDelta(before) {
  return notifierSkips.emptyText - before;
}

// ── MarkdownV2 path: blank renders are skipped, counted and logged ───────────

test("empty, whitespace, null and non-string renders never reach sendMessage", async () => {
  const config = testnetConfig();
  const blankRenderings = [
    ["empty string", ""],
    ["spaces", "     "],
    ["newlines and tabs", "\n\t\r \n"],
    ["null (formatter said skip)", null],
    ["undefined", undefined],
  ];

  for (const [label, rendering] of blankRenderings) {
    const { fakeBot, sent } = collectingBot();
    const before = notifierSkips.emptyText;

    const warns = await captureWarns(() =>
      createNotifier(fakeBot, config)(rendering, "market"),
    );

    assert.equal(sent.length, 0, `${label}: no sendMessage call may be made`);
    assertNoEmptySends(sent);
    assert.equal(skipDelta(before), 1, `${label}: the skip must be counted exactly once`);
    assert.equal(warns.length, 1, `${label}: the skip must be logged exactly once`);
    assert.ok(warns[0].includes("[notifier] skipped empty message"), warns[0]);
    assert.ok(warns[0].includes("source=market"), warns[0]);
  }
});

test("an oversized whitespace-only render is skipped before chunking", async () => {
  const config = testnetConfig();
  const hugeBlank = " \n".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.ok(hugeBlank.length > TELEGRAM_MAX_MESSAGE_LENGTH, "must exceed the split threshold");

  const { fakeBot, sent } = collectingBot();
  const before = notifierSkips.emptyText;

  await captureWarns(() => createNotifier(fakeBot, config)(hugeBlank, "squad"));

  assert.equal(sent.length, 0, "blank text must not be split into chunks either");
  assertNoEmptySends(sent);
  assert.equal(skipDelta(before), 1);
});

test("skips are logged with bounded metadata and never leak the bot token", async () => {
  const config = testnetConfig({ botToken: "123456:SECRET-TOKEN" });
  const { fakeBot, sent } = collectingBot();
  const before = notifierSkips.emptyText;

  const warns = await captureWarns(() =>
    createNotifier(fakeBot, config)("", "market", {
      eventRef: { source: "market", ledger: 4226692, eventId: "0018276211125911551-0000000001" },
    }),
  );

  assert.equal(sent.length, 0);
  assert.equal(skipDelta(before), 1);
  const wire = JSON.stringify(warns);
  assert.ok(
    wire.includes("[notifier] skipped empty message (market ledger 4226692 0018276211125911551-0000000001)"),
    wire,
  );
  assert.ok(wire.includes("source=market"), wire);
  assert.ok(wire.includes("chars=0"), wire);
  assert.ok(!wire.includes("SECRET-TOKEN"), "no token in skip logs");
});

// ── Formatter-driven renders (MarkdownV2, plain fallback, digest) ────────────

test("null renders from formatEvent, formatPlainTextEvent and formatDigest are skipped", async () => {
  const config = testnetConfig();
  // An unknown event name is the formatters' canonical "nothing to say".
  const unknown = claimChallengedEvent({ payload: { name: "unknown", eventName: "x" } });

  assert.equal(formatEvent(config, unknown), null, "fixture must render null");
  assert.equal(formatPlainTextEvent(config, unknown), null, "fixture must render null");
  assert.equal(formatDigest([]), null, "empty burst must render null");

  for (const [label, rendering] of [
    ["formatEvent", formatEvent(config, unknown)],
    ["formatPlainTextEvent", formatPlainTextEvent(config, unknown)],
    ["formatDigest([])", formatDigest([])],
  ]) {
    const { fakeBot, sent } = collectingBot();
    const before = notifierSkips.emptyText;
    await captureWarns(() => createNotifier(fakeBot, config)(rendering, "market"));
    assert.equal(sent.length, 0, `${label}: null render must not be sent`);
    assertNoEmptySends(sent);
    assert.equal(skipDelta(before), 1, `${label}: null render must be counted`);
  }
});

test("a real event and a real digest still send exactly once (guard does not over-trigger)", async () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();

  const mdText = formatEvent(config, event);
  assert.ok(mdText && mdText.trim() !== "", "fixture must render non-blank MarkdownV2");

  const digestText = formatDigest([event]);
  assert.ok(digestText && digestText.trim() !== "", "fixture must render a non-blank digest");

  for (const [label, rendering, source] of [
    ["formatEvent", mdText, "market"],
    ["formatDigest", digestText, undefined],
  ]) {
    const { fakeBot, sent } = collectingBot();
    const before = notifierSkips.emptyText;
    await createNotifier(fakeBot, config)(rendering, source);
    assert.equal(sent.length, 1, `${label}: sends exactly once`);
    assert.equal(sent[0][1], rendering, `${label}: text arrives unmodified`);
    assertNoEmptySends(sent);
    assert.equal(skipDelta(before), 0, `${label}: no skip counted`);
  }
});

// ── Plain-text fallback path ─────────────────────────────────────────────────

test("a blank plain-text fallback never retries and the parse error propagates", async () => {
  const config = testnetConfig();
  const mdText = formatEvent(config, claimChallengedEvent());
  assert.ok(mdText, "fixture must render");

  for (const blank of ["", "   ", "\n\t "]) {
    const err = parseError();
    const { fakeBot, sent } = collectingBot(async () => {
      throw err;
    });

    await assert.rejects(
      createNotifier(fakeBot, config)(mdText, "market", { plainText: blank }),
      (e) => e === err,
      "the original MarkdownV2 rejection must surface for the poller to count",
    );

    assert.equal(sent.length, 1, "only the MarkdownV2 attempt; no blank retry");
    assertNoEmptySends(sent);
  }
});

test("a non-blank plain-text fallback still retries exactly once", async () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();
  const mdText = formatEvent(config, event);
  const plain = formatPlainTextEvent(config, event);
  assert.ok(plain && plain.trim() !== "", "fixture must render plain text");

  const { fakeBot, sent } = collectingBot(async (n) => {
    if (n === 1) throw parseError();
    return {};
  });
  await createNotifier(fakeBot, config)(mdText, "market", { plainText: plain });

  assert.equal(sent.length, 2, "MarkdownV2 attempt + one plain-text retry");
  assertNoEmptySends(sent);
  assert.equal(sent[0][2]?.parse_mode, "MarkdownV2");
  assert.ok(!("parse_mode" in (sent[1][2] ?? {})), "retry carries no parse_mode");
  assert.equal(sent[1][1], plain, "retry delivers the plain-text twin verbatim");
});
