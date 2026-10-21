import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { escapeMd, formatEvent, splitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "../dist/notifications/format.js";
import { formatUsdc } from "../dist/stellar/decode.js";
import { marketEvent, squadEvent } from "./helpers/events.mjs";

const reserved = "_*[]()~`>#+-=|{}.\\!";
const reservedSet = new Set(Array.from(reserved));

function expectedEscape(value) {
  return Array.from(value, (char) =>
    reservedSet.has(char) ? `\\${char}` : char,
  ).join("");
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("formatUsdc always renders all seven Stellar USDC decimals", () => {
  const cases = [
    [0n, "0.0000000"],
    [1n, "0.0000001"],
    [10_000_000n, "1.0000000"],
    [20_000_000n, "2.0000000"],
    [12_345_678n, "1.2345678"],
    [-1n, "-0.0000001"],
    [-12_345_678n, "-1.2345678"],
    [123_456_789_012_345_678_901_234_567n, "12345678901234567890.1234567"],
  ];

  for (const [units, expected] of cases) {
    assert.equal(formatUsdc(units), expected, String(units));
  }
});

test("formatted money notifications keep explicit decimals and escape the decimal point", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = marketEvent("claim_challenged", {
    ledger: 43,
    claimId: 7,
    challenger: "GABCD",
    stake: 20_000_000n,
  });

  const message = formatEvent(config, event);
  assert.match(message, /Stake: \*2\\.0000000 USDC\*/);
});

test("unknown or malformed decoded events stay non-notifying", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = marketEvent("unknown", {
    ledger: 44,
    eventName: "claim_challenged",
    reason: "malformed amount",
  });

  assert.equal(formatEvent(config, event), null);
});

test("escapeMd escapes every MarkdownV2 reserved character exactly once", () => {
  assert.equal(escapeMd(reserved), expectedEscape(reserved));
  assert.equal(escapeMd("plain café 🛰️\nnext line"), "plain café 🛰️\nnext line");
});

test("escapeMd matches the character-wise rule for deterministic fuzz inputs", () => {
  const alphabet = Array.from(`${reserved}abcXYZ09 café\n\r\t\0🛰️e\u0301`);
  const random = seededRandom(0x5eedc0de);

  for (let sample = 0; sample < 1000; sample += 1) {
    const length = Math.floor(random() * 257);
    let input = "";
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)];
    }
    assert.equal(escapeMd(input), expectedEscape(input), `sample ${sample}`);
  }
});

test("formatted untrusted event text reaches Telegram as exact MarkdownV2", async () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = marketEvent("claim_created", {
    ledger: 42,
    claimId: 7,
    creator: "GABCD",
    category: reserved,
  });
  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: 🏷️ ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 42_";
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  assert.equal(message, expectedMessage);
  await createNotifier(fakeBot, config)(message);
  assert.deepEqual(sent, [
    [
      config.chatIds[0],
      expectedMessage,
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("oversized event fields are clipped safely before MarkdownV2 escaping", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const category = `${"a".repeat(199)}🛰️`;
  const event = marketEvent("claim_created", {
    ledger: 42,
    txHash: "x".repeat(129),
    claimId: 7,
    creator: "GABCD",
    category,
  });

  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: 🏷️ ${"a".repeat(199)}…\n` +
    "Creator: `GABCD`\n_ledger 42_";

  assert.equal(message, expectedMessage);
  assert.equal(message.length < 4096, true);
});

test("oversized squad questions are clipped without splitting emoji", () => {
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = squadEvent("market_created", {
    ledger: 42,
    marketId: 7,
    captain: "GABCD",
    deadline: 1_800_000_000,
    feeBps: 25,
    question: `${"q".repeat(199)}🛰️`,
  });

  const message = formatEvent(config, event);
  assert.match(message, new RegExp(`\\n${"q".repeat(199)}…\\n`));
  assert.equal(message.includes("🛰️"), false);
});

test("createNotifier preserves Telegram send failures for the poller", async () => {
  const error = new Error("Telegram API unavailable");
  const fakeBot = { api: { sendMessage: async () => Promise.reject(error) } };
  const notify = createNotifier(fakeBot, { chatIds: ["-1001234567890"] });
  await assert.rejects(notify("message"), error);
});

test("createNotifier routes named contract sources and preserves the legacy fallback", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };
  const notify = createNotifier(fakeBot, {
    chatId: "-1001234567890",
    marketChatId: "-1001111111111",
    squadChatId: "@mimir_squad",
  });

  await notify("market event", "market");
  await notify("squad event", "squad");
  await notify("legacy event");

  assert.deepEqual(sent.map(([chatId, text]) => [chatId, text]), [
    ["-1001111111111", "market event"],
    ["@mimir_squad", "squad event"],
    ["-1001234567890", "legacy event"],
  ]);
});

test("escapeMd handles a long adversarial string without dropping characters", () => {
  const input = reserved.repeat(10_000);
  const escaped = escapeMd(input);
  assert.equal(escaped, expectedEscape(input));
});

test("createNotifier links to threaded replies when replyToMessageId is provided", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const notify = createNotifier(fakeBot, config);
  // Merged signature: the notifier keeps main's (text, source?, extra?)
  // shape, so the thread target rides on SendExtra rather than a bare
  // second argument.
  await notify("threaded message", undefined, { replyToMessageId: 12345 });

  assert.deepEqual(sent, [
    [
      config.chatId,
      "threaded message",
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
        reply_parameters: {
          chat_id: config.chatId,
          message_id: 12345,
        },
      },
    ],
  ]);
});

test("createNotifier sends without reply_parameters when replyToMessageId is undefined", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const notify = createNotifier(fakeBot, config);
  await notify("standalone message");

  assert.deepEqual(sent, [
    [
      config.chatId,
      "standalone message",
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("txExplorerUrl is centralized and network-aware", async () => {
  const { txExplorerUrl, accountExplorerUrl, contractExplorerUrl, DEFAULT_EXPLORER_BASE_URL } =
    await import("../dist/stellar/client.js");

  const testnet = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: DEFAULT_EXPLORER_BASE_URL,
  };
  assert.equal(
    txExplorerUrl(testnet, "abcd"),
    "https://stellar.expert/explorer/testnet/tx/abcd",
  );
  assert.equal(
    accountExplorerUrl(testnet, "G" + "A".repeat(55)),
    "https://stellar.expert/explorer/testnet/account/G" + "A".repeat(55),
  );
  assert.equal(
    contractExplorerUrl(testnet, testnet.marketContractId),
    `https://stellar.expert/explorer/testnet/contract/${testnet.marketContractId}`,
  );

  const pub = {
    ...testnet,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  };
  assert.equal(
    txExplorerUrl(pub, "ffff"),
    "https://stellar.expert/explorer/public/tx/ffff",
  );

  const custom = { ...testnet, explorerBaseUrl: "https://example.test/x/" };
  assert.equal(txExplorerUrl(custom, "zz"), "https://example.test/x/testnet/tx/zz");
  assert.equal(txExplorerUrl(testnet, "  "), "");
});

test("formatEvent prefixes message with [PREVIEW MODE] when channelPreviewMode is enabled", async () => {
  const { formatEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    channelPreviewMode: true,
  };
  const event = marketEvent("claim_created", {
    ledger: 100,
    txHash: "hash123",
    claimId: 5,
    creator: "GABCD",
    category: "sports",
  });
  const message = formatEvent(config, event);
  assert.match(message, /^🧪 \*\[PREVIEW MODE\]\*\n🆕 \*New claim\*/);
});

test("formatFallbackEvent formats actionable degraded event notification with redacted reason", async () => {
  const { formatFallbackEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = marketEvent("unknown", {
    ledger: 200,
    txHash: "hash456",
  });
  const fallback = formatFallbackEvent(config, event, "corrupt payload 123456789:SECRET-TOKEN-ABCD");
  assert.match(fallback, /⚠️ \*Event Notification Fallback\*/);
  assert.equal(fallback.includes("SECRET-TOKEN"), false);
});

test("clip: question field is bounded in market_created notification", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longQuestion = "Will ".repeat(100); // 500 chars
  const event = squadEvent("market_created", {
    ledger: 51,
    marketId: 1,
    captain: "GABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDE",
    deadline: 1_800_000_000,
    feeBps: 100,
    question: longQuestion,
  });
  const message = formatEvent(config, event);
  assert.ok(message !== null, "Expected a non-null message");
  assert.ok(
    !message.includes("Will ".repeat(50)),
    "Question was not truncated in the notification output",
  );
});

test("clip: summary field is bounded in claim_resolved notification", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longSummary = "evidence ".repeat(100); // 900 chars
  const event = marketEvent("claim_resolved", {
    ledger: 52,
    claimId: 3,
    winnerSide: 2,
    summary: longSummary,
    confidence: 95,
    evidenceHash: "abc123",
  });
  const message = formatEvent(config, event);
  assert.ok(message !== null, "Expected a non-null message");
  // The raw summary should not appear verbatim past 200 chars in the output
  assert.ok(
    !message.includes("evidence ".repeat(30)),
    "Summary was not truncated in the notification output",
  );
});

test("splitTelegramMessage keeps short payloads as a single chunk", () => {
  assert.deepEqual(splitTelegramMessage("hello"), ["hello"]);
  assert.deepEqual(splitTelegramMessage("a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH)), [
    "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH),
  ]);
});

test("splitTelegramMessage prefers newline boundaries under the limit", () => {
  const line = "x".repeat(100);
  const text = Array.from({ length: 50 }, () => line).join("\n");
  assert.ok(text.length > TELEGRAM_MAX_MESSAGE_LENGTH);
  const parts = splitTelegramMessage(text);
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.ok(part.length <= TELEGRAM_MAX_MESSAGE_LENGTH, part.length);
  }
  assert.equal(parts.join("\n"), text);
});

test("splitTelegramMessage hard-splits a single oversized line", () => {
  const text = "y".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 50);
  const parts = splitTelegramMessage(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.equal(parts[1].length, 50);
  assert.equal(parts.join(""), text);
});

test("splitTelegramMessage never ends a chunk on a lone MarkdownV2 backslash", () => {
  const limit = 20;
  // 19 chars then \, then "!" — cutting at 20 would leave a trailing \.
  const text = "a".repeat(19) + "\\!";
  const parts = splitTelegramMessage(text, limit);
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.ok(part.length <= limit, part.length);
  }
  // First chunk must not end mid-escape (lone trailing backslash).
  assert.equal(parts[0].endsWith("\\"), false);
  assert.equal(parts.join(""), text);
});

test("splitTelegramMessage rejects a non-positive limit", () => {
  assert.throws(() => splitTelegramMessage("x", 0), RangeError);
  assert.throws(() => splitTelegramMessage("x", -1), RangeError);
});

test("createNotifier splits oversized MarkdownV2 into ordered Telegram sends", async () => {
  const config = { chatId: "-1001234567890" };
  const line = "word ".repeat(200).trim(); // ~1000 chars
  const text = Array.from({ length: 6 }, (_, i) => `*Part ${i}* ${line}`).join("\n");
  assert.ok(text.length > TELEGRAM_MAX_MESSAGE_LENGTH);

  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  await createNotifier(fakeBot, config)(text);
  assert.ok(sent.length >= 2);
  for (const [chatId, body, opts] of sent) {
    assert.equal(chatId, config.chatId);
    assert.ok(body.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
    assert.deepEqual(opts, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  }
  assert.equal(sent.map((s) => s[1]).join("\n"), text);
});

test("createNotifier still surfaces Telegram failures on the first chunk", async () => {
  const error = new Error("message is too long");
  let calls = 0;
  const fakeBot = {
    api: {
      sendMessage: async () => {
        calls += 1;
        return Promise.reject(error);
      },
    },
  };
  const big = "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 10);
  const notify = createNotifier(fakeBot, { chatId: "-1001" });
  await assert.rejects(notify(big), error);
  assert.equal(calls, 1);
});
