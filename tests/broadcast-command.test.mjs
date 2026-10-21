import assert from "node:assert/strict";
import test from "node:test";

import {
  handleBroadcastCommand,
  handleBroadcastCallback,
  registerBroadcastHandlers,
  getConfiguredBroadcastChats,
  BroadcastStore,
  sendBroadcast,
  formatBroadcastPreview,
  formatBroadcastReport,
  MAX_BROADCAST_LENGTH,
  BROADCAST_USAGE_MESSAGE,
  BROADCAST_TOO_LONG_MESSAGE,
  BROADCAST_NO_CHATS_MESSAGE,
} from "../dist/commands/broadcast.js";
import {
  handleCallbackQuery,
  validateCallbackData,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
} from "../dist/bot.js";

function fakeConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN_123456789:ABCDEF",
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketChatId: "-100111", // duplicate of main chatId
    squadChatId: "-100333",
    operatorTelegramUserId: "42",
    interSendDelayMs: 1500,
    ...overrides,
  };
}

function createFakeApi() {
  const sent = [];
  const edits = [];
  const answeredCallbacks = [];

  const api = {
    sent,
    edits,
    answeredCallbacks,
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId: String(chatId), text, options });
      return { message_id: sent.length };
    },
    editMessageText: async (text, options) => {
      edits.push({ text, options });
      return true;
    },
    answerCallbackQuery: async (options) => {
      answeredCallbacks.push(options);
      return true;
    },
  };
  return api;
}

test("getConfiguredBroadcastChats collects and deduplicates chats from all sources", () => {
  const config = fakeConfig({
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketChatId: "-100111",
    squadChatId: "-100333",
  });
  const chats = getConfiguredBroadcastChats(config);
  assert.deepEqual(chats, ["-100111", "-100222", "-100333"]);
});

test("getConfiguredBroadcastChats handles single chatId without chatIds", () => {
  const config = {
    chatId: "-100999",
    marketChatId: "-100888",
  };
  const chats = getConfiguredBroadcastChats(config);
  assert.deepEqual(chats, ["-100999", "-100888"]);
});

test("Authorization: non-operator in private chat is ignored", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const replies = [];
  const ctx = {
    from: { id: 999 }, // non-operator
    chat: { id: 999, type: "private" },
    update: { update_id: 101 },
    message: { text: "/broadcast Maintenance in 10 minutes" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config });
  assert.equal(replies.length, 0, "No reply sent to non-operator");
});

test("Authorization: operator in group/channel is ignored", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: -100111, type: "group" }, // non-private
    update: { update_id: 102 },
    message: { text: "/broadcast Maintenance in 10 minutes" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config });
  assert.equal(replies.length, 0, "No reply sent in group chat");
});

test("Validation: empty message returns usage instructions", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 103 },
    message: { text: "/broadcast" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config });
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], BROADCAST_USAGE_MESSAGE);
});

test("Validation: oversized message is rejected", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const replies = [];
  const longText = "x".repeat(MAX_BROADCAST_LENGTH + 1);
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 104 },
    message: { text: `/broadcast ${longText}` },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config });
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], BROADCAST_TOO_LONG_MESSAGE);
});

test("Validation: missing chats returns no chats configured message", async () => {
  const config = fakeConfig({
    chatId: "",
    chatIds: [],
    marketChatId: "",
    squadChatId: "",
  });
  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 105 },
    message: { text: "/broadcast hello" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config });
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], BROADCAST_NO_CHATS_MESSAGE);
});

test("Preview: operator in private chat gets preview with confirm/cancel buttons", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 106 },
    message: { text: "/broadcast Maintenance scheduled for 02:00 UTC" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config, broadcastStore: store });
  assert.equal(replies.length, 1);
  const [text, options] = replies[0];
  assert.ok(text.includes("Maintenance scheduled for 02:00 UTC"));
  assert.ok(text.includes("Target chats (3)"));
  assert.ok(options?.reply_markup);

  const kb = options.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].text, "✅ Confirm");
  assert.ok(kb[0][0].callback_data.startsWith("broadcast:confirm:"));
  assert.equal(kb[0][1].text, "❌ Cancel");
  assert.ok(kb[0][1].callback_data.startsWith("broadcast:cancel:"));

  // Check callback data fits Telegram 64-byte limit
  for (const btn of kb[0]) {
    assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
    const valid = validateCallbackData(btn.callback_data);
    assert.equal(valid.ok, true);
    assert.equal(valid.action.type, "broadcast");
  }
});

test("Confirmation: on confirm, send plain text to each unique chat with inter-send delay", async () => {
  const config = fakeConfig({ interSendDelayMs: 250 });
  const store = new BroadcastStore();
  const pending = store.create("42", "Planned network upgrade in 10m", ["-100111", "-100222", "-100333"]);

  const api = createFakeApi();
  const edits = [];
  const delays = [];
  const fakeSleep = async (ms) => delays.push(ms);

  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 107 },
    api,
    callbackQuery: {
      id: "cb_1",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 100 },
    },
    editMessageText: async (text) => edits.push(text),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: fakeSleep },
    `broadcast:confirm:${pending.id}`,
  );

  // Delivered plain text to each unique chat
  assert.equal(api.sent.length, 3);
  const sentChatIds = api.sent.map((s) => s.chatId);
  assert.deepEqual(sentChatIds, ["-100111", "-100222", "-100333"]);

  for (const sendCall of api.sent) {
    assert.equal(sendCall.text, "Planned network upgrade in 10m");
    assert.equal(sendCall.options.parse_mode, undefined, "Must be plain text with NO parse mode");
    assert.equal(sendCall.options.link_preview_options?.is_disabled, true);
  }

  // Inter-send delay was applied between consecutive sends
  assert.deepEqual(delays, [250, 250]);

  // Per-chat success report edited into message
  const lastEdit = edits[edits.length - 1];
  assert.ok(lastEdit.includes("3/3 succeeded"));
  assert.ok(lastEdit.includes("• -100111: sent"));
  assert.ok(lastEdit.includes("• -100222: sent"));
  assert.ok(lastEdit.includes("• -100333: sent"));
});

test("Each chat receives the message at most once per confirmation (duplicate confirm prevention)", async () => {
  const config = fakeConfig({ interSendDelayMs: 0 });
  const store = new BroadcastStore();
  const pending = store.create("42", "Unique message", ["-100111", "-100222"]);

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 108 },
    api,
    callbackQuery: {
      id: "cb_2",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 101 },
    },
    editMessageText: async (text) => edits.push(text),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  // First confirm click
  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );
  assert.equal(api.sent.length, 2);

  // Second confirm click for same ID
  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );
  // Total sends remains 2 (not 4)
  assert.equal(api.sent.length, 2, "Duplicate confirm must not resend to chats");
});

test("Expiry: expired confirmation is rejected and does not send any messages", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  // Create pending with 0 TTL (already expired)
  const pending = store.create("42", "Expired announcement", ["-100111"], -1000);

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 109 },
    api,
    callbackQuery: {
      id: "cb_3",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 102 },
    },
    editMessageText: async (text) => edits.push(text),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, 0, "No messages should be sent for expired broadcast");
  const lastEdit = edits[edits.length - 1];
  assert.match(lastEdit, /expired/i);
});

test("Cancellation: clicking cancel removes broadcast and sends nothing", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const pending = store.create("42", "To be cancelled", ["-100111", "-100222"]);

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 110 },
    api,
    callbackQuery: {
      id: "cb_4",
      data: `broadcast:cancel:${pending.id}`,
      message: { message_id: 103 },
    },
    editMessageText: async (text) => edits.push(text),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:cancel:${pending.id}`,
  );

  assert.equal(api.sent.length, 0, "Cancelled broadcast sends nothing");
  assert.equal(store.get(pending.id), undefined, "Store should no longer have the item");
  assert.match(edits[0], /cancelled/i);
});

test("Partial failure: reports per-chat success when some chats fail", async () => {
  const config = fakeConfig({ interSendDelayMs: 0 });
  const store = new BroadcastStore();
  const pending = store.create("42", "Notice with partial failure", ["-100111", "-100FAIL", "-100333"]);

  const api = createFakeApi();
  // Override sendMessage to throw on -100FAIL
  const originalSend = api.sendMessage;
  api.sendMessage = async (chatId, text, opts) => {
    if (chatId === "-100FAIL") {
      throw new Error("Chat not found");
    }
    return originalSend(chatId, text, opts);
  };

  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 111 },
    api,
    callbackQuery: {
      id: "cb_5",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 104 },
    },
    editMessageText: async (text) => edits.push(text),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  // Chats 1 and 3 were sent
  assert.equal(api.sent.length, 2);
  assert.deepEqual(api.sent.map((s) => s.chatId), ["-100111", "-100333"]);

  // Report contains per-chat breakdown
  const report = edits[edits.length - 1];
  assert.ok(report.includes("2/3 succeeded"));
  assert.ok(report.includes("• -100111: sent"));
  assert.ok(report.includes("• -100FAIL: failed (Chat not found)"));
  assert.ok(report.includes("• -100333: sent"));
});

test("Integration with handleCallbackQuery: dispatches broadcast and enforces operator check", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const store = new BroadcastStore();
  const pending = store.create("42", "Integration test", ["-100111"]);

  // 1. Non-operator attempt
  const nonOperatorAlerts = [];
  const nonOperatorCtx = {
    from: { id: 999 },
    chat: { id: 42, type: "private" },
    update: { update_id: 201 },
    callbackQuery: {
      id: "cb_non_op",
      data: `broadcast:confirm:${pending.id}`,
    },
    answerCallbackQuery: async (opts) => nonOperatorAlerts.push(opts),
  };

  await handleCallbackQuery(nonOperatorCtx, {
    config,
    status: () => ({}),
    pause: () => "stopped",
    resume: () => "stopped",
    broadcastStore: store,
  });

  assert.equal(nonOperatorAlerts.length, 1);
  assert.equal(nonOperatorAlerts[0].text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(nonOperatorAlerts[0].show_alert, true);

  // 2. Operator attempt
  const operatorEdits = [];
  const api = createFakeApi();
  const operatorCtx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 202 },
    api,
    callbackQuery: {
      id: "cb_op",
      data: `broadcast:cancel:${pending.id}`,
      message: { message_id: 200 },
    },
    editMessageText: async (text) => operatorEdits.push(text),
    answerCallbackQuery: async () => {},
  };

  await handleCallbackQuery(operatorCtx, {
    config,
    status: () => ({}),
    pause: () => "stopped",
    resume: () => "stopped",
    broadcastStore: store,
  });

  assert.ok(operatorEdits[0].includes("cancelled"));
});
