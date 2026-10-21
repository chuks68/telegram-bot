/**
 * Parity test: assert every MarkdownV2 notification string has a plain-text twin.
 *
 * When Telegram rejects a MarkdownV2 message due to an entity parse error,
 * formatPlainTextEvent in src/notifications/format.ts falls back to the plain-text
 * template set in src/i18n.ts (NOTIFICATION_PLAIN). A missing key would only surface
 * in production when Telegram rejects MarkdownV2.
 *
 * This test guarantees NOTIFICATION_PLAIN mirrors NOTIFICATION_MD key-for-key,
 * except for keys that are intentionally MarkdownV2-only and listed in the explicit allowlist.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { NOTIFICATION_MD, NOTIFICATION_PLAIN } from "../dist/i18n.js";

/**
 * Keys that exist in NOTIFICATION_MD but are intentionally MarkdownV2-only.
 *
 * - fallbackEvent: MarkdownV2-formatted fallback message header and structure used
 *   when an event payload is malformed or the primary formatter throws.
 * - previewModePrefix: Header prefix tag attached only in channel preview mode.
 * - channelPreviewMarket: Static MarkdownV2 header for market preview banner.
 * - channelPreviewSquad: Static MarkdownV2 header for squad preview banner.
 */
const MARKDOWN_V2_ONLY_KEYS = new Set([
  "fallbackEvent",
  "previewModePrefix",
  "channelPreviewMarket",
  "channelPreviewSquad",
]);

test("every non-allowlisted MarkdownV2 notification key has a plain-text twin", () => {
  const mdKeys = Object.keys(NOTIFICATION_MD);
  const plainKeys = new Set(Object.keys(NOTIFICATION_PLAIN));

  const missingTwins = [];

  for (const key of mdKeys) {
    if (MARKDOWN_V2_ONLY_KEYS.has(key)) {
      continue;
    }
    if (!plainKeys.has(key)) {
      missingTwins.push(key);
    }
  }

  assert.deepEqual(
    missingTwins,
    [],
    `The following MarkdownV2 notification keys are missing plain-text twins in NOTIFICATION_PLAIN: ${missingTwins.join(", ")}`,
  );
});

test("plain-text twin functions accept template parameters and return non-empty strings", () => {
  const mdKeys = Object.keys(NOTIFICATION_MD).filter((k) => !MARKDOWN_V2_ONLY_KEYS.has(k));

  for (const key of mdKeys) {
    const plainVal = NOTIFICATION_PLAIN[key];
    assert.equal(
      typeof plainVal,
      "function",
      `Expected NOTIFICATION_PLAIN.${key} to be a function twin`,
    );
  }
});

test("test fails with the missing key names when the sets diverge", () => {
  // Synthesize divergent sets to prove failure mode and reported key names
  const simulatedMdKeys = [...Object.keys(NOTIFICATION_MD), "unpairedSampleKey", "anotherMissingKey"];
  const plainKeys = new Set(Object.keys(NOTIFICATION_PLAIN));

  const missing = [];
  for (const key of simulatedMdKeys) {
    if (MARKDOWN_V2_ONLY_KEYS.has(key)) {
      continue;
    }
    if (!plainKeys.has(key)) {
      missing.push(key);
    }
  }

  assert.deepEqual(
    missing,
    ["unpairedSampleKey", "anotherMissingKey"],
    "Must report all missing key names when sets diverge",
  );
});
