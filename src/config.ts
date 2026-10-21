/**
 * Environment loading and validation.
 *
 * Fails fast and LOUDLY: a notifier that boots with a missing chat id or a
 * typo'd contract id looks healthy while silently notifying nobody, which is
 * worse than not starting. Every problem found is collected and reported in one
 * error rather than one-at-a-time across restarts.
 *
 * Split into two loaders on purpose:
 *   - {@link loadStellarConfig} needs no Telegram credentials, so the chain
 *     reader (`src/stellar/events.ts`) can be run standalone against Testnet.
 *   - {@link loadConfig} is the full bot config.
 *
 * â”€â”€ Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 * `MIMIR_PROFILE=mock` selects the local Soroban mock profile: it supplies
 * defaults for values the environment does NOT set (loopback RPC, fixture
 * contract ids, an isolated cursor file, placeholder credentials). Explicit
 * environment variables always win, so a profile can never change an existing
 * deployment's configuration. Any other profile name fails fast.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 *
 * {@link configProvenance} reports which source supplied each setting — the
 * environment, the `.env` file, the active profile, a built-in default, or
 * another setting. It reports names and origins only: a value, secret or not,
 * never enters the result, so it is safe in boot logs and in `/health`. The
 * `.env` file is loaded here rather than by `dotenv/config` for exactly that
 * reason: the loader has to see the environment *before* the merge to tell a
 * value the machine provided from one the file provided.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";

import { config as loadDotenv, type DotenvConfigOptions } from "dotenv";

import {
  MOCK_BOT_TOKEN,
  MOCK_CHAT_ID,
  MOCK_CURSOR_FILE,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_PROFILE_NAME,
  MOCK_RPC_DEFAULT_PORT,
  MOCK_SQUAD_CONTRACT_ID,
} from "./stellar/mock-constants.js";

import {
  parseNotificationFeatureFlags,
  type NotificationFeatureFlags,
} from "./notifications/featureFlags.js";
import { DEFAULT_SILENT_EVENTS, KNOWN_EVENT_NAMES } from "./notifications/priority.js";

/** Named Stellar networks the bot understands. `custom` is any other passphrase. */
export type StellarNetwork = "testnet" | "mainnet" | "futurenet" | "custom";

/** Well-known passphrase for each named network. */
export const NETWORK_PASSPHRASES: Record<Exclude<StellarNetwork, "custom">, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

/** Well-known RPC URLs for each named network. */
export const NETWORK_RPC_URLS: Record<Exclude<StellarNetwork, "custom">, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
  futurenet: "https://rpc-futurenet.stellar.org",
};

/** Well-known Horizon URLs for each named network. */
export const NETWORK_HORIZON_URLS: Record<Exclude<StellarNetwork, "custom">, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
};

/**
 * The environment as it was before the `.env` file was merged in.
 *
 * dotenv never overwrites a variable that is already set (unless
 * `DOTENV_CONFIG_OVERRIDE` asks it to), so this snapshot is what separates a
 * value the machine supplied from one the file supplied, without ever comparing
 * the values themselves.
 */
const ENV_BEFORE_FILE = new Set(Object.keys(process.env));

/** What the `.env` file declared, captured once at import. Names only. */
const ENV_FILE = loadEnvFile();

interface EnvFileState {
  /** True when a `.env` file was found and parsed. */
  present: boolean;
  /** Every name the file declares, including the ones it leaves empty. */
  declared: ReadonlySet<string>;
  /** Names whose effective value the file supplied (it can lose a tie). */
  supplied: ReadonlySet<string>;
}

function dotenvConfigOptions(): DotenvConfigOptions {
  // `dotenv/config` is no longer the loader: this module loads the file so it
  // can record where each value came from. Honour the same DOTENV_CONFIG_*
  // variables the CLI loader honours, so existing deployments are unaffected.
  const options: DotenvConfigOptions = {};
  const file = process.env.DOTENV_CONFIG_PATH;
  if (file !== undefined && file.trim() !== "") {
    options.path = path.resolve(process.cwd(), file.trim());
  }
  const encoding = process.env.DOTENV_CONFIG_ENCODING;
  if (encoding !== undefined && encoding.trim() !== "") options.encoding = encoding;
  options.override = process.env.DOTENV_CONFIG_OVERRIDE === "true";
  options.debug = process.env.DOTENV_CONFIG_DEBUG === "true";
  return options;
}

/**
 * Loads `.env` and records which names it supplied. Only the parsed output's
 * *keys* are kept — the values themselves are dropped on the floor here, which
 * is what makes every provenance report below safe to publish.
 */
function loadEnvFile(): EnvFileState {
  try {
    const options = dotenvConfigOptions();
    const result = loadDotenv(options);
    const declared = new Set(Object.keys(result.parsed ?? {}));
    const supplied = new Set(
      [...declared].filter((key) => options.override === true || !ENV_BEFORE_FILE.has(key)),
    );
    // dotenv always returns `parsed` (an empty object when the file is missing)
    // and reports a missing file through `error`, so that is the presence test.
    return { present: result.error === undefined, declared, supplied };
  } catch {
    // An unreadable file is not an error: `read()` already falls back to the
    // real environment, the active profile, then the built-in defaults.
    return { present: false, declared: new Set(), supplied: new Set() };
  }
}

/**
 * Package version read once at startup from `package.json`. Surfaced in the
 * health report, `/status`, boot logs, and log exports so operators can
 * confirm which release is running without a shell session on the host.
 *
 * Falls back to `"unknown"` when the field is absent or the file cannot be
 * loaded (e.g. a custom build that strips the manifest).
 */
export const APP_VERSION: string = (() => {
  try {
    // createRequire is the idiomatic way to load JSON in ESM without enabling
    // resolveJsonModule (which would require declaration file emission).
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: unknown };
    const v = pkg.version;
    return typeof v === "string" && v.length > 0 ? v : "unknown";
  } catch {
    return "unknown";
  }
})();

export interface StellarConfig {
  /** Named network, derived from STELLAR_NETWORK or inferred from the passphrase. */
  network?: StellarNetwork;
  marketContractId: string;
  squadContractId: string;
  marketContractVersion: string;
  squadContractVersion: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Optional override for stellar.expert (or compatible) explorer origin. */
  explorerBaseUrl: string;
}

export interface TelegramRoute {
  chatId: string;
  channelPreviewMode: boolean;
}

export interface BotConfig extends StellarConfig {
  /** Semver string from `package.json`, or `"unknown"` if unavailable. */
  version: string;
  botToken: string;
  chatId: string;
  /** Every chat id listed in TELEGRAM_CHAT_ID; `chatId` is the first. */
  chatIds?: string[];
  /** Optional per-contract destinations; absent values use `chatId`. */
  marketChatId?: string;
  squadChatId?: string;
  /** Chats allowed to use /status. Empty array means no restriction. */
  allowedChatIds: string[];
  /** Telegram user id allowed to run operator-only commands. Null disables them. */
  operatorTelegramUserId: string | null;
  pollIntervalMs: number;
  startLookbackLedgers: number;
  cursorFile: string;
  /** Persisted poller counters across restarts. */
  countersFile?: string;
  /** Exclusive lock so only one process owns the cursor. */
  lockFile: string;
  statusFile: string;
  maxNotificationsPerCycle: number;
  /** Pause between Telegram sends within a cycle (INTER_SEND_DELAY_MS). */
  interSendDelayMs: number;
  /** Port for the Prometheus `/metrics` listener; null disables it. */
  metricsPort: number | null;
  /** Optional allowlist of claim categories to notify about. Empty means allow all. */
  notificationCategories: readonly string[];
  /** Event names sent without a notification sound (SILENT_EVENTS). */
  silentEvents: readonly string[];
  /** Path for the standalone scanner's CSV output (see CSV_OUTPUT_FILE). */
  csvOutputFile: string;
  /** Coarse notification feature flags (see NOTIFY_* env vars). */
  featureFlags: NotificationFeatureFlags;
  /** Append-only JSONL audit trail (see src/audit.ts). Empty disables it. */
  auditFile: string;
  /**
   * Number of recent event ids retained per contract to suppress redelivery
   * across overlapping pages, resumed cursors, and restarts. `0` disables it.
   */
  dedupWindow: number;
  /**
   * Bounded on-disk queue for sends that exhausted their in-cycle
   * retries. Empty disables the queue (see src/deadLetter.ts).
   */
  deadLetterFile: string;
  /** Parked sends retained; the oldest is dropped once the queue is full. */
  deadLetterMax: number;
  /** Replay attempts before a parked send is dropped as poison. */
  deadLetterMaxAttempts: number;
  /**
   * Crash-safe send journal: intent is logged before a Telegram send and done
   * after, so a restart can tell which notifications may have been sent
   * (see src/notifications/send-journal.ts). Empty disables the journal.
   */
  sendJournalFile: string;
  /** Loopback host for the local HTTP health endpoint. */
  healthHost: string;
  /** TCP port for the health endpoint. `0` disables the listener. */
  healthPort: number;
  /**
   * After the first successful poll, treat the process as degraded if no
   * successful cycle lands within this window. `0` disables the stale check.
   */
  healthStaleMs: number;
  /**
   * Wall-clock budget for retrying the startup RPC `getHealth()` probe.
   * `0` means a single attempt with no retries.
   */
  startupHealthDeadlineMs: number;
  /**
   * Delay between failed startup RPC health attempts (capped by remaining
   * deadline). Ignored when `startupHealthDeadlineMs` is `0`.
   */
  startupHealthRetryMs: number;
  /**
   * How long a graceful shutdown waits for an in-flight cycle before flushing
   * cursor state and giving up on it. `0` skips the wait entirely.
   */
  shutdownTimeoutMs: number;
  /** Wall-clock budget for a single Telegram send before it is abandoned. */
  telegramSendTimeoutMs: number;
  /** Alias of `telegramSendTimeoutMs` accepted from hand-built configs. */
  sendTimeoutMs?: number;
  /** When true, notifications sent to Telegram are formatted in preview mode. */
  channelPreviewMode: boolean;
  /** Show Telegram link previews on market notifications (LINK_PREVIEW_MARKET). */
  linkPreviewMarket: boolean;
  /** Show Telegram link previews on squad notifications (LINK_PREVIEW_SQUAD). */
  linkPreviewSquad: boolean;
  /** Per-chat notification preferences. Optional; absent means the single chat route. */
  routes?: TelegramRoute[];
  /**
   * Identical RPC/poller error lines allowed per key per sampling window.
   * Repeats beyond this are counted and reported as one summary line.
   */
  logSampleMaxPerWindow: number;
  /** Sampling window for repetitive error logs, in milliseconds. */
  logSampleWindowMs: number;
  /** Recent console lines kept (redacted) for /export. `0` disables capture. */
  logBufferLines: number;
  /** Optional public URL to run the bot in webhook mode instead of long-polling. */
  telegramWebhookUrl: string | null;
  /** Dev-only override for grammy's `client.apiRoot`; loopback hosts only. */
  telegramApiRoot: string | null;
  /**
   * Optional Mimir web-app origin (MIMIR_APP_URL) behind the "Open in Mimir"
   * notification button; null leaves the keyboard explorer-only. Validated as
   * an https URL at load time.
   */
  mimirAppUrl: string | null;
}

/** Fallback drain budget when a config object predates `SHUTDOWN_TIMEOUT_MS`. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Fallback per-send budget when a config object predates `TELEGRAM_SEND_TIMEOUT_MS`. */
export const DEFAULT_TELEGRAM_SEND_TIMEOUT_MS = 10_000;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], hint?: string) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\n${hint ?? "Copy .env.example to .env and fill in the missing values."}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULTS = {
  network: "testnet" as StellarNetwork,
  rpcUrl: NETWORK_RPC_URLS.testnet,
  horizonUrl: NETWORK_HORIZON_URLS.testnet,
  networkPassphrase: NETWORK_PASSPHRASES.testnet,
  pollIntervalMs: 30_000,
  minPollIntervalMs: 5_000,
  startLookbackLedgers: 60,
  cursorFile: "./data/cursor.json",
  countersFile: "./data/counters.json",
  lockFile: "./data/poller.lock",
  statusFile: "./data/status.json",
  maxNotificationsPerCycle: 20,
  interSendDelayMs: 1_500,
  csvOutputFile: "./data/scanner_output.csv",
  auditFile: "./data/audit.jsonl",
  dedupWindow: 256,
  deadLetterFile: "./data/dead-letter.json",
  deadLetterMax: 100,
  deadLetterMaxAttempts: 10,
  sendJournalFile: "./data/send-journal.jsonl",
  healthHost: "127.0.0.1",
  healthPort: 8787,
  // 3Ã— default poll interval â€” one missed cycle is fine; three is not.
  healthStaleMs: 90_000,
  // Retry RPC getHealth at boot for up to 30s (Testnet blips / deploy races).
  startupHealthDeadlineMs: 30_000,
  startupHealthRetryMs: 1_000,
  // Long enough for an in-flight read to finish and its cursors to land, short
  // enough that a deploy is never held open by a wedged RPC.
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  // Bounded so one wedged Telegram send cannot stall the poll loop; long
  // enough for a normal API round-trip on a slow link.
  telegramSendTimeoutMs: DEFAULT_TELEGRAM_SEND_TIMEOUT_MS,
  channelPreviewMode: false,
  linkPreviewMarket: false,
  linkPreviewSquad: false,
  logSampleMaxPerWindow: 3,
  // ~10 default poll cycles of a down RPC, collapsed into one line plus a
  // summary. Long enough not to hide a flapping error, short enough to bound
  // an outage that lasts for hours.
  logSampleWindowMs: 300_000,
  logBufferLines: 500,
} as const;

/**
 * Platform deployers (Railway among them) inject a `PORT` variable and probe it
 * for the deploy healthcheck. When `HEALTH_PORT` is unset we fall back to it,
 * so the `/health` listener is reachable without a manual override. `PORT` is
 * not a default local dev value, so the loopback port still wins on a desktop.
 */
function defaultHealthPort(): number {
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0) return port;
  return DEFAULTS.healthPort;
}

/** Strkey for a contract: `C` + 55 base32 characters. */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Defaults each profile supplies for values the environment leaves unset.
 * Profile values never override explicit environment variables.
 */
const PROFILE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [MOCK_PROFILE_NAME]: {
    STELLAR_NETWORK: "custom",
    MARKET_CONTRACT_ID: MOCK_MARKET_CONTRACT_ID,
    SQUAD_CONTRACT_ID: MOCK_SQUAD_CONTRACT_ID,
    STELLAR_RPC_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}`,
    STELLAR_HORIZON_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}/horizon`,
    STELLAR_NETWORK_PASSPHRASE: MOCK_NETWORK_PASSPHRASE,
    CURSOR_FILE: MOCK_CURSOR_FILE,
    BOT_TOKEN: MOCK_BOT_TOKEN,
    TELEGRAM_CHAT_ID: MOCK_CHAT_ID,
  },
};

/** The profile selected by `MIMIR_PROFILE`, or null when unset. Display/boot use. */
export function activeProfileName(): string | null {
  return read("MIMIR_PROFILE") ?? null;
}

/** Profile defaults for the active profile. Unknown names fail fast. */
function resolveProfileDefaults(): Record<string, string> {
  const name = read("MIMIR_PROFILE");
  if (name === undefined) return {};
  const defaults = PROFILE_DEFAULTS[name];
  if (!defaults) {
    throw new ConfigError(
      [`MIMIR_PROFILE must be "${MOCK_PROFILE_NAME}" when set; got "${name}"`],
      `Unset MIMIR_PROFILE, or set MIMIR_PROFILE=${MOCK_PROFILE_NAME} for the local mock.`,
    );
  }
  return { ...defaults };
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Telegram bot token shape: `<digits>:<35+ url-safe chars>`.
 *
 * The id part is numeric and the secret part is base64url-ish (`A-Za-z0-9_-`).
 * Real tokens are ~46 chars total, but the secret length has grown over time,
 * so only a lower bound is enforced.
 */
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35,}$/;

/** Characters that suggest a value was pasted with surrounding quotes. */
const QUOTE_CHARS = new Set(['"', "'", "`", "\u2018", "\u2019", "\u201C", "\u201D"]);

/**
 * Explains why `BOT_TOKEN` is not a valid token, without echoing any part of
 * it. Returns `null` when the value is well-formed.
 *
 * The message names the *kind* of problem (quotes, whitespace, missing colon,
 * wrong shape) so an operator can fix it in one pass, but never includes a
 * character of the token itself.
 */
function describeBotTokenProblem(raw: string): string | null {
  if (BOT_TOKEN_RE.test(raw)) return null;

  const trimmed = raw.trim();
  const hasSurroundingWhitespace = trimmed !== raw;
  const hasSurroundingQuotes =
    raw.length >= 2 &&
    QUOTE_CHARS.has(raw[0]!) &&
    QUOTE_CHARS.has(raw[raw.length - 1]!);
  const hasInnerWhitespace = /\s/.test(trimmed);

  const hints: string[] = [];
  if (hasSurroundingQuotes) {
    hints.push("it is wrapped in quotes — paste the token without them");
  }
  if (hasSurroundingWhitespace) {
    hints.push("it has leading or trailing whitespace — trim it");
  }
  if (hasInnerWhitespace) {
    hints.push("it contains whitespace inside the value");
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    hints.push("it is missing the ':' separator between the id and the secret");
  } else if (colonIndex === 0 || colonIndex === trimmed.length - 1) {
    hints.push("the ':' separator must sit between the id and the secret");
  } else if (!/^\d+$/.test(trimmed.slice(0, colonIndex))) {
    hints.push("the part before ':' must be the numeric bot id");
  } else if (!/^[A-Za-z0-9_-]{35,}$/.test(trimmed.slice(colonIndex + 1))) {
    hints.push(
      "the part after ':' must be at least 35 url-safe characters (A-Z, a-z, 0-9, '_', '-')",
    );
  }

  if (hints.length === 0) {
    hints.push("it does not match the expected <digits>:<35+ url-safe chars> shape");
  }

  return `BOT_TOKEN is not a valid Telegram bot token: ${hints.join("; ")}`;
}

function collector(profile: Record<string, string>) {
  const problems: string[] = [];
  /** Environment first, then the active profile's defaults. */
  const get = (name: string): string | undefined => read(name) ?? profile[name];

  return {
    problems,

    get,

    required(name: string): string {
      const value = get(name);
      if (value === undefined) {
        problems.push(`${name} is required but not set`);
        return "";
      }
      return value;
    },

    /**
     * Validates `BOT_TOKEN` shape at load time so a quoted or padded paste
     * fails fast with a clear message instead of surfacing as a `getMe`
     * failure at startup. The message never includes any part of the token.
     */
    botToken(name: string): string {
      const value = this.required(name);
      if (value === "") return value;
      const problem = describeBotTokenProblem(value);
      if (problem !== null) problems.push(problem);
      return value;
    },

    contractId(name: string): string {
      const value = this.required(name);
      if (value !== "" && !CONTRACT_ID_RE.test(value)) {
        problems.push(
          `${name} is not a Soroban contract id (expected Câ€¦ strkey, 56 chars); got "${value}"`,
        );
      }
      return value;
    },

    contractVersion(name: string, fallback: string): string {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const trimmed = raw.toLowerCase().trim();
      if (!/^[a-z0-9_.-]+$/.test(trimmed)) {
        problems.push(`${name} must be a valid version string (e.g. v1, v2); got "${raw}"`);
        return fallback;
      }
      return trimmed;
    },

    url(name: string, fallback: string): string {
      const value = get(name) ?? fallback;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          problems.push(`${name} must be an http(s) URL; got "${value}"`);
        }
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
      }
      return value;
    },

    optionalUrl(name: string): string | null {
      const value = read(name);
      if (value === undefined) return null;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          problems.push(`${name} must be an http(s) URL; got "${value}"`);
        }
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
      }
      return value;
    },

    /**
     * Optional dev-only Telegram Bot API root. Must be a loopback http URL so a
     * misconfigured deployment can never silently route traffic to a fake.
     */
    loopbackApiRoot(name: string): string | null {
      const value = read(name);
      if (value === undefined) return null;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
        return null;
      }
      if (parsed.protocol !== "http:") {
        problems.push(`${name} must use http:// (loopback only); got "${value}"`);
        return null;
      }
      const host = parsed.hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        problems.push(
          `${name} must point at 127.0.0.1 or localhost (dev only); got "${value}"`,
        );
        return null;
      }
      return value;
    },

    /**
     * Parse an optional https-only URL. Returns `null` when unset, and also
     * when the value is unusable — a Telegram button must never carry an
     * off-site or plain-http origin, so the problem is reported and the link
     * stays disabled instead of being downgraded.
     */
    optionalHttpsUrl(name: string): string | null {
      const value = read(name);
      if (value === undefined) return null;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:") {
          problems.push(`${name} must be an https URL; got "${value}"`);
          return null;
        }
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
        return null;
      }
      return value;
    },

    int(name: string, fallback: number, min: number): number {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        problems.push(`${name} must be an integer; got "${raw}"`);
        return fallback;
      }
      if (parsed < min) {
        problems.push(`${name} must be >= ${min}; got ${parsed}`);
        return fallback;
      }
      return parsed;
    },

    bool(name: string, fallback: boolean): boolean {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return true;
      if (lower === "false" || lower === "0" || lower === "no") return false;
      problems.push(`${name} must be a boolean (true/false); got "${raw}"`);
      return fallback;
    },

    chatIds(name: string): string[] {
      const value = this.required(name);
      if (value === "") return [];
      
      const ids = value.split(",").map(s => s.trim()).filter(s => s !== "");
      if (ids.length === 0) {
        problems.push(`${name} is required but not set`);
        return [];
      }
      for (const id of ids) {
        if (!/^-?\d+$/.test(id) && !/^@[A-Za-z0-9_]{4,}$/.test(id)) {
          problems.push(
            `${name} must contain numeric chat ids or @channelusernames; got "${id}"`,
          );
        }
      }
      return ids;
    },

    /**
     * Parse an optional TCP port number. Returns `null` when the env var is
     * absent/empty (server disabled). Validates 1–65535 when present.
     */
    optionalPort(name: string): number | null {
      const raw = read(name);
      if (raw === undefined) return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        problems.push(`${name} must be an integer port number (1–65535); got "${raw}"`);
        return null;
      }
      if (parsed < 1 || parsed > 65_535) {
        problems.push(`${name} must be between 1 and 65535; got ${parsed}`);
        return null;
      }
      return parsed;
    },

    optionalChatId(name: string, fallback: string): string {
      const value = read(name) ?? fallback;
      if (value === "") return value;
      if (!/^-?\d+$/.test(value) && !/^@[A-Za-z0-9_]{4,}$/.test(value)) {
        problems.push(
          `${name} must be a numeric chat id (e.g. -1001234567890) or a @channelusername; got "${value}"`,
        );
      }
      return value;
    },

    /**
     * Parses an optional comma-separated list of chat ids / @usernames.
     * Returns an empty array when the variable is absent or empty (= no
     * restriction). Each entry is validated with the same rules as chatId.
     */
    allowedChatIds(name: string): string[] {
      const raw = read(name);
      if (raw === undefined) return [];

      const entries = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const entry of entries) {
        if (!/^-?\d+$/.test(entry) && !/^@[A-Za-z0-9_]{4,}$/.test(entry)) {
          problems.push(
            `${name} contains an invalid entry "${entry}" â€” ` +
              `each value must be a numeric chat id or a @channelusername`,
          );
        }
      }

      return entries;
    },

    optionalUserId(name: string): string | null {
      const value = read(name);
      if (value === undefined) return null;
      if (!/^[1-9]\d*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
        problems.push(`${name} must be a positive Telegram user id; got "${value}"`);
        return null;
      }
      return value;
    },

    host(name: string, fallback: string): string {
      const value = read(name) ?? fallback;
      // Keep this a host, not a URL â€” the health server binds a TCP listener.
      if (/[\s/]/.test(value) || value.includes("://")) {
        problems.push(
          `${name} must be a hostname or IP (e.g. 127.0.0.1); got "${value}"`,
        );
      }
      return value;
    },

    network(name: string, fallback: StellarNetwork): StellarNetwork {
      const value = get(name);
      if (value === undefined) return fallback;
      const valid: StellarNetwork[] = ["testnet", "mainnet", "futurenet", "custom"];
      if (!valid.includes(value as StellarNetwork)) {
        problems.push(
          `${name} must be one of ${valid.join(", ")}; got "${value}"`,
        );
        return fallback;
      }
      return value as StellarNetwork;
    },
  };
}

function parseNotificationCategories(raw: string | undefined): string[] {
  const candidates = raw
    ? raw.split(/[\s,]+/)
    : [];

  const normalized = [...new Set(
    candidates
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  )];

  return normalized;
}

function notificationCategoriesFrom(): readonly string[] {
  const envValues = [
    "NOTIFY_CATEGORIES",
    "NOTIFICATION_CATEGORIES",
    "NOTIFY_EVENT_CATEGORIES",
    "EVENT_CATEGORIES",
    "CLAIM_CATEGORIES",
  ]
    .map((name) => read(name))
    .filter((value): value is string => value !== undefined && value.trim().length > 0);

  if (envValues.length === 0) return [];
  return parseNotificationCategories(envValues.join(","));
}

function silentEventsFrom(c: ReturnType<typeof collector>): readonly string[] {
  const raw = c.get("SILENT_EVENTS");
  if (raw === undefined || raw.trim() === "") return DEFAULT_SILENT_EVENTS;

  const entries = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  for (const entry of entries) {
    if (!(KNOWN_EVENT_NAMES as readonly string[]).includes(entry)) {
      c.problems.push(`SILENT_EVENTS contains unknown event name "${entry}"`);
    }
  }
  return entries;
}

function stellarFrom(c: ReturnType<typeof collector>): StellarConfig {
  // An explicit STELLAR_NETWORK wins; otherwise an explicit passphrase names
  // the network (beating a profile's default), so a passphrase-only deployment
  // is not mislabelled testnet.
  const passphraseOverride = read("STELLAR_NETWORK_PASSPHRASE");
  const namedNetwork =
    read("STELLAR_NETWORK") !== undefined || passphraseOverride === undefined
      ? c.network("STELLAR_NETWORK", DEFAULTS.network)
      : undefined;
  const network = namedNetwork ?? inferNetwork(passphraseOverride ?? "");
  const namedDefaults = network !== "custom" ? {
    rpcUrl: NETWORK_RPC_URLS[network],
    horizonUrl: NETWORK_HORIZON_URLS[network],
    passphrase: NETWORK_PASSPHRASES[network],
  } : {
    rpcUrl: DEFAULTS.rpcUrl,
    horizonUrl: DEFAULTS.horizonUrl,
    passphrase: DEFAULTS.networkPassphrase,
  };

  return {
    // Left unset when only a passphrase was given, so labels infer from it.
    ...(namedNetwork !== undefined ? { network: namedNetwork } : {}),
    marketContractId: c.contractId("MARKET_CONTRACT_ID"),
    squadContractId: c.contractId("SQUAD_CONTRACT_ID"),
    marketContractVersion: c.contractVersion("MARKET_CONTRACT_VERSION", "v1"),
    squadContractVersion: c.contractVersion("SQUAD_CONTRACT_VERSION", "v1"),
    rpcUrl: c.url("STELLAR_RPC_URL", namedDefaults.rpcUrl),
    horizonUrl: c.url("STELLAR_HORIZON_URL", namedDefaults.horizonUrl),
    networkPassphrase: c.get("STELLAR_NETWORK_PASSPHRASE") ?? namedDefaults.passphrase,
    explorerBaseUrl: c.url(
      "STELLAR_EXPLORER_BASE_URL",
      "https://stellar.expert/explorer",
    ),
  };
}

/** Chain-only config. No Telegram credentials required. */
export function loadStellarConfig(): StellarConfig {
  const c = collector(resolveProfileDefaults());
  const config = stellarFrom(c);
  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/**
 * Resolve just the status snapshot path. Used by `--status`, which must work
 * without BOT_TOKEN: reading a status file is a read-only operation and should
 * not require the credentials of the process that wrote it.
 */
export function resolveStatusFile(): string {
  return path.resolve(process.cwd(), read("STATUS_FILE") ?? DEFAULTS.statusFile);
}

/** Full bot config: chain + Telegram + poller tuning. */
export function loadConfig(): BotConfig {
  const c = collector(resolveProfileDefaults());
  const stellar = stellarFrom(c);

  const featureFlagsParsed = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: read("NOTIFY_ENABLED"),
    NOTIFY_MARKET: read("NOTIFY_MARKET"),
    NOTIFY_SQUAD: read("NOTIFY_SQUAD"),
  });
  for (const problem of featureFlagsParsed.problems) c.problems.push(problem);
  const chatIds = c.chatIds("TELEGRAM_CHAT_ID");

  const config: BotConfig = {
    ...stellar,
    version: APP_VERSION,
    botToken: c.botToken("BOT_TOKEN"),
    chatId: chatIds[0] ?? "",
    chatIds,
    marketChatId: c.optionalChatId("TELEGRAM_MARKET_CHAT_ID", c.get("TELEGRAM_CHAT_ID") ?? ""),
    squadChatId: c.optionalChatId("TELEGRAM_SQUAD_CHAT_ID", c.get("TELEGRAM_CHAT_ID") ?? ""),
    allowedChatIds: c.allowedChatIds("ALLOWED_CHAT_IDS"),
    operatorTelegramUserId: c.optionalUserId("OPERATOR_TELEGRAM_USER_ID"),
    pollIntervalMs: c.int("POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs, DEFAULTS.minPollIntervalMs),
    startLookbackLedgers: c.int("START_LOOKBACK_LEDGERS", DEFAULTS.startLookbackLedgers, 0),
    cursorFile: path.resolve(process.cwd(), c.get("CURSOR_FILE") ?? DEFAULTS.cursorFile),
    countersFile: path.resolve(process.cwd(), c.get("COUNTERS_FILE") ?? DEFAULTS.countersFile),
    lockFile: path.resolve(process.cwd(), read("INSTANCE_LOCK_FILE") ?? DEFAULTS.lockFile),
    statusFile: path.resolve(process.cwd(), c.get("STATUS_FILE") ?? DEFAULTS.statusFile),
    maxNotificationsPerCycle: c.int(
      "MAX_NOTIFICATIONS_PER_CYCLE",
      DEFAULTS.maxNotificationsPerCycle,
      1,
    ),
    interSendDelayMs: c.int("INTER_SEND_DELAY_MS", DEFAULTS.interSendDelayMs, 0),
    metricsPort: c.optionalPort("METRICS_PORT"),
    notificationCategories: notificationCategoriesFrom(),
    silentEvents: silentEventsFrom(c),
    csvOutputFile: path.resolve(process.cwd(), c.get("CSV_OUTPUT_FILE") ?? DEFAULTS.csvOutputFile),
    featureFlags: featureFlagsParsed.flags,
    // Resolved like the cursor file: relative paths anchor to the process cwd.
    auditFile: path.resolve(process.cwd(), read("AUDIT_FILE") ?? DEFAULTS.auditFile),
    // 0 is the documented escape hatch: no redelivery suppression.
    dedupWindow: c.int("EVENT_DEDUP_WINDOW", DEFAULTS.dedupWindow, 0),
    // Resolved like the cursor file: relative paths anchor to the cwd.
    deadLetterFile: path.resolve(
      process.cwd(),
      c.get("DEAD_LETTER_FILE") ?? DEFAULTS.deadLetterFile,
    ),
    deadLetterMax: c.int("DEAD_LETTER_MAX", DEFAULTS.deadLetterMax, 1),
    deadLetterMaxAttempts: c.int(
      "DEAD_LETTER_MAX_ATTEMPTS",
      DEFAULTS.deadLetterMaxAttempts,
      1,
    ),
    sendJournalFile: path.resolve(
      process.cwd(),
      read("SEND_JOURNAL_FILE") ?? DEFAULTS.sendJournalFile,
    ),
    healthHost: c.host("HEALTH_HOST", DEFAULTS.healthHost),
    // Port 0 is the explicit disable switch (min 0).
    healthPort: c.int("HEALTH_PORT", defaultHealthPort(), 0),
    healthStaleMs: c.int("HEALTH_STALE_MS", DEFAULTS.healthStaleMs, 0),
    // 0 = single attempt (no retries) for the startup RPC probe.
    startupHealthDeadlineMs: c.int(
      "STARTUP_HEALTH_DEADLINE_MS",
      DEFAULTS.startupHealthDeadlineMs,
      0,
    ),
    startupHealthRetryMs: c.int(
      "STARTUP_HEALTH_RETRY_MS",
      DEFAULTS.startupHealthRetryMs,
      0,
    ),
    shutdownTimeoutMs: c.int("SHUTDOWN_TIMEOUT_MS", DEFAULTS.shutdownTimeoutMs, 0),
    telegramSendTimeoutMs: c.int(
      "TELEGRAM_SEND_TIMEOUT_MS",
      DEFAULTS.telegramSendTimeoutMs,
      0,
    ),
    channelPreviewMode: c.bool("CHANNEL_PREVIEW_MODE", DEFAULTS.channelPreviewMode),
    linkPreviewMarket: c.bool("LINK_PREVIEW_MARKET", DEFAULTS.linkPreviewMarket),
    linkPreviewSquad: c.bool("LINK_PREVIEW_SQUAD", DEFAULTS.linkPreviewSquad),
    logSampleMaxPerWindow: c.int(
      "LOG_SAMPLE_MAX_PER_WINDOW",
      DEFAULTS.logSampleMaxPerWindow,
      1,
    ),
    // A window of 1ms is legal but pointless; 1s is the smallest useful unit.
    logSampleWindowMs: c.int("LOG_SAMPLE_WINDOW_MS", DEFAULTS.logSampleWindowMs, 1_000),
    logBufferLines: c.int("LOG_BUFFER_LINES", DEFAULTS.logBufferLines, 0),
    telegramWebhookUrl: c.optionalUrl("TELEGRAM_WEBHOOK_URL"),
    telegramApiRoot: c.loopbackApiRoot("TELEGRAM_API_ROOT"),
    mimirAppUrl: c.optionalHttpsUrl("MIMIR_APP_URL"),
  };

  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/** Display label for the active Stellar network. */
export function networkLabel(config: StellarConfig): string {
  // A named STELLAR_NETWORK is reported by the name the operator chose.
  if (config.network !== undefined && config.network !== "custom") return config.network;
  const net = inferNetwork(config.networkPassphrase);
  if (net === "custom") {
    if (config.networkPassphrase === MOCK_NETWORK_PASSPHRASE) return "mock";
    return "custom";
  }
  // Inferred from the passphrase alone: Stellar's own name for its main
  // network is "public" (the passphrase itself, stellar.expert).
  return net === "mainnet" ? "public" : net;
}

/** Derive a StellarNetwork from a passphrase when the field is absent (backward compat). */
function inferNetwork(passphrase: string): StellarNetwork {
  if (passphrase === NETWORK_PASSPHRASES.mainnet) return "mainnet";
  if (passphrase === NETWORK_PASSPHRASES.testnet) return "testnet";
  if (passphrase === NETWORK_PASSPHRASES.futurenet) return "futurenet";
  return "custom";
}

/* ── Configuration provenance ────────────────────────────────────────────────
 *
 * "The bot is configured" and "the bot is configured the way I think it is" are
 * different claims. A placeholder token inherited from a profile, a `.env` the
 * process never found because it was started from another directory, or a
 * variable someone exported empty all look identical from the outside. These
 * reports answer *where a value came from* — never *what it is* — so a boot log
 * or a `/health` response can be pasted into a ticket or a chat safely.
 */

/** Where the value in effect for a setting came from. */
export type ConfigSource =
  | "process-env"
  | "env-file"
  | "profile-default"
  | "built-in-default"
  | "derived"
  | "unset";

/** One setting's origin. Deliberately value-free, including for secrets. */
export interface ConfigKeyProvenance {
  /** The variable name, e.g. `BOT_TOKEN`. A name is not a value. */
  key: string;
  source: ConfigSource;
  /** True when the value must never be printed, logged, or sent anywhere. */
  secret: boolean;
  /** The setting this one inherited from when `source` is `derived`. */
  derivedFrom?: string;
  /**
   * The variable is set (by the file or the shell) but empty, so a fallback
   * won. Usually a typo, and the reason a deployed value looks "ignored".
   */
  emptyDeclaration?: boolean;
}

/** Where the whole configuration came from. Safe to log and to serve. */
export interface ConfigProvenance {
  /** Active `MIMIR_PROFILE`, or null when unset. */
  profile: string | null;
  envFile: {
    present: boolean;
    /** Known settings whose effective value the file supplied. */
    suppliedKeys: number;
  };
  /** Every setting this module reads, in a stable order. */
  entries: ConfigKeyProvenance[];
  /** How many settings each source supplied. */
  counts: Record<ConfigSource, number>;
  /** Actionable, value-free notes for boot logs and health checks. */
  warnings: string[];
}

interface ConfigKeySpec {
  key: string;
  /** The value must never reach a log line, a health response, or an error. */
  secret: boolean;
  /** `DEFAULTS` supplies a value when nothing else does. */
  hasBuiltInDefault?: boolean;
  /** Another setting supplies this one's value while it is unset. */
  derivedFrom?: { key: string; applies?: (value: string) => boolean };
}

/**
 * Every variable `loadConfig` / `loadStellarConfig` reads, and nothing else: a
 * report that lists keys the process never reads would be noise, and one that
 * omits a key it does read would be a lie.
 */
const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: "MIMIR_PROFILE", secret: false },
  { key: "MARKET_CONTRACT_ID", secret: false },
  { key: "SQUAD_CONTRACT_ID", secret: false },
  { key: "STELLAR_RPC_URL", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_HORIZON_URL", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_NETWORK_PASSPHRASE", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_EXPLORER_BASE_URL", secret: false, hasBuiltInDefault: true },
  // Credentials and destinations: identifiers for a Telegram account, so they
  // are treated as secrets here even though a contract id is public.
  { key: "BOT_TOKEN", secret: true },
  { key: "TELEGRAM_CHAT_ID", secret: true },
  { key: "TELEGRAM_MARKET_CHAT_ID", secret: true, derivedFrom: { key: "TELEGRAM_CHAT_ID" } },
  { key: "TELEGRAM_SQUAD_CHAT_ID", secret: true, derivedFrom: { key: "TELEGRAM_CHAT_ID" } },
  { key: "ALLOWED_CHAT_IDS", secret: true },
  { key: "OPERATOR_TELEGRAM_USER_ID", secret: true },
  { key: "POLL_INTERVAL_MS", secret: false, hasBuiltInDefault: true },
  { key: "START_LOOKBACK_LEDGERS", secret: false, hasBuiltInDefault: true },
  { key: "CURSOR_FILE", secret: false, hasBuiltInDefault: true },
  { key: "INSTANCE_LOCK_FILE", secret: false, hasBuiltInDefault: true },
  { key: "STATUS_FILE", secret: false, hasBuiltInDefault: true },
  { key: "MAX_NOTIFICATIONS_PER_CYCLE", secret: false, hasBuiltInDefault: true },
  { key: "AUDIT_FILE", secret: false, hasBuiltInDefault: true },
  { key: "SEND_JOURNAL_FILE", secret: false, hasBuiltInDefault: true },
  { key: "EVENT_DEDUP_WINDOW", secret: false, hasBuiltInDefault: true },
  { key: "HEALTH_HOST", secret: false, hasBuiltInDefault: true },
  {
    key: "HEALTH_PORT",
    secret: false,
    hasBuiltInDefault: true,
    // Matches `defaultHealthPort()`: a usable platform PORT wins, and only a
    // non-positive or non-integer one falls through to the built-in 8787.
    derivedFrom: {
      key: "PORT",
      applies: (value) => {
        const port = Number(value);
        return Number.isInteger(port) && port > 0;
      },
    },
  },
  { key: "HEALTH_STALE_MS", secret: false, hasBuiltInDefault: true },
  { key: "SHUTDOWN_TIMEOUT_MS", secret: false, hasBuiltInDefault: true },
  { key: "TELEGRAM_SEND_TIMEOUT_MS", secret: false, hasBuiltInDefault: true },
  { key: "CHANNEL_PREVIEW_MODE", secret: false, hasBuiltInDefault: true },
  { key: "LINK_PREVIEW_MARKET", secret: false, hasBuiltInDefault: true },
  { key: "LINK_PREVIEW_SQUAD", secret: false, hasBuiltInDefault: true },
  { key: "TELEGRAM_API_ROOT", secret: false },
  { key: "MIMIR_APP_URL", secret: false },
  // Injected by a platform, never set by an operator: read only as the
  // HEALTH_PORT fallback, so it is reported for the same reason.
  { key: "PORT", secret: false },
];

/** Report order for counts, so two runs of the same config read identically. */
const SOURCE_ORDER: readonly ConfigSource[] = [
  "process-env",
  "env-file",
  "profile-default",
  "built-in-default",
  "derived",
  "unset",
];

function classifyKey(
  spec: ConfigKeySpec,
  profileDefaults: Record<string, string>,
): ConfigKeyProvenance {
  /** What a setting resolves to, wherever it comes from. */
  const resolved = (key: string): string | undefined => read(key) ?? profileDefaults[key];

  if (read(spec.key) !== undefined) {
    // A value won. Which side supplied it is the whole question: the file
    // writes into process.env, so only the captured `supplied` set can tell.
    return {
      key: spec.key,
      source: ENV_FILE.supplied.has(spec.key) ? "env-file" : "process-env",
      secret: spec.secret,
    };
  }

  const entry: ConfigKeyProvenance = { key: spec.key, source: "unset", secret: spec.secret };
  // Set but blank: declared by the file, or exported empty by the shell. Marking
  // it is what turns "why is my value ignored" into a one-line answer.
  if (process.env[spec.key] !== undefined || ENV_FILE.declared.has(spec.key)) {
    entry.emptyDeclaration = true;
  }

  if (profileDefaults[spec.key] !== undefined) {
    entry.source = "profile-default";
    return entry;
  }

  const derived = spec.derivedFrom;
  if (derived !== undefined) {
    const source = resolved(derived.key);
    if (source !== undefined && (derived.applies?.(source) ?? true)) {
      entry.source = "derived";
      entry.derivedFrom = derived.key;
      return entry;
    }
  }

  if (spec.hasBuiltInDefault === true) entry.source = "built-in-default";
  return entry;
}

function describeSource(entry: ConfigKeyProvenance): string {
  switch (entry.source) {
    case "process-env":
      return "the environment";
    case "env-file":
      return "the .env file";
    case "profile-default":
      return "the active profile";
    case "built-in-default":
      return "the built-in default";
    case "derived":
      return `${entry.derivedFrom} (inherited)`;
    default:
      return "nothing";
  }
}

/**
 * Where every known setting's value came from: names and origins only, never a
 * value — not even for a setting that is not a secret. Cheap and side-effect
 * free, so boot logging and `/health` can both call it.
 */
export function configProvenance(): ConfigProvenance {
  const profile = activeProfileName();
  const warnings: string[] = [];

  let profileDefaults: Record<string, string> = {};
  try {
    profileDefaults = resolveProfileDefaults();
  } catch {
    // An unknown profile fails boot, but a running process asking for a health
    // report must still get one instead of an exception.
    warnings.push(
      `MIMIR_PROFILE=${profile ?? "(unset)"} is not a known profile; no profile defaults apply`,
    );
  }

  const entries = CONFIG_KEYS.map((spec) => classifyKey(spec, profileDefaults));

  const counts = Object.fromEntries(SOURCE_ORDER.map((source) => [source, 0])) as Record<
    ConfigSource,
    number
  >;
  for (const entry of entries) counts[entry.source] += 1;

  const suppliedKeys = entries.filter((entry) => entry.source === "env-file").length;
  if (ENV_FILE.present && suppliedKeys === 0) {
    // The classic deployment bug: the file exists, the process starts somewhere
    // else, and every value silently comes from defaults.
    warnings.push(
      ".env was read but supplies none of these settings — check the working directory",
    );
  }

  for (const entry of entries) {
    if (entry.emptyDeclaration === true) {
      warnings.push(
        `${entry.key} is set but empty; ${describeSource(entry)} supplies the value`,
      );
    }
  }

  if (profile === MOCK_PROFILE_NAME) {
    const fromProfile = counts["profile-default"];
    warnings.push(
      `MIMIR_PROFILE=${MOCK_PROFILE_NAME}: ${fromProfile} setting(s) come from the mock profile`,
    );
  }

  return {
    profile,
    envFile: { present: ENV_FILE.present, suppliedKeys },
    entries,
    counts,
    warnings,
  };
}

/**
 * One value-free line for boot logs: the profile, whether the `.env` file was
 * read at all, and how many settings each source supplied.
 */
export function formatProvenanceSummary(provenance: ConfigProvenance): string {
  const counts = SOURCE_ORDER.filter((source) => provenance.counts[source] > 0).map(
    (source) => `${source}=${provenance.counts[source]}`,
  );
  const secrets = provenance.entries.filter((entry) => entry.secret).length;
  const file = provenance.envFile.present
    ? `present(${provenance.envFile.suppliedKeys} keys)`
    : "absent";
  // `secret-keys=6/26` is a property of the report, not of the values: it says
  // six of the settings named here are sensitive and are still reported as
  // origins only. No character in this line is MarkdownV2-reserved, which is
  // what lets `/status` put it in a code span unescaped.
  return (
    `profile=${provenance.profile ?? "none"} env-file=${file} ${counts.join(" ")} ` +
    `secret-keys=${secrets}/${provenance.entries.length}`
  );
}

/**
 * Generates a deterministic SBOM-friendly hash of the current configuration.
 *
 * This function creates a SHA-256 hash of the non-sensitive configuration
 * values. It is used to generate Software Bill of Materials (SBOM) metadata
 * for the bot image, ensuring the read-only Mimir notifier remains reliable,
 * understandable, and safe during long-running Stellar and Telegram failures.
 *
 * Sensitive fields (botToken, chatId) are excluded to prevent leakage.
 *
 * @param config - The loaded BotConfig instance.
 * @returns A hex-encoded SHA-256 hash string representing the configuration state.
 */
export function generateConfigHash(config: BotConfig): string {
  const safeConfig = {
    marketContractId: config.marketContractId,
    squadContractId: config.squadContractId,
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
    networkPassphrase: config.networkPassphrase,
    pollIntervalMs: config.pollIntervalMs,
    startLookbackLedgers: config.startLookbackLedgers,
    cursorFile: config.cursorFile,
    maxNotificationsPerCycle: config.maxNotificationsPerCycle,
  };

  const serialized = JSON.stringify(safeConfig, Object.keys(safeConfig).sort());
  return createHash("sha256").update(serialized).digest("hex");
}