/**
 * Tests for operator restart gap notifications.
 *
 * Scope:
 * - When an unrecoverable restart gap is detected, send one plain-text message
 *   to the operator's private chat with source, missed ledger range and
 *   suggested replay command.
 * - Deduplicate per gap so restarts do not repeat the alert.
 * - Skip silently when no operator is configured.
 * - Send failures are logged and never block polling.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { rpc } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { startMockRpc, defaultMockScenario } from "../dist/stellar/mock-rpc.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_SQUAD_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_BOT_TOKEN,
} from "../dist/stellar/mock-constants.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Soroban TOID cursor for a ledger, matching `eventCursorLedger`. */
const makeCursor = (ledger) => `${(BigInt(ledger) << 32n) | 1n}-0`;

function cursorFileJson(targets) {
  return `${JSON.stringify(
    { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", targets },
    null,
    2,
  )}\n`;
}

function baseConfig(cursorFile, rpcUrl, overrides = {}) {
  return {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: MOCK_BOT_TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: "999888777",
    pollIntervalMs: 20,
    startLookbackLedgers: 60,
    cursorFile,
    lockFile: `${cursorFile}.lock`,
    statusFile: path.join(path.dirname(cursorFile), "status.json"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    shutdownTimeoutMs: 50,
    channelPreviewMode: false,
    ...overrides,
  };
}

test("notifies operator once when unrecoverable restart gap is detected", () =>
  withTempDataDir(async (dir) => {
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const cursorFile = dir.file("cursor-gap.json");

    // Mock RPC default scenario has oldestLedger = 900, latestLedger = 1000.
    // Stale cursor older than retention window: ledger 800 < 900.
    const STALE_LEDGER = 800;
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(STALE_LEDGER), lastEventLedger: STALE_LEDGER },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );

    const operatorAlerts = [];
    const fakeNotifyOperator = async (text) => {
      operatorAlerts.push(text);
    };

    const config = baseConfig(cursorFile, mock.url);
    const poller = createPoller({
      config,
      server: new rpc.Server(mock.url, { allowHttp: true }),
      send: async () => {},
      notifyOperator: fakeNotifyOperator,
      sendOptions: { sendSpacingMs: 0 },
    });

    try {
      await poller.start();
      await until(() => poller.status().restartGaps >= 1, "restart gap detected");
      await until(() => operatorAlerts.length >= 1, "operator alerted");

      assert.equal(operatorAlerts.length, 1, "exactly one alert per gap");
      const alert = operatorAlerts[0];
      assert.match(alert, /market/, "mentions contract source");
      assert.match(alert, /800/, "mentions cursor ledger");
      assert.match(alert, /900/, "mentions floor ledger");
      assert.match(alert, /npm run replay/, "mentions suggested replay command");
      assert.match(alert, /--contract market/, "replay command specifies contract");

      // Verify that further cycles do not duplicate the alert
      await sleep(100);
      assert.equal(operatorAlerts.length, 1, "no duplicate alerts in subsequent cycles");
    } finally {
      await poller.stop();
      await mock.close();
    }
  }));

test("deduplicates across restarts so restarting does not repeat the alert for the same gap", () =>
  withTempDataDir(async (dir) => {
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const cursorFile = dir.file("cursor-gap-restart.json");

    const STALE_LEDGER = 800;
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(STALE_LEDGER), lastEventLedger: STALE_LEDGER },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );

    const operatorAlerts = [];
    const config = baseConfig(cursorFile, mock.url);

    // Instance 1
    const poller1 = createPoller({
      config,
      server: new rpc.Server(mock.url, { allowHttp: true }),
      send: async () => {},
      notifyOperator: async (text) => {
        operatorAlerts.push(text);
      },
      sendOptions: { sendSpacingMs: 0 },
    });

    await poller1.start();
    await until(() => poller1.status().restartGaps >= 1, "restart gap detected instance 1");
    await until(() => operatorAlerts.length === 1, "operator alerted instance 1");
    await poller1.stop();

    assert.equal(operatorAlerts.length, 1);

    // Instance 2 (restart mid-rewind or after rewind)
    const poller2 = createPoller({
      config,
      server: new rpc.Server(mock.url, { allowHttp: true }),
      send: async () => {},
      notifyOperator: async (text) => {
        operatorAlerts.push(text);
      },
      sendOptions: { sendSpacingMs: 0 },
    });

    await poller2.start();
    await until(() => poller2.status().cycles >= 2, "second instance polled");
    await poller2.stop();

    await mock.close();

    assert.equal(operatorAlerts.length, 1, "restarting did not repeat the alert");
  }));

test("skips silently when no operator is configured", () =>
  withTempDataDir(async (dir) => {
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const cursorFile = dir.file("cursor-no-operator.json");

    const STALE_LEDGER = 800;
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(STALE_LEDGER), lastEventLedger: STALE_LEDGER },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );

    const operatorAlerts = [];
    const config = baseConfig(cursorFile, mock.url, { operatorTelegramUserId: null });

    const poller = createPoller({
      config,
      server: new rpc.Server(mock.url, { allowHttp: true }),
      send: async () => {},
      notifyOperator: async (text) => {
        operatorAlerts.push(text);
      },
      sendOptions: { sendSpacingMs: 0 },
    });

    try {
      await poller.start();
      await until(() => poller.status().restartGaps >= 1, "restart gap detected");
      await until(() => poller.status().cycles >= 2, "multiple cycles completed");
      assert.equal(operatorAlerts.length, 0, "no alert sent when operator not configured");
    } finally {
      await poller.stop();
      await mock.close();
    }
  }));

test("operator notification failure is logged and never blocks polling", () =>
  withTempDataDir(async (dir) => {
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const cursorFile = dir.file("cursor-failure.json");

    const STALE_LEDGER = 800;
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(STALE_LEDGER), lastEventLedger: STALE_LEDGER },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );

    let notifyAttempts = 0;
    const failingNotifier = async () => {
      notifyAttempts += 1;
      throw new Error("Telegram network timeout");
    };

    const config = baseConfig(cursorFile, mock.url);
    const poller = createPoller({
      config,
      server: new rpc.Server(mock.url, { allowHttp: true }),
      send: async () => {},
      notifyOperator: failingNotifier,
      sendOptions: { sendSpacingMs: 0 },
    });

    try {
      await poller.start();
      await until(() => poller.status().restartGaps >= 1, "restart gap detected");
      await until(() => notifyAttempts >= 1, "notifier invoked");
      // Verify poller keeps running and advancing cycles despite notification failure
      await until(() => poller.status().cycles >= 3, "poller kept running past failure");
      assert.ok(poller.status().running);
    } finally {
      await poller.stop();
      await mock.close();
    }
  }));
