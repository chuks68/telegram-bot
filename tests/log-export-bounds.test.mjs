import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXPORT_CHARS,
  REDACTED,
  attachConsole,
  createLogCapture,
  redactLine,
  renderLogExport,
  secretsFor,
} from "../dist/logger.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    logBufferLines: 500,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

// ── Over-capacity log capture & truncation bounds ────────────────────────────

test("fill capture beyond capacity with secrets and long payloads: bounds, recent-first, no secrets", () => {
  const config = baseConfig();
  const capacity = 40;
  const capture = createLogCapture(capacity);

  // Add 100 lines (2.5x ring capacity), each containing the bot token, chat id,
  // contract strkeys, and a ~1.2KB payload. Total unredacted size ~125KB.
  // The ring keeps 40 lines (~48KB), which also exceeds MAX_EXPORT_CHARS (32KB).
  for (let i = 0; i < 100; i += 1) {
    capture.add(
      "info",
      `[worker-${i}] token=${config.botToken} chat=${config.chatId} ` +
        `market=${config.marketContractId} squad=${config.squadContractId} ` +
        `payload=${"A".repeat(1_200)} seq=${i}`,
    );
  }

  // Ring buffer capacity is strictly respected: oldest lines were evicted.
  assert.equal(capture.size(), capacity);
  assert.equal(capture.capacity(), capacity);

  const status = baseStatus({
    lastError: {
      at: 5_000,
      message: `fatal RPC error: bot ${config.botToken} rejected for chat ${config.chatId}`,
    },
  });

  const output = renderLogExport(config, status, capture, 6_000);

  // 1. Output length bounds: never exceeds MAX_EXPORT_CHARS (32,000 chars).
  assert.ok(
    output.length <= MAX_EXPORT_CHARS,
    `output length ${output.length} exceeds MAX_EXPORT_CHARS ${MAX_EXPORT_CHARS}`,
  );

  // 2. Absence of every secret: no secret substring survives anywhere.
  assert.equal(output.includes(config.botToken), false, "botToken leaked in export");
  assert.equal(output.includes(config.chatId), false, "chatId leaked in export");
  assert.equal(output.includes("SECRET-TOKEN"), false, "secret substring leaked");
  assert.equal(output.includes("DO-NOT-LEAK"), false, "secret substring leaked");
  assert.equal(output.includes(config.marketContractId), false, "full market contract id leaked");
  assert.equal(output.includes(config.squadContractId), false, "full squad contract id leaked");
  assert.ok(output.includes(REDACTED), "expected REDACTED placeholder in output");

  // 3. Most-recent-first semantics (as implemented):
  // Summary header is preserved at the head.
  assert.ok(output.startsWith("Mimir notifier log export"), "summary header kept");
  // Omission marker is placed in the middle.
  assert.ok(output.includes("…[older log lines omitted]…"), "omission marker present");
  // Newest lines are kept at the tail.
  assert.ok(output.includes("seq=99"), "newest line (seq=99) kept at tail");
  assert.ok(output.includes("seq=98"), "recent line (seq=98) kept at tail");
  // Ring-evicted lines (0..59) are completely absent.
  assert.equal(output.includes("seq=0"), false, "evicted seq=0 must not appear");
  assert.equal(output.includes("seq=30"), false, "evicted seq=30 must not appear");
  assert.equal(output.includes("seq=59"), false, "evicted seq=59 must not appear");
});

test("includes a line exactly straddling the head truncation boundary (index 2000)", () => {
  const config = baseConfig();
  const status = baseStatus();
  const capture = createLogCapture(100);

  // Measure initial prefix length to calibrate line placement.
  capture.add("info", "probe");
  const probeExport = renderLogExport(config, status, capture, 5_000);
  const headPrefixLen = probeExport.indexOf("probe");

  // Calibrate: line 0 fills up to index 1,900.
  const calibratedCapture = createLogCapture(100);
  const line0Len = 1_900 - headPrefixLen;
  calibratedCapture.add("info", "P".repeat(Math.max(0, line0Len)));

  // Line 1 spans across index 2,000 and contains secrets.
  const boundaryMarker = "HEAD_BOUNDARY_CROSS_LINE";
  calibratedCapture.add(
    "warn",
    `${boundaryMarker} token=${config.botToken} chat=${config.chatId} ` +
      `secret_payload=${"H".repeat(200)}`,
  );

  // Add remaining heavy lines to force overall text past MAX_EXPORT_CHARS.
  for (let i = 0; i < 40; i += 1) {
    calibratedCapture.add("info", `filler ${i} ${"X".repeat(1_000)}`);
  }

  const output = renderLogExport(config, status, calibratedCapture, 5_000);

  // Bounded output length.
  assert.ok(output.length <= MAX_EXPORT_CHARS, `length ${output.length} <= ${MAX_EXPORT_CHARS}`);
  // The boundary line was cut by the 2,000-char slice, keeping its start in head.
  assert.ok(output.includes(boundaryMarker), "head boundary line marker kept");
  assert.ok(output.includes("…[older log lines omitted]…"), "omission marker present");
  // Even though sliced right at the boundary, no secret substring survives.
  assert.equal(output.includes(config.botToken), false, "botToken leaked across boundary");
  assert.equal(output.includes(config.chatId), false, "chatId leaked across boundary");
  assert.equal(output.includes("SECRET-TOKEN"), false);
  assert.equal(output.includes("DO-NOT-LEAK"), false);
  assert.ok(output.includes(REDACTED));
});

test("includes a line exactly at the tail truncation boundary (text.length - tailBudget)", () => {
  const config = baseConfig();
  const status = baseStatus();
  const capture = createLogCapture(50);

  // Fill capture with ~35KB of logs to trigger middle truncation.
  for (let i = 0; i < 35; i += 1) {
    capture.add("info", `pre-line ${i} ${"M".repeat(950)}`);
  }

  // Add boundary line containing secrets and identifiable marker.
  const tailBoundaryMarker = "TAIL_BOUNDARY_EXACT_LINE";
  capture.add(
    "error",
    `${tailBoundaryMarker} token=${config.botToken} chat=${config.chatId} payload=${"T".repeat(500)}`,
  );

  // Add newest lines that form the end of the tail.
  for (let i = 0; i < 5; i += 1) {
    capture.add("info", `newest-tail ${i} token=${config.botToken}`);
  }

  const output = renderLogExport(config, status, capture, 5_000);

  assert.ok(output.length <= MAX_EXPORT_CHARS, `length ${output.length} <= ${MAX_EXPORT_CHARS}`);
  assert.ok(output.includes("…[older log lines omitted]…"));
  // Newest lines are guaranteed present.
  assert.ok(output.includes("newest-tail 4"));
  // No secrets survive in the boundary line or newest lines.
  assert.equal(output.includes(config.botToken), false);
  assert.equal(output.includes(config.chatId), false);
  assert.equal(output.includes("SECRET-TOKEN"), false);
  assert.equal(output.includes("DO-NOT-LEAK"), false);
});

test("exact truncation boundary: precisely at MAX_EXPORT_CHARS (32,000) and at MAX_EXPORT_CHARS + 1", () => {
  const config = baseConfig();
  const status = baseStatus();

  // Step 1: Calibrate a single line to land exactly at MAX_EXPORT_CHARS (32,000 characters).
  const baseLine = `exact-boundary token=${config.botToken} chat=${config.chatId} pad=`;
  const probeCapture = createLogCapture(10);
  probeCapture.add("info", baseLine);
  const probeExport = renderLogExport(config, status, probeCapture, 5_000);
  const charsNeeded = MAX_EXPORT_CHARS - probeExport.length;

  const exactCapture = createLogCapture(10);
  exactCapture.add("info", `${baseLine}${"E".repeat(charsNeeded)}`);

  const exactOutput = renderLogExport(config, status, exactCapture, 5_000);
  assert.equal(exactOutput.length, MAX_EXPORT_CHARS, "must be exactly at MAX_EXPORT_CHARS boundary");
  assert.equal(
    exactOutput.includes("…[older log lines omitted]…"),
    false,
    "must not omit lines when exactly at capacity limit",
  );
  assert.equal(exactOutput.includes(config.botToken), false, "no botToken at exact boundary");
  assert.equal(exactOutput.includes(config.chatId), false, "no chatId at exact boundary");
  assert.ok(exactOutput.includes(REDACTED), "REDACTED present at exact boundary");

  // Step 2: Push over boundary by exactly 1 character (32,001 characters).
  // Truncation must engage and pull output length down below MAX_EXPORT_CHARS.
  const overCapture = createLogCapture(10);
  overCapture.add("info", `${baseLine}${"E".repeat(charsNeeded + 1)}`);

  const overOutput = renderLogExport(config, status, overCapture, 5_000);
  assert.ok(
    overOutput.length <= MAX_EXPORT_CHARS,
    `overOutput length ${overOutput.length} must be <= ${MAX_EXPORT_CHARS}`,
  );
  assert.ok(
    overOutput.includes("…[older log lines omitted]…"),
    "omission marker must engage when exceeding boundary by 1 char",
  );
  assert.equal(overOutput.includes(config.botToken), false, "no botToken when over boundary");
  assert.equal(overOutput.includes(config.chatId), false, "no chatId when over boundary");
  assert.ok(overOutput.includes(REDACTED));
});

test("ring buffer boundary: capacity exactly filled and then exceeded by 1 line", () => {
  const config = baseConfig();
  const capacity = 3;
  const capture = createLogCapture(capacity);

  // Fill exactly to capacity.
  capture.add("info", `line-0 token=${config.botToken}`);
  capture.add("warn", `line-1 chat=${config.chatId}`);
  capture.add("error", `line-2 token=${config.botToken} chat=${config.chatId}`);
  assert.equal(capture.size(), 3);
  assert.deepEqual(
    capture.lines().map((l) => l.text.includes("line-")),
    [true, true, true],
  );

  // Add 1 more line at capacity + 1. Oldest line (line-0) must be evicted.
  capture.add("log", `line-3 boundary newest token=${config.botToken}`);
  assert.equal(capture.size(), 3);
  const remainingTexts = capture.lines().map((l) => l.text);
  assert.ok(remainingTexts[0].includes("line-1"), "line-1 is now oldest");
  assert.ok(remainingTexts[1].includes("line-2"), "line-2 is middle");
  assert.ok(remainingTexts[2].includes("line-3"), "line-3 is newest");

  const output = renderLogExport(config, baseStatus(), capture, 5_000);
  assert.equal(output.includes("line-0"), false, "evicted line-0 must not appear in export");
  assert.ok(output.includes("line-3"), "newest line-3 must appear in export");
  assert.equal(output.includes(config.botToken), false);
  assert.equal(output.includes(config.chatId), false);
});

test("multiple interleaved secrets and strkeys in multi-kilobyte payloads", () => {
  const config = baseConfig();
  const capture = createLogCapture(10);

  // Line with multiple secrets, duplicated tokens, and Stellar strkeys.
  const mixedLine =
    `[error] token=${config.botToken} repeated=${config.botToken} ` +
    `chat=${config.chatId} market=${config.marketContractId} ` +
    `squad=${config.squadContractId} payload=${"Z".repeat(4_000)}`;

  capture.add("error", mixedLine);

  const output = renderLogExport(config, baseStatus(), capture, 5_000);
  assert.ok(output.length <= MAX_EXPORT_CHARS);
  assert.equal(output.includes(config.botToken), false);
  assert.equal(output.includes(config.chatId), false);
  assert.equal(output.includes("SECRET-TOKEN"), false);
  assert.equal(output.includes("DO-NOT-LEAK"), false);
  assert.equal(output.includes(config.marketContractId), false);
  assert.equal(output.includes(config.squadContractId), false);
  // Shortened forms of strkeys (first 4 + … + last 4) remain readable.
  assert.ok(output.includes("CDV6…PKZI"), "shortened market contract id retained");
  assert.ok(output.includes("CBPG…CDFY"), "shortened squad contract id retained");
});

test("attachConsole live stream overflowing ring and export bounds", () => {
  const config = baseConfig();
  const capture = createLogCapture(15);
  const restore = attachConsole(capture, secretsFor(config));

  try {
    // Emit 60 lines through console (4x ring capacity) with large payloads.
    for (let i = 0; i < 60; i += 1) {
      console.log(
        `[console-stream-${i}] token=${config.botToken} chat=${config.chatId} ` +
          `data=${"D".repeat(800)}`,
      );
    }
  } finally {
    restore();
  }

  assert.equal(capture.size(), 15);
  const output = renderLogExport(config, baseStatus(), capture, 5_000);

  assert.ok(output.length <= MAX_EXPORT_CHARS);
  assert.equal(output.includes(config.botToken), false);
  assert.equal(output.includes(config.chatId), false);
  assert.equal(output.includes("SECRET-TOKEN"), false);
  assert.equal(output.includes("DO-NOT-LEAK"), false);
  assert.ok(output.includes("console-stream-59"), "most recent stream line kept");
  assert.equal(output.includes("console-stream-0"), false, "evicted stream line absent");
});
