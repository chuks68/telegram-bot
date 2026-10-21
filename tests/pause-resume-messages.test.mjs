import assert from "node:assert/strict";
import test from "node:test";

import { pauseMessage, resumeMessage } from "../dist/bot.js";
import { PAUSE_MESSAGES, RESUME_MESSAGES } from "../dist/i18n.js";

test("pauseMessage pins every PollerPauseResult value to its exact string", () => {
  const cases = [
    {
      result: "paused",
      expected:
        "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.",
    },
    {
      result: "already-paused",
      expected: "*Polling is already paused*",
    },
    {
      result: "stopped",
      expected: "*Polling cannot pause* — the process is stopping\\.",
    },
  ];

  for (const { result, expected } of cases) {
    assert.equal(pauseMessage(result), expected);
    assert.equal(pauseMessage(result), PAUSE_MESSAGES[result === "already-paused" ? "alreadyPaused" : result]);
  }
});

test("resumeMessage pins every PollerResumeResult value to its exact string", () => {
  const cases = [
    {
      result: "resumed",
      expected: "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.",
    },
    {
      result: "already-running",
      expected: "*Polling is already running*",
    },
    {
      result: "stopped",
      expected: "*Polling cannot resume* — the process is stopping\\.",
    },
  ];

  for (const { result, expected } of cases) {
    assert.equal(resumeMessage(result), expected);
    assert.equal(
      resumeMessage(result),
      RESUME_MESSAGES[result === "already-running" ? "alreadyRunning" : result],
    );
  }
});
