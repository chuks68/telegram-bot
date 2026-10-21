import test from "node:test";
import assert from "node:assert";
import { startFakeTelegram } from "../src/dev/fake-telegram.js";
import { createNotifier } from "../src/notifier.js";

test("fake Telegram API receives notifications via createNotifier", async (t) => {
  const fake = await startFakeTelegram();
  t.after(() => fake.close());

  const notifier = createNotifier({
    token: "fake-token",
    apiRoot: fake.url,
    chatId: "123456789",
  });

  await notifier.notify("HELLO", "World");

  const messages = fake.getReceivedMessages();
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].chat_id, "123456789");
  assert.strictEqual(messages[0].text, "HELLO World");
});
