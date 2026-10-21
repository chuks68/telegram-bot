import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { ConfigError, loadConfig } from "../dist/config.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "../dist/notifications/priority.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validBotEnv(overrides = {}) {
  return {
    BOT_TOKEN: "123456789:" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    SILENT_EVENTS: undefined,
    ...overrides,
  };
}

test("isSilent defaults to routine deposits, withdrawals and fee claims", () => {
  assert.deepEqual([...DEFAULT_SILENT_EVENTS], [
    "deposited",
    "withdrawn",
    "withdrawal",
    "withdrawal_pending",
    "fee_claimed",
    "fees_claimed",
  ]);
  for (const event of DEFAULT_SILENT_EVENTS) assert.equal(isSilent(event), true);
  assert.equal(isSilent("claim_created"), false);
  assert.equal(isSilent("claim_created", ["claim_created"]), true);
  assert.equal(isSilent("deposited", ["claim_created"]), false);
});

test("createNotifier adds disable_notification only for silent event names", async () => {
  const sent = [];
  const fakeBot = { api: { sendMessage: async (...args) => { sent.push(args); return {}; } } };
  const notify = createNotifier(fakeBot, { chatId: "-1001234567890" });

  await notify("routine", "market", { eventName: "deposited" });
  await notify("important", "market", { eventName: "claim_created" });
  await notify("unchanged");

  assert.deepEqual(sent, [
    ["-1001234567890", "routine", {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    }],
    ["-1001234567890", "important", {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    }],
    ["-1001234567890", "unchanged", {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    }],
  ]);
});

test("loadConfig accepts known silent event names and rejects unknown names", () => {
  withEnv(validBotEnv({ SILENT_EVENTS: "deposited, claim_created" }), () => {
    assert.deepEqual(loadConfig().silentEvents, ["deposited", "claim_created"]);
  });
  withEnv(validBotEnv({ SILENT_EVENTS: "deposited, typo_event" }), () => {
    assert.throws(() => loadConfig(), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((problem) => problem.includes("typo_event")));
      return true;
    });
  });
});
