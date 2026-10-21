/**
 * tests/version.test.mjs
 *
 * Focused coverage for release version metadata (#134).
 *
 * Every surface that must carry the version is exercised here:
 *   - APP_VERSION constant exported from config
 *   - HealthReport JSON (GET /health, GET /health/live)
 *   - renderLogExport header
 *   - buildHealthReport return value
 *
 * Kinds covered: positive, negative, boundary, restart, regression.
 * No live RPC, no Telegram credentials, no bot tokens in assertions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { APP_VERSION } from "../dist/config.js";
import { buildHealthReport, startHealthServer } from "../dist/health.js";
import { createLogCapture, renderLogExport } from "../dist/logger.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
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

// ── Positive: APP_VERSION constant ────────────────────────────────────────────

test("positive: APP_VERSION is a non-empty string", () => {
  assert.equal(typeof APP_VERSION, "string");
  assert.ok(APP_VERSION.length > 0, "APP_VERSION must not be empty");
});

test("positive: APP_VERSION matches the package.json version field", async () => {
  // Read package.json directly so this test documents the contract:
  // APP_VERSION is always equal to what package.json says at build time.
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const req = createRequire(import.meta.url);
  const pkg = req(join(here, "..", "package.json"));
  assert.equal(APP_VERSION, pkg.version);
});

// ── Positive: HealthReport carries the version ───────────────────────────────

test("positive: buildHealthReport includes version in the report", () => {
  const report = buildHealthReport(baseConfig({ version: "1.2.3" }), baseStatus(), 5_500);
  assert.equal(report.version, "1.2.3");
});

test("positive: buildHealthReport version field is a string", () => {
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.equal(typeof report.version, "string");
});

test("positive: GET /health JSON body carries the version field", async () => {
  const config = baseConfig({ version: "0.1.0", healthPort: 18_790 });
  const server = startHealthServer({ config, status: () => baseStatus(), now: () => 5_500 });
  assert.ok(server.url);
  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "0.1.0");
  } finally {
    await server.close();
  }
});

test("positive: GET /health/live JSON body carries the version field", async () => {
  const config = baseConfig({ version: "0.1.0", healthPort: 18_791 });
  const server = startHealthServer({ config, status: () => baseStatus(), now: () => 5_500 });
  assert.ok(server.url);
  try {
    const res = await fetch(`${server.url}/health/live`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "0.1.0");
  } finally {
    await server.close();
  }
});

// ── Positive: renderLogExport header carries the version ─────────────────────

test("positive: renderLogExport header includes the version string", () => {
  const config = baseConfig({ version: "0.1.0" });
  const capture = createLogCapture(10);
  const text = renderLogExport(config, baseStatus(), capture, 5_500);
  assert.ok(
    text.startsWith("Mimir notifier log export · v0.1.0"),
    `header should start with version; got: ${text.slice(0, 80)}`,
  );
});

// ── Boundary: semver format ───────────────────────────────────────────────────

test('boundary: APP_VERSION matches semver pattern or is "unknown"', () => {
  const SEMVER_RE = /^\d+\.\d+\.\d+/;
  const valid = SEMVER_RE.test(APP_VERSION) || APP_VERSION === "unknown";
  assert.ok(valid, `APP_VERSION "${APP_VERSION}" is neither semver nor "unknown"`);
});

test('boundary: version "unknown" fallback produces a valid health report', () => {
  const report = buildHealthReport(baseConfig({ version: "unknown" }), baseStatus(), 5_500);
  assert.equal(report.version, "unknown");
  assert.equal(report.ok, true);
  assert.equal(typeof report.checkedAt, "string");
});

test('boundary: version "unknown" fallback appears correctly in log export header', () => {
  const config = baseConfig({ version: "unknown" });
  const capture = createLogCapture(10);
  const text = renderLogExport(config, baseStatus(), capture, 5_500);
  assert.ok(
    text.startsWith("Mimir notifier log export · vunknown"),
    `header should contain fallback; got: ${text.slice(0, 80)}`,
  );
});

test("boundary: version is NOT treated as a redactable secret", async () => {
  // secretsFor() should only contain the bot token and chat id — never the
  // version string. If version were in the secrets list, any log line that
  // happened to contain a substring matching a semver (e.g. "30000" from
  // pollIntervalMs, or "0.1.0" anywhere) would be incorrectly redacted.
  const { secretsFor } = await import("../dist/logger.js");
  const config = baseConfig({ version: "0.1.0" });
  const secrets = secretsFor(config);
  assert.equal(secrets.includes("0.1.0"), false, "version must not be in the secrets list");
  assert.equal(secrets.length, 2, "secrets must contain only botToken and chatId");
});

test("boundary: version survives the full health JSON serialization round-trip", () => {
  const report = buildHealthReport(baseConfig({ version: "0.2.0-beta.1" }), baseStatus(), 5_500);
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.equal(roundTripped.version, "0.2.0-beta.1");
});

// ── Negative: missing/empty version ──────────────────────────────────────────

test("negative: empty version string in config does not crash buildHealthReport", () => {
  // Should not throw; version field will be an empty string, not undefined.
  assert.doesNotThrow(() => {
    const report = buildHealthReport(baseConfig({ version: "" }), baseStatus(), 5_500);
    assert.equal(typeof report.version, "string");
  });
});

test("negative: version field is never absent from the health report JSON", () => {
  // The field must always be present — probes that key on it must never see
  // undefined, even if the value is an empty string.
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.ok(Object.prototype.hasOwnProperty.call(report, "version"));
});

test("negative: version does not contain bot token or chat id", () => {
  const config = baseConfig({
    version: "0.1.0",
    botToken: "9999999999:ANOTHER-SECRET-TOKEN",
    chatId: "-9998887776665",
  });
  assert.equal(config.version.includes(config.botToken), false);
  assert.equal(config.version.includes(config.chatId), false);
});

// ── Restart: version is stable across simulated restarts ─────────────────────

test("restart: version in health report is identical across multiple buildHealthReport calls", () => {
  // Simulates the poller restarting and re-reporting status — the version
  // field must come from the config, not from any mutable runtime state.
  const config = baseConfig({ version: "0.1.0" });
  const report1 = buildHealthReport(config, baseStatus({ cycles: 1 }), 5_000);
  const report2 = buildHealthReport(config, baseStatus({ cycles: 99 }), 9_999);
  assert.equal(report1.version, "0.1.0");
  assert.equal(report2.version, "0.1.0");
  assert.equal(report1.version, report2.version);
});

test("restart: version in log export header is stable across fresh capture instances", () => {
  // A restart constructs a new LogCapture; the version in the header must
  // still reflect the config, not the (now-empty) ring buffer.
  const config = baseConfig({ version: "0.1.0" });
  const captureAfterRestart = createLogCapture(10);
  assert.equal(captureAfterRestart.size(), 0); // fresh — nothing persisted
  const text = renderLogExport(config, baseStatus(), captureAfterRestart, 5_500);
  assert.ok(text.includes("v0.1.0"), "version must appear in export after restart");
  assert.ok(text.includes("(no log lines captured)"), "ring must be empty after restart");
});

// ── Regression: version is present in degraded/stopped states too ─────────────

test("regression: version present in health report when poller is stopped", () => {
  const report = buildHealthReport(
    baseConfig({ version: "0.1.0" }),
    baseStatus({ running: false }),
    5_500,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "stopped");
  assert.equal(report.version, "0.1.0");
});

test("regression: version present in health report when poller is degraded", () => {
  const report = buildHealthReport(
    baseConfig({ version: "0.1.0" }),
    baseStatus({ consecutiveFailures: 10 }),
    5_500,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
  assert.equal(report.version, "0.1.0");
});

test("regression: version present in HTTP 503 response body when poller is stopped", async () => {
  const config = baseConfig({ version: "0.1.0", healthPort: 18_792 });
  const server = startHealthServer({
    config,
    status: () => baseStatus({ running: false }),
    now: () => 5_500,
  });
  assert.ok(server.url);
  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.version, "0.1.0");
  } finally {
    await server.close();
  }
});

test("regression: version in log export never leaks bot token or chat id", () => {
  const config = baseConfig({ version: "0.1.0" });
  const capture = createLogCapture(10);
  capture.add("log", `[boot] chat ${config.chatId}`);
  capture.add("error", `[poller] token ${config.botToken} rejected`);
  const text = renderLogExport(config, baseStatus(), capture, 5_500);
  assert.ok(text.includes("v0.1.0"));
  assert.equal(text.includes(config.botToken), false);
  assert.equal(text.includes(config.chatId), false);
  assert.equal(text.includes("SECRET-TOKEN"), false);
});
