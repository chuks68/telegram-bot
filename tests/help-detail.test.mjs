import assert from "node:assert/strict";
import test from "node:test";

import { COMMANDS, helpMessage, registerCommandHandlers } from "../dist/bot.js";
import { COMMAND_DETAILS, helpDetailMessage } from "../dist/commands/help-detail.js";

const OPTIONS = {
  parse_mode: "MarkdownV2",
  link_preview_options: { is_disabled: true },
};

test("every command in COMMANDS has a detail entry in COMMAND_DETAILS", () => {
  assert.ok(COMMANDS.length > 0);
  for (const { command, operatorOnly } of COMMANDS) {
    const detail = COMMAND_DETAILS[command];
    assert.ok(detail, `COMMAND_DETAILS must have an entry for /${command}`);
    assert.ok(detail.usage, `COMMAND_DETAILS[${command}] must define usage`);
    assert.ok(detail.arguments !== undefined, `COMMAND_DETAILS[${command}] must define arguments`);
    assert.ok(detail.whoCanRun, `COMMAND_DETAILS[${command}] must define whoCanRun`);
    assert.ok(detail.description, `COMMAND_DETAILS[${command}] must define description`);
    assert.ok(Array.isArray(detail.examples), `COMMAND_DETAILS[${command}] must define examples array`);
    assert.ok(detail.examples.length > 0, `COMMAND_DETAILS[${command}] must have at least one example`);

    if (operatorOnly) {
      assert.equal(detail.operatorOnly, true, `${command} is operatorOnly in COMMANDS, detail must match`);
      assert.match(
        detail.whoCanRun,
        /operator\s*only/i,
        `operator-only command /${command} must state 'Operator only' in whoCanRun`,
      );
    }
  }
});

test("operator-only commands explicitly say so in whoCanRun and rendered message", () => {
  const operatorCommands = COMMANDS.filter((cmd) => cmd.operatorOnly).map((cmd) => cmd.command);
  assert.deepEqual(operatorCommands.sort(), ["audit", "pause", "resume"].sort());

  for (const cmd of operatorCommands) {
    const detail = COMMAND_DETAILS[cmd];
    assert.ok(detail, `Missing detail for operator command ${cmd}`);
    assert.match(detail.whoCanRun, /operator\s*only/i);

    const rendered = helpDetailMessage(cmd);
    assert.match(
      rendered,
      /Operator only/i,
      `Rendered help for /${cmd} must say 'Operator only'`,
    );
  }
});

test("helpDetailMessage renders all required fields for every command", () => {
  for (const { command } of COMMANDS) {
    const rendered = helpDetailMessage(command);
    assert.ok(rendered.length > 0, `Rendered message for ${command} must not be empty`);
    assert.ok(rendered.length < 4096, `Rendered message for ${command} must fit Telegram limit`);

    // Must include command heading, usage, arguments, and who can run it
    assert.match(rendered, new RegExp(`\\*Command:\\* /${command}`, "i"));
    assert.match(rendered, /\*Usage:\*/);
    assert.match(rendered, /\*Arguments:\*/);
    assert.match(rendered, /\*Who can run it:\*/);
    assert.match(rendered, /\*Examples:\*/);
  }
});

test("helpDetailMessage handles leading slash, uppercase, and trimming", () => {
  const plain = helpDetailMessage("preview");
  const withSlash = helpDetailMessage("/preview");
  const upper = helpDetailMessage("PREVIEW");
  const spaced = helpDetailMessage("  preview  ");

  assert.equal(withSlash, plain);
  assert.equal(upper, plain);
  assert.equal(spaced, plain);
});

test("helpDetailMessage falls back to normal help for unknown or empty commands", () => {
  const config = { operatorTelegramUserId: null };
  const fallback = helpMessage(config);

  assert.equal(helpDetailMessage("nonexistent_cmd", config), fallback);
  assert.equal(helpDetailMessage("xyz123", config), fallback);
  assert.equal(helpDetailMessage("", config), fallback);
  assert.equal(helpDetailMessage("   ", config), fallback);

  // Fallback without config should also match helpMessage()
  assert.equal(helpDetailMessage("unknown_without_config"), helpMessage());
});

test("help command handler in registerCommandHandlers dispatches detailed help with argument", async () => {
  const config = { operatorTelegramUserId: "42" };
  const handlers = new Map();
  const unexpected = () => {
    throw new Error("unexpected poller access");
  };
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
  };
  registerCommandHandlers(bot, {
    config,
    status: unexpected,
    pause: unexpected,
    resume: unexpected,
  });

  const helpHandler = handlers.get("help");
  assert.ok(helpHandler, "help handler must be registered");

  // 1. /help without args returns standard help
  const repliesNoArgs = [];
  await helpHandler({
    message: { text: "/help" },
    match: "",
    reply: async (...args) => repliesNoArgs.push(args),
  });
  assert.equal(repliesNoArgs.length, 1);
  assert.equal(repliesNoArgs[0][0], helpMessage(config));
  assert.deepEqual(repliesNoArgs[0][1], OPTIONS);

  // 2. /help preview returns detailed help for preview
  const repliesPreview = [];
  await helpHandler({
    message: { text: "/help preview" },
    match: "preview",
    reply: async (...args) => repliesPreview.push(args),
  });
  assert.equal(repliesPreview.length, 1);
  assert.equal(repliesPreview[0][0], helpDetailMessage("preview", config));
  assert.deepEqual(repliesPreview[0][1], OPTIONS);

  // 3. /help unknown returns fallback (standard help)
  const repliesUnknown = [];
  await helpHandler({
    message: { text: "/help mysterious" },
    match: "mysterious",
    reply: async (...args) => repliesUnknown.push(args),
  });
  assert.equal(repliesUnknown.length, 1);
  assert.equal(repliesUnknown[0][0], helpMessage(config));
  assert.deepEqual(repliesUnknown[0][1], OPTIONS);
});
