import test from "node:test";
import assert from "node:assert";
import { menuMessage, menuKeyboard } from "../src/commands/menu.js";

test("menuMessage returns a non-empty string", () => {
  const message = menuMessage();
  assert.strictEqual(typeof message, "string");
  assert.ok(message.length > 0);
});

test("menuMessage mentions status, contracts and help", () => {
  const message = menuMessage();
  assert.match(message, /Status/i);
  assert.match(message, /Contracts/i);
  assert.match(message, /Help/i);
});

test("menuKeyboard returns inline keyboard with expected callback data", () => {
  const keyboard = menuKeyboard();
  assert.ok(keyboard.inline_keyboard);
  const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(data, ["status", "contracts", "help"]);
});

test("menuKeyboard buttons have text", () => {
  const keyboard = menuKeyboard();
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      assert.strictEqual(typeof button.text, "string");
      assert.ok(button.text.length > 0);
    }
  }
});
