/**
 * Configuration inspector CLI.
 *
 * Loads bot configuration the same way src/index.ts does, printing key, source
 * (env, .env, profile, default), and effective value with all secrets redacted.
 *
 * Supports --json for machine-readable output.
 * Warns about unknown/unused environment variables that have known prefixes.
 * Exits non-zero if the configuration fails to load.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ConfigError,
  activeProfileName,
  configProvenance,
  loadConfig,
  type BotConfig,
  type ConfigKeyProvenance,
  type ConfigSource,
} from "./config.js";
import { EXIT_ERROR, EXIT_OK } from "./exitCodes.js";
import { REDACTED, redactText, redactUrl, registerSecrets } from "./redact.js";

export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "MIMIR_PROFILE",
  "MARKET_CONTRACT_ID",
  "MARKET_CONTRACT_VERSION",
  "SQUAD_CONTRACT_ID",
  "SQUAD_CONTRACT_VERSION",
  "STELLAR_NETWORK",
  "STELLAR_RPC_URL",
  "STELLAR_HORIZON_URL",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_EXPLORER_BASE_URL",
  "BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_MARKET_CHAT_ID",
  "TELEGRAM_SQUAD_CHAT_ID",
  "ALLOWED_CHAT_IDS",
  "OPERATOR_TELEGRAM_USER_ID",
  "POLL_INTERVAL_MS",
  "START_LOOKBACK_LEDGERS",
  "CURSOR_FILE",
  "INSTANCE_LOCK_FILE",
  "STATUS_FILE",
  "MAX_NOTIFICATIONS_PER_CYCLE",
  "INTER_SEND_DELAY_MS",
  "METRICS_PORT",
  "CSV_OUTPUT_FILE",
  "NOTIFY_ENABLED",
  "NOTIFY_MARKET",
  "NOTIFY_SQUAD",
  "SILENT_EVENTS",
  "NOTIFY_CATEGORIES",
  "NOTIFICATION_CATEGORIES",
  "NOTIFY_EVENT_CATEGORIES",
  "EVENT_CATEGORIES",
  "CLAIM_CATEGORIES",
  "AUDIT_FILE",
  "EVENT_DEDUP_WINDOW",
  "DEAD_LETTER_FILE",
  "DEAD_LETTER_MAX",
  "DEAD_LETTER_MAX_ATTEMPTS",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "PORT",
  "HEALTH_STALE_MS",
  "STARTUP_HEALTH_DEADLINE_MS",
  "STARTUP_HEALTH_RETRY_MS",
  "SHUTDOWN_TIMEOUT_MS",
  "TELEGRAM_SEND_TIMEOUT_MS",
  "CHANNEL_PREVIEW_MODE",
  "LINK_PREVIEW_MARKET",
  "LINK_PREVIEW_SQUAD",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "LOG_SAMPLE_MAX_PER_WINDOW",
  "LOG_SAMPLE_WINDOW_MS",
  "LOG_BUFFER_LINES",
  "TELEGRAM_WEBHOOK_URL",
  "DOTENV_CONFIG_PATH",
  "DOTENV_CONFIG_ENCODING",
  "DOTENV_CONFIG_OVERRIDE",
  "DOTENV_CONFIG_DEBUG",
]);

export const KNOWN_PREFIXES: readonly string[] = [
  "MIMIR_",
  "STELLAR_",
  "TELEGRAM_",
  "NOTIFY_",
  "NOTIFICATION_",
  "HEALTH_",
  "STARTUP_HEALTH_",
  "DEAD_LETTER_",
  "LINK_PREVIEW_",
  "LOG_",
  "EVENT_",
  "MARKET_",
  "SQUAD_",
  "BOT_",
  "CLAIM_",
  "DOTENV_",
];

export interface ConfigCliEntry {
  key: string;
  source: string;
  value: string | null;
  secret: boolean;
}

export interface ConfigCliReport {
  entries: ConfigCliEntry[];
  warnings: string[];
}

export function formatSource(source: ConfigSource): string {
  switch (source) {
    case "process-env":
      return "env";
    case "env-file":
      return ".env";
    case "profile-default":
      return "profile";
    case "built-in-default":
    case "derived":
      return "default";
    case "unset":
      return "unset";
  }
}

export function findUnknownPrefixKeys(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const unknownKeys: string[] = [];
  for (const key of Object.keys(env)) {
    if (KNOWN_CONFIG_KEYS.has(key)) continue;
    const hasKnownPrefix = KNOWN_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (hasKnownPrefix) {
      unknownKeys.push(key);
    }
  }
  return unknownKeys.sort();
}

function isSecretKey(key: string, specSecret?: boolean): boolean {
  if (specSecret === true) return true;
  const upper = key.toUpperCase();
  return (
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("CHAT_ID") ||
    upper.includes("WEBHOOK") ||
    upper.includes("PASSWORD") ||
    upper.includes("PRIVATE_KEY")
  );
}

function resolveSettingValue(
  key: string,
  entry: ConfigKeyProvenance,
  config: BotConfig,
): string | null {
  if (isSecretKey(key, entry.secret)) {
    if (entry.source === "unset") return null;
    return REDACTED;
  }

  switch (key) {
    case "MIMIR_PROFILE":
      return activeProfileName();
    case "MARKET_CONTRACT_ID":
      return config.marketContractId;
    case "SQUAD_CONTRACT_ID":
      return config.squadContractId;
    case "STELLAR_RPC_URL":
      return redactUrl(config.rpcUrl);
    case "STELLAR_HORIZON_URL":
      return redactUrl(config.horizonUrl);
    case "STELLAR_NETWORK_PASSPHRASE":
      return config.networkPassphrase;
    case "STELLAR_EXPLORER_BASE_URL":
      return config.explorerBaseUrl;
    case "POLL_INTERVAL_MS":
      return String(config.pollIntervalMs);
    case "START_LOOKBACK_LEDGERS":
      return String(config.startLookbackLedgers);
    case "CURSOR_FILE":
      return config.cursorFile;
    case "INSTANCE_LOCK_FILE":
      return config.lockFile;
    case "STATUS_FILE":
      return config.statusFile;
    case "MAX_NOTIFICATIONS_PER_CYCLE":
      return String(config.maxNotificationsPerCycle);
    case "AUDIT_FILE":
      return config.auditFile;
    case "EVENT_DEDUP_WINDOW":
      return String(config.dedupWindow);
    case "HEALTH_HOST":
      return config.healthHost;
    case "HEALTH_PORT":
      return String(config.healthPort);
    case "HEALTH_STALE_MS":
      return String(config.healthStaleMs);
    case "SHUTDOWN_TIMEOUT_MS":
      return String(config.shutdownTimeoutMs);
    case "TELEGRAM_SEND_TIMEOUT_MS":
      return String(config.telegramSendTimeoutMs);
    case "CHANNEL_PREVIEW_MODE":
      return String(config.channelPreviewMode);
    case "LINK_PREVIEW_MARKET":
      return String(config.linkPreviewMarket);
    case "LINK_PREVIEW_SQUAD":
      return String(config.linkPreviewSquad);
    case "PORT":
      return process.env.PORT ?? null;
    default:
      if (entry.source === "unset") return null;
      return redactText(process.env[key] ?? "");
  }
}

export function inspectConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigCliReport {
  // Load config the same way src/index.ts does
  const config = loadConfig();

  // Register process secrets to prevent leaks in any formatting
  registerSecrets([config.botToken, config.chatId]);

  const provenance = configProvenance();
  const unknownKeys = findUnknownPrefixKeys(env);

  const warnings: string[] = [
    ...provenance.warnings,
    ...unknownKeys.map(
      (key) => `Unknown or unused environment variable with known prefix: ${key}`,
    ),
  ];

  const entries: ConfigCliEntry[] = provenance.entries.map((entry) => {
    const secret = isSecretKey(entry.key, entry.secret);
    const value = resolveSettingValue(entry.key, entry, config);
    return {
      key: entry.key,
      source: formatSource(entry.source),
      value,
      secret,
    };
  });

  return { entries, warnings };
}

export function formatReportTable(report: ConfigCliReport): string {
  const maxKeyLen = Math.max(3, ...report.entries.map((e) => e.key.length));
  const maxSourceLen = Math.max(6, ...report.entries.map((e) => e.source.length));

  const lines: string[] = [
    `${"Key".padEnd(maxKeyLen)}  ${"Source".padEnd(maxSourceLen)}  Value`,
    `${"-".repeat(maxKeyLen)}  ${"-".repeat(maxSourceLen)}  ${"-".repeat(30)}`,
  ];

  for (const entry of report.entries) {
    const val = entry.value ?? "(unset)";
    lines.push(
      `${entry.key.padEnd(maxKeyLen)}  ${entry.source.padEnd(maxSourceLen)}  ${val}`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join("\n");
}

export async function runConfigCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const isJson = args.includes("--json");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node dist/config-cli.js [options]

Inspect configuration settings, their provenance sources, and effective values.

Options:
  --json        Output configuration report as JSON
  --help, -h    Show this help message
`);
    return EXIT_OK;
  }

  let report: ConfigCliReport;
  try {
    report = inspectConfig();
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(err.message);
    } else if (err instanceof Error) {
      console.error(`Invalid configuration: ${err.message}`);
    } else {
      console.error(`Invalid configuration: ${String(err)}`);
    }
    return EXIT_ERROR;
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    if (report.warnings.length > 0) {
      for (const w of report.warnings) {
        console.warn(`[WARN] ${w}`);
      }
    }
  } else {
    console.log(formatReportTable(report));
  }

  return EXIT_OK;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runConfigCli()
    .then((code) => {
      if (code !== EXIT_OK) process.exit(code);
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        console.error(err.message);
      } else if (err instanceof Error) {
        console.error(`Invalid configuration: ${err.message}`);
      } else {
        console.error(`Invalid configuration: ${String(err)}`);
      }
      process.exit(EXIT_ERROR);
    });
}
