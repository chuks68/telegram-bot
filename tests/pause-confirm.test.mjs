/**
 * Tests for the /pause confirmation flow:
 *   - operator confirm → calls pause(), edits message with result
 *   - operator cancel → edits message with cancellation text
 *   - expired confirmation → rejects with alert, edits message
 *   - non-operator → rejected with alert, pause() never called
 *   - validateCallbackData accepts known actions and rejects unknown
 *   - operatorKeyboard buttons use strings within Telegram's 64-byte limit
 *   - /pause command sends confirmation prompt (no immediate pause)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  handleCallbackQuery,
  validatePauseCallbackData,
  pauseConfirmationKeyboard,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_PAUSE_CANCEL,
  PAUSE_CONFIRM_TTL_MS,
  registerCommandHandlers,
} from "../dist/bot.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    ...overrides,
  };
}

/**
 * Builds a fake grammy callback-query context.
 *
 * @param {object} opts
 * @param {number}  opts.userId      - Telegram user id for ctx.from.id
 * @param {string}  opts.data        - callback_query.data
 * @param {number}  opts.messageDate - Unix seconds for the originating message
 */
function callbackCtx({ userId, data, messageDate = Math.floor(Date.now() / 1000) }) {
  const answered = [];
  const edits = [];

  const ctx = {
    from: { id: userId },
    callbackQuery: {
      data,
      message: { date: messageDate },
    },
    answerCallbackQuery: async (opts = {}) => {
      answered.push(opts);
    },
    editMessageText: async (text, opts) => {
      edits.push({ text, opts });
    },
  };

  return { ctx, answered, edits };
}

/** Freeze time so expiry arithmetic is deterministic. */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ── validateCallbackData ──────────────────────────────────────────────────────

test("validatePauseCallbackData accepts pause-confirm", () => {
  assert.equal(validatePauseCallbackData(CALLBACK_PAUSE_CONFIRM), CALLBACK_PAUSE_CONFIRM);
});

test("validatePauseCallbackData accepts pause-cancel", () => {
  assert.equal(validatePauseCallbackData(CALLBACK_PAUSE_CANCEL), CALLBACK_PAUSE_CANCEL);
});

test("validatePauseCallbackData rejects unknown data", () => {
  assert.equal(validatePauseCallbackData("bad-action"), null);
});

test("validatePauseCallbackData rejects undefined", () => {
  assert.equal(validatePauseCallbackData(undefined), null);
});

test("validatePauseCallbackData rejects empty string", () => {
  assert.equal(validatePauseCallbackData(""), null);
});

// ── operatorKeyboard ──────────────────────────────────────────────────────────

test("operatorKeyboard button callback_data strings are within Telegram's 64-byte limit", () => {
  assert.ok(
    Buffer.byteLength(CALLBACK_PAUSE_CONFIRM, "utf8") <= 64,
    `pause-confirm exceeds 64 bytes`,
  );
  assert.ok(
    Buffer.byteLength(CALLBACK_PAUSE_CANCEL, "utf8") <= 64,
    `pause-cancel exceeds 64 bytes`,
  );
});

test("pauseConfirmationKeyboard returns an object with inline_keyboard rows", () => {
  const kb = pauseConfirmationKeyboard();
  // grammy InlineKeyboard serialises to { inline_keyboard: Button[][] }
  const serialised = kb.inline_keyboard;
  assert.ok(Array.isArray(serialised), "inline_keyboard is an array");
  const allButtons = serialised.flat();
  const callbackDatas = allButtons.map((b) => b.callback_data);
  assert.ok(callbackDatas.includes(CALLBACK_PAUSE_CONFIRM));
  assert.ok(callbackDatas.includes(CALLBACK_PAUSE_CANCEL));
});

// ── handleCallbackQuery — confirm ────────────────────────────────────────────

test("operator confirm: calls pause(), answers query, edits message with pauseMessage result", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds(); // fresh message
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 500); // 0.5 s after send

  assert.equal(pauseCalls, 1);
  // answerCallbackQuery was called (no show_alert)
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, undefined);
  // message was edited to the pause result
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /\*Polling paused\*/);
});

test("operator confirm already-paused: edits message with already-paused text", async () => {
  const deps = {
    config: baseConfig(),
    pause: () => "already-paused",
  };

  const messageDate = nowSeconds();
  const { ctx, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 100);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /already paused/i);
});

// ── handleCallbackQuery — cancel ─────────────────────────────────────────────

test("operator cancel: does NOT call pause(), answers with text, edits message", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CANCEL,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, "Cancelled.");
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Pause cancelled/);
});

// ── handleCallbackQuery — expired ────────────────────────────────────────────

test("expired confirmation: answers with alert, edits expiry message, does NOT call pause()", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds() - 120; // 2 minutes old — well past TTL
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 1000; // 1 s past expiry
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, nowMs);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.match(answered[0].text, /expired/i);
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /expired/i);
});

test("confirmation exactly at TTL boundary is still valid", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  // nowMs is exactly at the TTL — ageMs === PAUSE_CONFIRM_TTL_MS, not > it
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS;
  const { ctx } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, nowMs);

  assert.equal(pauseCalls, 1);
});

// ── handleCallbackQuery — non-operator ───────────────────────────────────────

test("non-operator confirm: answers with alert, does NOT call pause() or edit message", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(), // operatorTelegramUserId: "42"
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 99, // not the operator
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.match(answered[0].text, /operator/i);
  assert.equal(edits.length, 0);
});

test("non-operator cancel: answers with alert, does NOT edit message", async () => {
  const deps = {
    config: baseConfig(),
    pause: () => "paused",
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 99,
    data: CALLBACK_PAUSE_CANCEL,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 500);

  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(edits.length, 0);
});

test("no operator configured: non-operator confirm is rejected", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig({ operatorTelegramUserId: null }),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handleCallbackQuery(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(edits.length, 0);
});

// ── /pause command ────────────────────────────────────────────────────────────

function mockedBot(deps) {
  const commandHandlers = new Map();
  const callbackHandlers = [];
  const bot = {
    command(name, handler) {
      commandHandlers.set(name, handler);
    },
    callbackQuery(_filter, handler) {
      callbackHandlers.push(handler);
    },
  };
  registerCommandHandlers(bot, deps);
  return { commandHandlers, callbackHandlers };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

test("/pause by operator sends confirmation prompt with inline keyboard, does NOT call pause()", async () => {
  let pauseCalls = 0;
  const { commandHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  const replies = [];
  const ctx = {
    from: { id: 42 },
    update: { update_id: 200 },
    reply: async (...args) => {
      replies.push(args);
    },
  };

  await commandHandlers.get("pause")(ctx);

  assert.equal(pauseCalls, 0, "pause() must not be called before confirmation");
  assert.equal(replies.length, 1);
  const [text, opts] = replies[0];
  assert.match(text, /Pause polling/);
  // reply_markup must carry the keyboard
  assert.ok(opts.reply_markup, "reply should include reply_markup");
  assert.ok(opts.reply_markup.inline_keyboard, "reply_markup should have inline_keyboard");
});

test("/pause by non-operator sends no reply and does not call pause()", async () => {
  let pauseCalls = 0;
  const { commandHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  const replies = [];
  const ctx = {
    from: { id: 99 },
    update: { update_id: 201 },
    reply: async (...args) => {
      replies.push(args);
    },
  };

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await commandHandlers.get("pause")(ctx);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(pauseCalls, 0);
  assert.deepEqual(replies, []);
});

test("registerCommandHandlers registers a callbackQuery handler for pause actions", () => {
  const { callbackHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  assert.equal(callbackHandlers.length, 1, "exactly one callbackQuery handler should be registered");
});
