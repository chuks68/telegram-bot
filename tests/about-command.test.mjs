import test from "node:test";
import assert from "node:assert";
import { aboutMessage } from "../src/commands/about.js";

test("aboutMessage reports testnet details", () => {
  const message = aboutMessage({ network: "testnet" }, "1.2.3");
  assert.match(message, /Version: 1.\.2\.3/);
  assert.match(message, /Network: Test Network/);
  assert.match(message, /Repository: https:\/\/github\.com\/example\/stellar-bot/);
});

test("aboutMessage reports a named network", () => {
  const message = aboutMessage({ network: "public" }, "0.1.0");
  assert.match(message, /Version: 0\.1\.0/);
  assert.match(message, /Network: Public Network/);
  assert.match(message, /Repository: https:\/\/github\.com\/example\/stellar-bot/);
});
