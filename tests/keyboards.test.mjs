import assert from "node:assert/strict";
import test from "node:test";

import {
  contractsKeyboard,
  operatorKeyboard,
  statusKeyboard,
  validateCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "../dist/bot.js";

function assertValidCallbackData(callbackData) {
  assert.equal(typeof callbackData, "string");
  const byteLength = Buffer.byteLength(callbackData, "utf8");
  assert.ok(
    byteLength <= 64,
    `callback data "${callbackData}" exceeds 64 bytes: ${byteLength}`,
  );
  assert.ok(
    byteLength <= TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    `callback data "${callbackData}" exceeds TELEGRAM_CALLBACK_DATA_MAX_BYTES`,
  );
  const result = validateCallbackData(callbackData);
  assert.equal(
    result.ok,
    true,
    `callback data "${callbackData}" failed validateCallbackData`,
  );
}

function assertKeyboardValidity(keyboard) {
  assert.ok(Array.isArray(keyboard.inline_keyboard));
  for (const row of keyboard.inline_keyboard) {
    assert.ok(Array.isArray(row));
    for (const btn of row) {
      assert.ok(typeof btn.text === "string" && btn.text.length > 0);
      assertValidCallbackData(btn.callback_data);
    }
  }
}

test("statusKeyboard without operator config locks layout and callback data", () => {
  const expected = [
    [
      { text: "🔄 Refresh", callback_data: "status" },
      { text: "📋 Contracts", callback_data: "contracts" },
    ],
  ];

  for (const config of [undefined, {}, { operatorTelegramUserId: null }]) {
    const kb = statusKeyboard(config);
    assert.deepEqual(kb.inline_keyboard, expected);
    assertKeyboardValidity(kb);
  }
});

test("statusKeyboard with operator config locks layout and callback data", () => {
  const kb = statusKeyboard({ operatorTelegramUserId: "42" });
  const expected = [
    [
      { text: "🔄 Refresh", callback_data: "status" },
      { text: "📋 Contracts", callback_data: "contracts" },
    ],
    [
      { text: "⏸ Pause", callback_data: "pause" },
      { text: "▶ Resume", callback_data: "resume" },
    ],
  ];

  assert.deepEqual(kb.inline_keyboard, expected);
  assertKeyboardValidity(kb);
});

test("contractsKeyboard locks layout and callback data", () => {
  const kb = contractsKeyboard();
  const expected = [
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "❓ Help", callback_data: "help" },
    ],
  ];

  assert.deepEqual(kb.inline_keyboard, expected);
  assertKeyboardValidity(kb);
});

test("operatorKeyboard locks layout and callback data", () => {
  const kb = operatorKeyboard();
  const expected = [
    [
      { text: "⏸ Pause", callback_data: "pause" },
      { text: "▶ Resume", callback_data: "resume" },
    ],
    [
      { text: "📊 Status", callback_data: "status" },
    ],
  ];

  assert.deepEqual(kb.inline_keyboard, expected);
  assertKeyboardValidity(kb);
});

test("all callback data values across all keyboards pass validateCallbackData and are at most 64 bytes", () => {
  const keyboards = [
    statusKeyboard(),
    statusKeyboard({ operatorTelegramUserId: "12345" }),
    contractsKeyboard(),
    operatorKeyboard(),
  ];

  for (const kb of keyboards) {
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        assert.ok(typeof btn.callback_data === "string");
        assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
        const validated = validateCallbackData(btn.callback_data);
        assert.equal(validated.ok, true);
        if (validated.ok) {
          assert.equal(validated.action.raw, btn.callback_data);
        }
      }
    }
  }
});
