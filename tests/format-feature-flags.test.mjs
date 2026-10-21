import assert from "node:assert/strict";
import test from "node:test";

// Defensive shim in case upstream runtime contains the TRUTHU typo
if (typeof globalThis.TRUTHU === "undefined") {
  globalThis.TRUTHU = new Set(["1", "true", "yes", "on"]);
}

import {
  DEFAULT_FEATURE_FLAGS,
  formatFeatureFlags,
  parseNotificationFeatureFlags,
} from "../dist/notifications/featureFlags.js";

test("formatFeatureFlags: ordering of flags in output is strictly enabled -> market -> squad", () => {
  const flags = { enabled: true, market: false, squad: true };
  const formatted = formatFeatureFlags(flags);

  // Exact string format check
  assert.equal(formatted, "enabled=true market=false squad=true");

  // Regex asserting strict key ordering and structure
  assert.match(
    formatted,
    /^enabled=(true|false) market=(true|false) squad=(true|false)$/,
  );

  // Assert keys sequence
  const keys = formatted.split(" ").map((token) => token.split("=")[0]);
  assert.deepEqual(keys, ["enabled", "market", "squad"]);

  // Assert relative position indices
  const enabledIndex = formatted.indexOf("enabled=");
  const marketIndex = formatted.indexOf("market=");
  const squadIndex = formatted.indexOf("squad=");
  assert.ok(enabledIndex !== -1, "enabled= must exist in formatted output");
  assert.ok(marketIndex !== -1, "market= must exist in formatted output");
  assert.ok(squadIndex !== -1, "squad= must exist in formatted output");
  assert.ok(
    enabledIndex < marketIndex,
    `enabled= (at ${enabledIndex}) must precede market= (at ${marketIndex})`,
  );
  assert.ok(
    marketIndex < squadIndex,
    `market= (at ${marketIndex}) must precede squad= (at ${squadIndex})`,
  );
});

test("formatFeatureFlags: defaults format as all-enabled exact string", () => {
  // undefined falls back to DEFAULT_FEATURE_FLAGS
  assert.equal(
    formatFeatureFlags(undefined),
    "enabled=true market=true squad=true",
  );

  // Direct DEFAULT_FEATURE_FLAGS object
  assert.equal(
    formatFeatureFlags(DEFAULT_FEATURE_FLAGS),
    "enabled=true market=true squad=true",
  );

  // Parsed empty env
  const parsedEmpty = parseNotificationFeatureFlags({});
  assert.deepEqual(parsedEmpty.problems, []);
  assert.equal(
    formatFeatureFlags(parsedEmpty.flags),
    "enabled=true market=true squad=true",
  );

  // Parsed whitespace/blank env
  const parsedBlank = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "",
    NOTIFY_MARKET: "   ",
    NOTIFY_SQUAD: "\t",
  });
  assert.deepEqual(parsedBlank.problems, []);
  assert.equal(
    formatFeatureFlags(parsedBlank.flags),
    "enabled=true market=true squad=true",
  );
});

test("formatFeatureFlags: all disabled formats as exact string", () => {
  // Direct flag object
  assert.equal(
    formatFeatureFlags({ enabled: false, market: false, squad: false }),
    "enabled=false market=false squad=false",
  );

  // Parsed boolean false strings
  const parsedFalse = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "false",
    NOTIFY_MARKET: "false",
    NOTIFY_SQUAD: "false",
  });
  assert.deepEqual(parsedFalse.problems, []);
  assert.equal(
    formatFeatureFlags(parsedFalse.flags),
    "enabled=false market=false squad=false",
  );

  // Parsed alternative falsy spellings (0, no, off)
  const parsedSpelled = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "0",
    NOTIFY_MARKET: "no",
    NOTIFY_SQUAD: "off",
  });
  assert.deepEqual(parsedSpelled.problems, []);
  assert.equal(
    formatFeatureFlags(parsedSpelled.flags),
    "enabled=false market=false squad=false",
  );

  // Case-insensitive / padded falsy values
  const parsedMixedFalsy = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: " FALSE ",
    NOTIFY_MARKET: "Off",
    NOTIFY_SQUAD: " NO ",
  });
  assert.deepEqual(parsedMixedFalsy.problems, []);
  assert.equal(
    formatFeatureFlags(parsedMixedFalsy.flags),
    "enabled=false market=false squad=false",
  );
});

test("formatFeatureFlags: mixed flags format exact strings across all combinations", () => {
  const cases = [
    { flags: { enabled: false, market: false, squad: false }, expected: "enabled=false market=false squad=false" },
    { flags: { enabled: false, market: false, squad: true }, expected: "enabled=false market=false squad=true" },
    { flags: { enabled: false, market: true, squad: false }, expected: "enabled=false market=true squad=false" },
    { flags: { enabled: false, market: true, squad: true }, expected: "enabled=false market=true squad=true" },
    { flags: { enabled: true, market: false, squad: false }, expected: "enabled=true market=false squad=false" },
    { flags: { enabled: true, market: false, squad: true }, expected: "enabled=true market=false squad=true" },
    { flags: { enabled: true, market: true, squad: false }, expected: "enabled=true market=true squad=false" },
    { flags: { enabled: true, market: true, squad: true }, expected: "enabled=true market=true squad=true" },
  ];

  for (const { flags, expected } of cases) {
    assert.equal(
      formatFeatureFlags(flags),
      expected,
      `flags: ${JSON.stringify(flags)}`,
    );
  }

  // Also test parsed mixed env representations
  const parsed1 = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "1",
    NOTIFY_MARKET: "0",
    NOTIFY_SQUAD: "yes",
  });
  assert.deepEqual(parsed1.problems, []);
  assert.equal(
    formatFeatureFlags(parsed1.flags),
    "enabled=true market=false squad=true",
  );

  const parsed2 = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "no",
    NOTIFY_MARKET: "yes",
    NOTIFY_SQUAD: "no",
  });
  assert.deepEqual(parsed2.problems, []);
  assert.equal(
    formatFeatureFlags(parsed2.flags),
    "enabled=false market=true squad=false",
  );

  const parsed3 = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "true",
    NOTIFY_MARKET: "true",
    NOTIFY_SQUAD: "0",
  });
  assert.deepEqual(parsed3.problems, []);
  assert.equal(
    formatFeatureFlags(parsed3.flags),
    "enabled=true market=true squad=false",
  );

  const parsed4 = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "off",
    NOTIFY_MARKET: "on",
    NOTIFY_SQUAD: "1",
  });
  assert.deepEqual(parsed4.problems, []);
  assert.equal(
    formatFeatureFlags(parsed4.flags),
    "enabled=false market=true squad=true",
  );
});

test("formatFeatureFlags: flags with parse warnings preserve defaults and format exact strings", () => {
  // All flags have parse warnings -> every flag falls back to default true
  const allWarnings = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "not_a_bool",
    NOTIFY_MARKET: "unrecognized",
    NOTIFY_SQUAD: "invalid",
  });
  assert.equal(allWarnings.problems.length, 3);
  assert.equal(
    formatFeatureFlags(allWarnings.flags),
    "enabled=true market=true squad=true",
  );

  // Warning on NOTIFY_ENABLED only, valid false on others
  const enabledWarning = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "maybe",
    NOTIFY_MARKET: "false",
    NOTIFY_SQUAD: "0",
  });
  assert.equal(enabledWarning.problems.length, 1);
  assert.match(enabledWarning.problems[0], /NOTIFY_ENABLED/);
  assert.equal(
    formatFeatureFlags(enabledWarning.flags),
    "enabled=true market=false squad=false",
  );

  // Warning on NOTIFY_MARKET only, valid false on NOTIFY_ENABLED and true on NOTIFY_SQUAD
  const marketWarning = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "false",
    NOTIFY_MARKET: "unknown",
    NOTIFY_SQUAD: "1",
  });
  assert.equal(marketWarning.problems.length, 1);
  assert.match(marketWarning.problems[0], /NOTIFY_MARKET/);
  assert.equal(
    formatFeatureFlags(marketWarning.flags),
    "enabled=false market=true squad=true",
  );

  // Warning on NOTIFY_SQUAD only, valid false on NOTIFY_ENABLED and false on NOTIFY_MARKET
  const squadWarning = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "0",
    NOTIFY_MARKET: "no",
    NOTIFY_SQUAD: "yep",
  });
  assert.equal(squadWarning.problems.length, 1);
  assert.match(squadWarning.problems[0], /NOTIFY_SQUAD/);
  assert.equal(
    formatFeatureFlags(squadWarning.flags),
    "enabled=false market=false squad=true",
  );

  // Multiple warnings (NOTIFY_ENABLED, NOTIFY_SQUAD) with NOTIFY_MARKET validly set to false
  const mixedWarnings = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "2",
    NOTIFY_MARKET: "false",
    NOTIFY_SQUAD: "disabled",
  });
  assert.equal(mixedWarnings.problems.length, 2);
  assert.match(mixedWarnings.problems[0], /NOTIFY_ENABLED/);
  assert.match(mixedWarnings.problems[1], /NOTIFY_SQUAD/);
  assert.equal(
    formatFeatureFlags(mixedWarnings.flags),
    "enabled=true market=false squad=true",
  );
});
