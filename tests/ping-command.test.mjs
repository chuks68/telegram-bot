import assert from "node:assert/strict";
import test from "node:test";

let pingModule;
try {
  pingModule = await import("../dist/commands/ping.js");
} catch {
  pingModule = await import("../src/commands/ping.js");
}

const {
  handlePingCommand,
  pingCommand,
  pongMessage,
  formatPong,
  isChatAllowed,
  systemClock,
} = pingModule;

function createFakeClock(initialTime = 1000) {
  let currentTime = initialTime;
  return {
    now: () => currentTime,
    advance: (ms) => {
      currentTime += ms;
    },
    setTime: (time) => {
      currentTime = time;
    },
  };
}

function createFakeContext(options = {}) {
  const replies = [];
  const edits = [];
  const chatId = options.chatId ?? 12345;
  const replyMessageId = options.replyMessageId ?? 42;

  const ctx = {
    chat: { id: chatId },
    reply: async (text, opts) => {
      replies.push({ text, options: opts });
      if (options.onReply) {
        options.onReply(text, opts);
      }
      return {
        message_id: replyMessageId,
        chat: { id: chatId },
      };
    },
    editMessageText: async (text, opts) => {
      if (options.editError) {
        throw options.editError;
      }
      edits.push({ text, options: opts });
      return true;
    },
  };

  if (options.useApi) {
    delete ctx.editMessageText;
    ctx.api = {
      editMessageText: async (targetChatId, messageId, text, opts) => {
        if (options.editError) {
          throw options.editError;
        }
        edits.push({ chatId: targetChatId, messageId, text, options: opts });
        return true;
      },
    };
  }

  return { ctx, replies, edits };
}

test("pongMessage and formatPong format latency strings correctly", () => {
  assert.equal(pongMessage(), "Pong");
  assert.equal(pongMessage(undefined), "Pong");
  assert.equal(pongMessage(0), "Pong (0ms)");
  assert.equal(pongMessage(50), "Pong (50ms)");
  assert.equal(pongMessage(123), "Pong (123ms)");
  assert.equal(pongMessage(45.5), "Pong (45.5ms)");
  assert.equal(formatPong(100), "Pong (100ms)");
});

test("isChatAllowed enforces allowlist matching", () => {
  // Open allowlist when undefined or empty
  assert.equal(isChatAllowed(undefined, 123), true);
  assert.equal(isChatAllowed([], 123), true);

  // Restricted allowlist
  const allowlist = ["100", "200", "-1001234567890"];
  assert.equal(isChatAllowed(allowlist, 100), true);
  assert.equal(isChatAllowed(allowlist, "100"), true);
  assert.equal(isChatAllowed(allowlist, -1001234567890), true);
  assert.equal(isChatAllowed(allowlist, "-1001234567890"), true);
  assert.equal(isChatAllowed(allowlist, 999), false);
  assert.equal(isChatAllowed(allowlist, "999"), false);
  assert.equal(isChatAllowed(allowlist, undefined), false);
});

test("handlePingCommand replies Pong, then edits with measured round trip", async () => {
  const clock = createFakeClock(1000);
  const { ctx, replies, edits } = createFakeContext({
    onReply: () => {
      // Simulate 50ms round-trip latency for the initial reply
      clock.advance(50);
    },
  });

  await handlePingCommand(ctx, { clock });

  // 1. Initial reply was "Pong"
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Pong");

  // 2. Message was edited with measured round trip
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Pong/);
  assert.match(edits[0].text, /50ms/);
});

test("handlePingCommand supports clock injection and measures elapsed time", async () => {
  const clock = createFakeClock(500);
  const { ctx, replies, edits } = createFakeContext({
    onReply: () => {
      clock.advance(125);
    },
  });

  await handlePingCommand(ctx, { clock });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Pong");
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /125ms/);
});

test("handlePingCommand gates command using allowedChatIds", async () => {
  const clock = createFakeClock(1000);
  const config = {
    allowedChatIds: ["100", "200"],
    botToken: "123:TOKEN",
  };

  // Chat 100 is allowed
  const { ctx: allowedCtx, replies: allowedReplies } = createFakeContext({ chatId: 100 });
  await handlePingCommand(allowedCtx, { config, clock });
  assert.equal(allowedReplies.length, 1);

  // Chat 999 is blocked
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const { ctx: blockedCtx, replies: blockedReplies } = createFakeContext({ chatId: 999 });
    await handlePingCommand(blockedCtx, { config, clock });
    assert.equal(blockedReplies.length, 0, "No reply sent to blocked chat");
    assert.ok(warnings.some((w) => w.includes("/ping denied for chat 999")));
  } finally {
    console.warn = originalWarn;
  }
});

test("handlePingCommand allows any chat when allowedChatIds is empty or absent", async () => {
  const clock = createFakeClock(1000);
  const { ctx, replies } = createFakeContext({ chatId: 8888 });

  await handlePingCommand(ctx, { config: { allowedChatIds: [] }, clock });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Pong");
});

test("Acceptance criteria: if editing fails, original reply stays and error is logged with redaction", async () => {
  const clock = createFakeClock(1000);
  const secretToken = ["987654321:", "AAFE456_SECRET_BOT_TOKEN"].join("");
  const config = {
    botToken: secretToken,
    allowedChatIds: [],
  };

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const editError = new Error(`Telegram API edit failed with token ${secretToken}`);
    const { ctx, replies, edits } = createFakeContext({
      editError,
      onReply: () => {
        clock.advance(40);
      },
    });

    // Run command — should NOT throw
    await handlePingCommand(ctx, { config, clock });

    // 1. Original reply stays (only 1 reply sent, no second fallback reply)
    assert.equal(replies.length, 1, "Original reply stays alone");
    assert.equal(replies[0].text, "Pong");
    assert.equal(edits.length, 0, "Edit threw error");

    // 2. Error was logged
    assert.ok(errors.length > 0, "Error was logged");
    const loggedError = errors.join("\n");
    assert.match(loggedError, /\[bot\] \/ping edit failed:/);

    // 3. Error was redacted: secret token must NOT be present
    assert.doesNotMatch(loggedError, new RegExp(secretToken));
  } finally {
    console.error = originalError;
  }
});

test("handlePingCommand delegates to ctx.api.editMessageText when ctx.editMessageText is not present", async () => {
  const clock = createFakeClock(1000);
  const { ctx, replies, edits } = createFakeContext({
    useApi: true,
    chatId: 777,
    replyMessageId: 88,
    onReply: () => {
      clock.advance(60);
    },
  });

  await handlePingCommand(ctx, { clock });

  assert.equal(replies.length, 1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].chatId, 777);
  assert.equal(edits[0].messageId, 88);
  assert.match(edits[0].text, /60ms/);
});

test("pingCommand is an alias for handlePingCommand", async () => {
  assert.equal(pingCommand, handlePingCommand);
});

test("systemClock provides performance.now timestamps", () => {
  assert.equal(typeof systemClock.now, "function");
  const t1 = systemClock.now();
  assert.ok(typeof t1 === "number" && Number.isFinite(t1));
});
