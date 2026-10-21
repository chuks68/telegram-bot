#!/usr/bin/env node
/**
 * scripts/e2e-smoke.mjs
 *
 * End-to-end smoke verification exercising the real boot path without credentials:
 *  - Profile and configuration loading (MIMIR_PROFILE=mock)
 *  - HTTP Mock RPC startup and health/passphrase validation
 *  - Poller loop initialization with instance locking and cursor management
 *  - Notification decoding and dispatch through a fake Telegram notifier
 *  - Graceful poller shutdown and assertion of expected notifications
 *
 * CLI Options:
 *   --cycles <n>     Number of poller cycles to run (default: 3)
 *   --port <n>       Mock RPC port to bind, 0 for ephemeral (default: 0)
 *   --interval <n>   Poller interval in milliseconds (default: 50)
 *   --timeout <n>    Maximum duration in milliseconds (default: 45000)
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/config.js";
import { createFakeTelegramNotifier } from "../dist/drill.js";
import { createPoller, waitForStartupHealth } from "../dist/poller.js";
import { createRpcServer, validateNetworkPassphrase } from "../dist/stellar/client.js";
import { defaultMockScenario, startMockRpc } from "../dist/stellar/mock-rpc.js";

export const EXPECTED_NOTIFICATIONS_COUNT = 9;
export const EXPECTED_SKIPPED_COUNT = 1;

export const EXPECTED_EVENT_PATTERNS = [
  /New claim/i,
  /Claim .* challenged/i,
  /Claim .* resolved/i,
  /Claim .* settled/i,
  /Challenger paid/i,
  /New squad market/i,
  /Squad .* USDC/i,
  /Squad .* resolved/i,
  /Squad payout/i,
];

export function parseArgs(argv) {
  const args = {
    cycles: 3,
    port: 0,
    intervalMs: 50,
    timeoutMs: 45_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cycles" && argv[i + 1]) {
      args.cycles = Math.max(1, parseInt(argv[++i], 10) || 3);
    } else if (arg.startsWith("--cycles=")) {
      args.cycles = Math.max(1, parseInt(arg.split("=")[1], 10) || 3);
    } else if (arg === "--port" && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10) || 0;
    } else if (arg.startsWith("--port=")) {
      args.port = parseInt(arg.split("=")[1], 10) || 0;
    } else if (arg === "--interval" && argv[i + 1]) {
      args.intervalMs = Math.max(1, parseInt(argv[++i], 10) || 50);
    } else if (arg.startsWith("--interval=")) {
      args.intervalMs = Math.max(1, parseInt(arg.split("=")[1], 10) || 50);
    } else if (arg === "--timeout" && argv[i + 1]) {
      args.timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 45_000);
    } else if (arg.startsWith("--timeout=")) {
      args.timeoutMs = Math.max(1000, parseInt(arg.split("=")[1], 10) || 45_000);
    }
  }

  return args;
}

export async function runSmoke(options = {}) {
  const targetCycles = options.cycles ?? 3;
  const port = options.port ?? 0;
  const intervalMs = options.intervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 45_000;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mimir-smoke-"));
  const cursorFile = path.join(tempDir, "cursor.json");
  const countersFile = path.join(tempDir, "counters.json");
  const lockFile = path.join(tempDir, "poller.lock");
  const statusFile = path.join(tempDir, "status.json");
  const envKeys = [
    "MIMIR_PROFILE",
    "BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "CURSOR_FILE",
    "COUNTERS_FILE",
    "INSTANCE_LOCK_FILE",
    "STATUS_FILE",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  // Select mock profile and temporary isolated files
  process.env.MIMIR_PROFILE = "mock";
  // loadConfig validates Telegram token shape even though the fake notifier
  // never contacts Telegram. Construct this only at runtime; do not commit a
  // token-shaped literal to the repository.
  process.env.BOT_TOKEN = ["123456789", "M".repeat(35)].join(":");
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.CURSOR_FILE = cursorFile;
  process.env.COUNTERS_FILE = countersFile;
  process.env.INSTANCE_LOCK_FILE = lockFile;
  process.env.STATUS_FILE = statusFile;

  let mock = null;
  let poller = null;

  try {
    mock = await startMockRpc({
      port,
      scenario: defaultMockScenario(),
    });

    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      rpcUrl: mock.url,
      cursorFile,
      countersFile,
      lockFile,
      statusFile,
      pollIntervalMs: intervalMs,
      interSendDelayMs: 0,
    };

    const server = createRpcServer(config);

    // Verify startup RPC health and passphrase contract
    await waitForStartupHealth(server, {
      deadlineMs: 10_000,
      retryMs: 200,
    });
    await validateNetworkPassphrase(server, config);

    const notifier = createFakeTelegramNotifier();

    poller = createPoller({
      config,
      server,
      send: notifier.send,
      sleep: async () => {},
    });

    await poller.start();

    // Run until the target cycle count is reached or timeout expires
    const deadline = Date.now() + timeoutMs;
    let completedCycles = 0;
    let lastSuccess = null;

    while (completedCycles < targetCycles) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${targetCycles} cycles (completed ${completedCycles})`,
        );
      }
      const st = poller.status();
      if (st.lastSuccessAt !== null && st.lastSuccessAt !== lastSuccess) {
        lastSuccess = st.lastSuccessAt;
        completedCycles++;
      }
      if (completedCycles >= targetCycles) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const shutdownResult = await poller.shutdown({ timeoutMs: 5_000 });
    const status = poller.status();

    // Verify secrets are not leaked in any message
    notifier.assertNoSecrets([config.botToken, config.chatId]);

    const mismatches = [];

    if (notifier.sent.length !== EXPECTED_NOTIFICATIONS_COUNT) {
      mismatches.push(
        `Expected ${EXPECTED_NOTIFICATIONS_COUNT} sent notifications, but notifier received ${notifier.sent.length}`,
      );
    }

    if (status.notificationsSent !== EXPECTED_NOTIFICATIONS_COUNT) {
      mismatches.push(
        `Expected status.notificationsSent=${EXPECTED_NOTIFICATIONS_COUNT}, got ${status.notificationsSent}`,
      );
    }

    if (status.notificationsFailed !== 0) {
      mismatches.push(
        `Expected status.notificationsFailed=0, got ${status.notificationsFailed}`,
      );
    }

    if (status.eventsSkipped !== EXPECTED_SKIPPED_COUNT) {
      mismatches.push(
        `Expected status.eventsSkipped=${EXPECTED_SKIPPED_COUNT}, got ${status.eventsSkipped}`,
      );
    }

    if (!shutdownResult.flushed) {
      mismatches.push("Expected cursor state to be flushed on shutdown");
    }

    // Verify each expected event pattern was notified
    for (const pattern of EXPECTED_EVENT_PATTERNS) {
      const found = notifier.sent.some((msg) => pattern.test(msg));
      if (!found) {
        mismatches.push(`Missing expected notification matching pattern: ${pattern}`);
      }
    }

    return {
      ok: mismatches.length === 0,
      mismatches,
      cycles: status.cycles,
      notificationsSent: status.notificationsSent,
      notificationsFailed: status.notificationsFailed,
      eventsSkipped: status.eventsSkipped,
      sentMessages: [...notifier.sent],
    };
  } finally {
    if (poller) {
      try {
        await poller.stop();
      } catch {
        // Ignored in teardown
      }
    }
    if (mock) {
      try {
        await mock.close();
      } catch {
        // Ignored in teardown
      }
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[e2e-smoke] Starting mock stack e2e smoke (cycles=${args.cycles}, interval=${args.intervalMs}ms)...`,
  );

  const startMs = Date.now();
  let result;
  try {
    result = await runSmoke(args);
  } catch (err) {
    console.error(`[e2e-smoke] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const durationMs = Date.now() - startMs;

  if (!result.ok) {
    console.error(`[e2e-smoke] FAILED after ${durationMs}ms with ${result.mismatches.length} mismatch(es):`);
    for (const m of result.mismatches) {
      console.error(`  - ${m}`);
    }
    process.exit(1);
  }

  console.log(
    `[e2e-smoke] PASSED in ${durationMs}ms: ${result.cycles} cycles, ` +
      `${result.notificationsSent} notifications sent, ` +
      `${result.notificationsFailed} failed, ` +
      `${result.eventsSkipped} skipped.`,
  );
  process.exit(0);
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}
