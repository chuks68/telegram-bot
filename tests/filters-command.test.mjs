import assert from "node:assert/strict";
import test from "node:test";

import { filtersMessage, MARKET_EVENT_TYPES, SQUAD_EVENT_TYPES } from "../dist/commands/filters.js";
import { escapeMd } from "../dist/notifications/format.js";
import { assertValidMarkdownV2 } from "./markdown-lint.test.mjs";

test("filtersMessage: default configuration renders 'all notifications enabled' line", () => {
  const config = {
    chatId: "-1001234567890",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  // Acceptance criteria: Default configuration renders an "all notifications enabled" line.
  assert.match(message, /all notifications (are )?enabled/i);
  // Acceptance criteria: No chat ids or tokens appear unredacted.
  assert.ok(!message.includes("-1001234567890"), "chat id must be redacted");
  assert.match(message, /-…7890/);

  // Lists enabled event types
  for (const eventName of MARKET_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should include market event ${eventName}`);
  }
  for (const eventName of SQUAD_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should include squad event ${eventName}`);
  }

  // Categories show none restricted / all allowed
  assert.match(message, /all allowed/i);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "default config filtersMessage");
});

test("filtersMessage: category-filtered config reports allowed categories and escapes properly", () => {
  const config = {
    chatId: "-1009876543210",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: ["crypto", "sports_&_games"],
  };

  const message = filtersMessage(config);

  // Should NOT render "All notifications are enabled" line because category filter is active
  assert.doesNotMatch(message, /All notifications are enabled/i);

  // Check category listing and escaping
  assert.match(message, /crypto/);
  assert.ok(message.includes(escapeMd("sports_&_games")));

  // Chat ID redacted
  assert.ok(!message.includes("-1009876543210"), "raw chat id must not appear");
  assert.match(message, /-…3210/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "category-filtered config filtersMessage");
});

test("filtersMessage: squad-disabled config lists squad events as disabled", () => {
  const config = {
    chatId: "@my_channel",
    featureFlags: { enabled: true, market: true, squad: false },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  // Should NOT render "All notifications are enabled" line
  assert.doesNotMatch(message, /All notifications are enabled/i);

  // Squad events should be mentioned in disabled list
  for (const eventName of SQUAD_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should mention squad event ${eventName}`);
  }

  // Redacted username channel
  assert.ok(!message.includes("@my_channel"), "channel username must be redacted");
  assert.match(message, /@m…/);

  // Market enabled, squad disabled
  assert.match(message, /mimir\\-market: enabled/);
  assert.match(message, /mimir\\-squad: disabled/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "squad-disabled config filtersMessage");
});

test("filtersMessage: master kill switch disabled marks all events disabled", () => {
  const config = {
    chatId: "123456789",
    featureFlags: { enabled: false, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  assert.match(message, /Master switch: disabled/);
  assert.match(message, /Enabled: none/);
  assert.ok(!message.includes("123456789"), "raw chat id must not appear");
  assert.match(message, /…6789/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "master-disabled config filtersMessage");
});

test("filtersMessage: chat routing with separate market and squad destinations", () => {
  const config = {
    chatId: "-1001111111111",
    marketChatId: "-1002222222222",
    squadChatId: "-1003333333333",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  assert.ok(!message.includes("-1001111111111"));
  assert.ok(!message.includes("-1002222222222"));
  assert.ok(!message.includes("-1003333333333"));

  assert.match(message, /-…1111/);
  assert.match(message, /-…2222/);
  assert.match(message, /-…3333/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "chat-routing config filtersMessage");
});

test("filtersMessage: handles empty or missing config gracefully", () => {
  const message = filtersMessage();

  assert.match(message, /Active Notification Filters/);
  assert.match(message, /all notifications (are )?enabled/i);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "empty config filtersMessage");
});
