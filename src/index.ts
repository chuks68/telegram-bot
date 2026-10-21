/**
 * Entry point: config -> RPC client -> bot -> poller -> local health HTTP.
 *
 * Startup is fail-fast (a bad config exits non-zero with the reasons listed);
 * everything after startup is fail-soft, because the whole point of this process
 * is to still be running next week. Shutdown is the mirror image: one bounded
 * drain, one cursor flush, then exit.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { webhookCallback } from "grammy";

import {
  ConfigError,
  activeProfileName,
  configProvenance,
  formatProvenanceSummary,
  loadConfig,
  networkLabel,
} from "./config.js";
import { formatFeatureFlags } from "./notifications/featureFlags.js";
import { auditEntry, createAuditLog } from "./audit.js";
import { InstanceLockError } from "./instanceLock.js";
import { attachConsole, createLogCapture, Logger, secretsFor } from "./logger.js";
import { createBot, createNotifier, registerCommands, type SendExtra } from "./bot.js";
import { startHealthServer } from "./health.js";
import { createPoller, waitForStartupHealth } from "./poller.js";
import type { ContractSource } from "./stellar/decode.js";
import { safeErrorMessage } from "./notifications/format.js";
import { createRpcServer, validateNetworkPassphrase } from "./stellar/client.js";
import { createMetrics } from "./metrics.js";
import type { MetricsServer } from "./metrics.js";
import { boundText } from "./status.js";
import { redactUrl, registerSecrets } from "./redact.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    Logger.error("process", `[error] unhandled rejection: ${safeErrorMessage(reason)}`, {
      action: "unhandled_rejection",
    });
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    Logger.fatal(
      "process",
      `[fatal] uncaught exception, exiting for restart: ${safeErrorMessage(err)}`,
      { action: "uncaught_exception" },
    );
    process.exit(1);
  });
}

/** Redacted shutdown marker: what stopped the process, and nothing else. */
function auditShutdownEntry(signal: string) {
  return auditEntry("shutdown", {
    detail: `stopped by ${signal === "SIGTERM" ? "SIGTERM" : "SIGINT"}`,
  });
}

/**
 * `--status` prints the last snapshot written by a running (or stopped) bot and
 * exits. It reads the file only — it never contacts Telegram or the RPC — so it
 * is safe to run from a health check, a cron job, or a shell on a box where the
 * bot is already running. Exit code 0 when a snapshot was read, 1 otherwise.
 */
async function printStatus(): Promise<void> {
  const config = loadConfig();
  let raw: string;
  try {
    raw = await readFile(config.statusFile, "utf8");
  } catch {
    console.error(
      `[status] no snapshot at ${config.statusFile}; is the bot running? ` +
        `(set STATUS_FILE to point at the running instance's file)`,
    );
    process.exit(1);
  }

  try {
    // Re-serialize rather than echoing the raw bytes: a corrupt or hand-edited
    // file must not be able to inject arbitrary text into a log or a pipe.
    const parsed = JSON.parse(raw) as unknown;
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error(`[status] snapshot is not valid JSON: ${boundText(String(err))}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  Logger.configureFromEnv();
  installProcessHandlers();

  if (process.argv.includes("--status")) {
    await printStatus();
    return;
  }

  const config = loadConfig();

  // Register this process's secrets before anything can fail: every
  // operator-facing error goes through the scrubber, so a call site cannot
  // leak the token or the chat id by forgetting to pass them.
  registerSecrets([config.botToken, config.chatId]);
  Logger.configure({ secrets: [config.botToken] });

  // Log capture installs before the first [boot] line so /export always
  // includes startup context. Capacity 0 keeps capture off entirely.
  const logCapture = createLogCapture(config.logBufferLines);
  const restoreConsole = attachConsole(logCapture, secretsFor(config));
  process.once("exit", restoreConsole);

  // The mock profile exists for the dry-run entry, not this one: warn loudly
  // so a profile left set in a deployment is noticed before Telegram rejects
  // the placeholder token.
  const profile = activeProfileName();
  if (profile !== null) {
    Logger.warn(
      "boot",
      `[boot] MIMIR_PROFILE=${profile} is set: this entry still talks to real Telegram; ` +
        `use "npm run mock:poll" for a credential-free dry run`,
      { profile },
    );
  }

  console.log(`[boot] Mimir Telegram notifier`);
  console.log(`[boot] network      ${networkLabel(config)} (${redactUrl(config.rpcUrl)})`);
  console.log(`[boot] market       ${config.marketContractId}`);
  console.log(`[boot] squad        ${config.squadContractId}`);
  // The chat id is a registered secret: say that it is set, never what it is.
  console.log(`[boot] chat         configured (value redacted)`);
  console.log(
    `[boot] allowlist    ${
      config.allowedChatIds.length === 0
        ? "open (ALLOWED_CHAT_IDS unset)"
        : `${config.allowedChatIds.length} chat(s)`
    }`,
  );
  console.log(`[boot] cursor file  ${config.cursorFile}`);
  console.log(`[boot] flags        ${formatFeatureFlags(config.featureFlags)}`);
  console.log(`[boot] audit file   ${config.auditFile}`);
  console.log(`[boot] lock file    ${config.lockFile}`);
  console.log(`[boot] shutdown     ${config.shutdownTimeoutMs}ms drain budget`);
  Logger.info(
    "boot",
    `[boot] operator      ${config.operatorTelegramUserId === null ? "disabled" : "configured"}`,
    { operatorConfigured: config.operatorTelegramUserId !== null },
  );
  console.log(
    `[boot] claim filter  ${
      config.notificationCategories.length === 0
        ? "all categories"
        : config.notificationCategories.join(", ")
    }`,
  );
  Logger.info(
    "boot",
    `[boot] preview mode  ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    { channelPreviewMode: config.channelPreviewMode },
  );

  // Which setting came from where, then anything an operator can act on. Names
  // and origins only: a value never reaches this log, so a boot log can be
  // pasted into a ticket without redaction.
  const provenance = configProvenance();
  // `ConfigProvenance` is value-free by construction — setting names and where
  // each came from, never a value — so the whole record is safe to log.
  Logger.info("boot", `[boot] config       ${formatProvenanceSummary(provenance)}`, {
    provenance,
  });
  for (const warning of provenance.warnings) {
    Logger.warn("boot", `[boot] config       ${warning}`, { warning });
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  // Create the registry unconditionally; the HTTP server is only started when
  // METRICS_PORT is configured. This means the poller always has a metrics
  // object to call — no null checks needed there.
  const metrics = createMetrics();

  let metricsServer: MetricsServer | null = null;
  if (config.metricsPort !== null) {
    try {
      metricsServer = await metrics.startServer(config.metricsPort);
    } catch (err) {
      // Metrics are optional. A port conflict or privilege error must not
      // prevent the bot from starting — just log and continue.
      console.error(
        `[boot] metrics server failed to start on port ${config.metricsPort}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const server = createRpcServer(config);

  // Bounded retries before announcing readiness: a briefly unavailable RPC
  // (deploy race, Testnet blip) should not fail the whole boot, but a wrong
  // URL must still surface within STARTUP_HEALTH_DEADLINE_MS.
  const health = await waitForStartupHealth(server, {
    deadlineMs: config.startupHealthDeadlineMs,
    retryMs: config.startupHealthRetryMs,
  });
  Logger.info(
    "boot",
    `[boot] rpc ok (attempts=${health.attempts}), status=${health.status} ` +
      `ledgers ${health.oldestLedger}..${health.latestLedger}`,
    {
      action: "rpc_health",
      attempts: health.attempts,
      status: health.status,
      oldestLedger: health.oldestLedger,
      latestLedger: health.latestLedger,
    },
  );

  // Verify that the RPC's network passphrase matches the configured value.
  // This is a safety-critical check: a mismatch indicates either the RPC is
  // pointed at the wrong network, or the configuration is wrong. Fail fast
  // rather than silently emitting notifications on the wrong network.
  try {
    await validateNetworkPassphrase(server, config);
    console.log(`[boot] network passphrase verified`);
  } catch (err) {
    console.error(
      `[fatal] network passphrase verification failed: ${safeErrorMessage(err)}`,
    );
    process.exit(1);
  }

  // The bot needs the poller's status and the poller needs the bot's send path,
  // so one edge of the cycle is late-bound. This one, because it is the only
  // one that is a single function reference.
  let notify: (text: string, source?: ContractSource, extra?: SendExtra) => Promise<void> = async () => {
    throw new Error("telegram notifier not ready");
  };

  const audit = createAuditLog();
  audit.record(
    auditEntry("boot", {
      detail: `network=${networkLabel(config)} poll=${config.pollIntervalMs}ms`,
    }),
  );
  const poller = createPoller({
    config,
    server,
    send: (text, source, extra) => notify(text, source, extra),
    notifyOperator: config.operatorTelegramUserId
      ? async (text: string) => {
          await bot.api.sendMessage(config.operatorTelegramUserId!, text);
        }
      : undefined,
    audit,
    metrics,
  });
  const bot = createBot({
    config,
    status: () => poller.status(),
    audit,
    pause: () => poller.pause(),
    resume: () => poller.resume(),
    logs: logCapture,
  });
  notify = createNotifier(bot, config);

  // Webhook mode only accepts updates carrying this per-process secret, so a
  // reachable health port cannot be used to inject fake Telegram updates.
  const webhookSecret = config.telegramWebhookUrl ? randomBytes(32).toString("hex") : null;

  // Local-only health HTTP for supervisors. Starts before Telegram long-poll
  // so a deploy probe can see the process even while grammy is connecting.
  const healthServer = startHealthServer({
    config,
    status: () => poller.status(),
    logs: logCapture,
    webhookHandler:
      webhookSecret !== null
        ? webhookCallback(bot, "http", { secretToken: webhookSecret })
        : undefined,
  });

  await registerCommands(bot, config);

  // Lock first: refuse a second live instance before Telegram long-polling starts.
  // That keeps a duplicate process from racing the cursor or fighting getUpdates.
  await poller.start();

  if (config.telegramWebhookUrl && webhookSecret !== null) {
    const webhookUrl = new URL("/telegram-webhook", config.telegramWebhookUrl).toString();
    await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
    Logger.info("boot", `[boot] telegram ok, listening for webhooks at ${redactUrl(webhookUrl)}`, {
      telegramOk: true,
      mode: "webhook",
    });
  } else {
    // grammy's `start` resolves only when the bot stops, so it is not awaited.
    // It retries transient network trouble internally; a rejection here means the
    // token itself cannot authenticate, which no amount of waiting fixes.
    void bot
      .start({
        onStart: (me) =>
          Logger.info("boot", `[boot] telegram ok, running as @${me.username}`, {
            telegramOk: true,
            username: me.username,
          }),
      })
      .catch((err: unknown) => {
        Logger.fatal(
          "boot",
          `[fatal] telegram long-polling failed — check BOT_TOKEN: ` +
            safeErrorMessage(err, [config.botToken]),
          { action: "telegram_start_failed" },
        );
        void poller.stop().finally(() => process.exit(1));
      });
  }

  let shuttingDown = false;

  /**
   * First signal: drain. The poller stops scheduling, drops what it has not
   * sent, waits a bounded time for the cycle in flight, and flushes its cursor
   * state — so the restart resumes where this process actually stopped.
   *
   * Second signal: the operator is out of patience. Exiting without the flush
   * is still safe for the file itself (write-then-rename), and the cost is a
   * cold-ish resume bounded by the last completed cycle.
   */
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      Logger.warn("shutdown", `[shutdown] ${signal} received again during drain; forcing exit`, {
        signal,
        forced: true,
      });
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    shuttingDown = true;
    Logger.info("shutdown", `[shutdown] ${signal} received, draining`, { signal });

    // A clean-stop marker closes the audit window: anything after it belongs to
    // the next run, which is how an operator tells a crash from a restart.
    poller.audit.record(auditShutdownEntry(signal));

    // The drain is already bounded by SHUTDOWN_TIMEOUT_MS; this covers the
    // teardown after it (health socket, grammy stop) so a wedged close cannot
    // outlive the deploy. The cursor flush happens before either, so an exit
    // here has already persisted state. Unref'd: it never delays a clean exit.
    const teardownBudgetMs = config.shutdownTimeoutMs + 10_000;
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      Logger.warn(
        "shutdown",
        `[shutdown] teardown still running after ${teardownBudgetMs}ms; exiting without it`,
        { teardownBudgetMs, action: "teardown_timeout" },
      );
      process.exit(1);
    }, teardownBudgetMs);
    watchdog.unref();

    void (async () => {
      try {
        const result = await poller.shutdown();
        Logger.info(
          "shutdown",
          `[shutdown] poller ${result.drained ? "drained" : "hit the drain deadline"}; ` +
            `cursor ${result.flushed ? "flushed" : "flush failed"} after ${result.waitedMs}ms`,
          {
            drained: result.drained,
            cursorFlushed: result.flushed,
            waitedMs: result.waitedMs,
          },
        );
      } catch (err: unknown) {
        Logger.error(
          "shutdown",
          `[shutdown] poller drain failed: ${safeErrorMessage(err)}`,
          { action: "drain_failed" },
        );
      }

      try {
        await healthServer.close();
      } catch (err: unknown) {
        Logger.error(
          "shutdown",
          `[shutdown] health server close failed: ${safeErrorMessage(err)}`,
          { action: "health_close_failed" },
        );
      }

      try {
        await bot.stop();
      } catch (err: unknown) {
        Logger.error(
          "shutdown",
          `[shutdown] telegram stop failed: ${safeErrorMessage(err, [config.botToken])}`,
          { action: "telegram_stop_failed" },
        );
      }

      if (metricsServer) {
        try {
          await metricsServer.close();
        } catch (err: unknown) {
          Logger.error(
            "shutdown",
            `[shutdown] metrics server close failed: ${safeErrorMessage(err)}`,
            { action: "metrics_close_failed" },
          );
        }
      }

      // Flush last so entries recorded while stopping are persisted.
      await poller.flushAuditFile().catch(() => undefined);
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof InstanceLockError) {
    Logger.error("boot", `\n${err.message}\n`, {
      action: "config_error",
      problems: err instanceof ConfigError ? err.problems : undefined,
    });
    process.exit(1);
  }
  Logger.error("boot", `[boot] startup failed: ${safeErrorMessage(err)}`, {
    action: "startup_failed",
  });
  process.exit(1);
});