import test from 'node:test';
import assert from 'node:assert';

import { COMMAND_DESCRIPTIONS } from '../src/i18n.js';
import { BOT_COMMANDS } from '../src/bot.js';

const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const MIN_DESCRIPTION_LENGTH = 1;
const MAX_DESCRIPTION_LENGTH = 256;

test('COMMAND_DESCRIPTIONS names fit Telegram limits', () => {
  for (const name of Object.keys(COMMAND_DESCRIPTIONS)) {
    assert.match(
      name,
      NAME_PATTERN,
      `Command "${name}" is invalid: Telegram requires 1-32 lowercase letters, digits or underscores`,
    );
  }
});

test('COMMAND_DESCRIPTIONS descriptions fit Telegram limits', () => {
  for (const [name, description] of Object.entries(COMMAND_DESCRIPTIONS)) {
    assert.strictEqual(
      typeof description,
      'string',
      `Command "${name}" has a non-string description`,
    );
    const length = [...description].length;
    assert.ok(
      length >= MIN_DESCRIPTION_LENGTH && length <= MAX_DESCRIPTION_LENGTH,
      `Command "${name}" description must be 1-256 characters, got ${length}`,
    );
  }
});

test('every bot command has a description', () => {
  for (const command of BOT_COMMANDS) {
    const name = typeof command === 'string' ? command : command.command;
    assert.ok(
      Object.prototype.hasOwn.call(COMMAND_DESCRIPTIONS, name),
      `Bot command "${name}" is missing a description in COMMAND_DESCRIPTTIONS`,
    );
  }
});
