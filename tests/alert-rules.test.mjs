/**
 * Prometheus alert rules verification tests.
 *
 * Parses metric names from `deploy/prometheus/alerts.yml` using a regex (no YAML
 * parser dependency) and verifies that every referenced metric name is emitted
 * by `buildMetricsReport` (and `createMetrics` if `mimir_bot_*` is used).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";

const alertsYamlUrl = new URL("../deploy/prometheus/alerts.yml", import.meta.url);
const alertingDocUrl = new URL("../docs/alerting.md", import.meta.url);

function sampleConfig() {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 30_000,
    startupHealthRetryMs: 1_000,
  };
}

function samplePollerStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 10,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 150_000,
    oldestLedger: 30_000,
    chainClockAt: 5_000,
    notificationsSent: 5,
    notificationsFailed: 1,
    eventsSkipped: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 149_950,
        lastError: null,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: "0018276211125911552-4294967295",
        lastEventLedger: 149_900,
        lastError: null,
      },
    ],
  };
}

/**
 * Strip `# ...` comments from each line and extract all metric identifiers
 * matching `mimir_(?:telegram|bot)_[a-z0-9_]+`.
 */
function extractMetricNamesFromYaml(rawYaml) {
  const withoutComments = rawYaml
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const matches = withoutComments.match(/\bmimir_(?:telegram|bot)_[a-z0-9_]+\b/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Extract emitted metric names from Prometheus exposition output.
 */
function extractEmittedMetrics(expositionText) {
  const names = new Set();
  for (const line of expositionText.split(/\r?\n|\\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
    if (match) names.add(match[1]);
  }
  return names;
}

test("deploy/prometheus/alerts.yml references only metrics emitted by buildMetricsReport", async () => {
  const rawYaml = await readFile(alertsYamlUrl, "utf8");
  const referencedMetrics = extractMetricNamesFromYaml(rawYaml);

  assert.ok(
    referencedMetrics.length >= 4,
    `Expected at least 4 distinct metric names in alerts.yml, found: ${referencedMetrics.join(", ")}`,
  );

  const reportOutput = buildMetricsReport(sampleConfig(), samplePollerStatus(), 10_000);
  const emittedByHealth = extractEmittedMetrics(reportOutput);
  const emittedByRegistry = extractEmittedMetrics(createMetrics().render());

  for (const metric of referencedMetrics) {
    assert.ok(
      reportOutput.includes(metric),
      `Metric "${metric}" in deploy/prometheus/alerts.yml does not appear in buildMetricsReport output`,
    );
    assert.ok(
      emittedByHealth.has(metric) || emittedByRegistry.has(metric),
      `Metric "${metric}" in deploy/prometheus/alerts.yml is not emitted by buildMetricsReport or createMetrics`,
    );
  }
});

test("deploy/prometheus/alerts.yml defines rules for stale cursor, send failures, RPC failure streaks, and process down", async () => {
  const rawYaml = await readFile(alertsYamlUrl, "utf8");
  const alertNames = [...rawYaml.matchAll(/^\s*-\s*alert:\s*([A-Za-z0-9_]+)\s*$/gm)].map(
    (m) => m[1],
  );

  assert.deepEqual(alertNames, [
    "MimirTelegramBotProcessDown",
    "MimirTelegramBotRpcFailureStreak",
    "MimirTelegramBotRepeatedSendFailures",
    "MimirTelegramBotStaleCursor",
  ]);
});

test("docs/alerting.md documents promtool check rules and each alert rule", async () => {
  const rawYaml = await readFile(alertsYamlUrl, "utf8");
  const doc = await readFile(alertingDocUrl, "utf8");

  assert.ok(
    doc.includes("promtool check rules deploy/prometheus/alerts.yml"),
    "docs/alerting.md must document the promtool check rules command",
  );

  const alertNames = [...rawYaml.matchAll(/^\s*-\s*alert:\s*([A-Za-z0-9_]+)\s*$/gm)].map(
    (m) => m[1],
  );
  for (const alertName of alertNames) {
    assert.ok(
      doc.includes(alertName),
      `docs/alerting.md must explain alert rule "${alertName}"`,
    );
  }

  for (const metric of extractMetricNamesFromYaml(rawYaml)) {
    assert.ok(
      doc.includes(metric),
      `docs/alerting.md must reference metric "${metric}"`,
    );
  }
});
