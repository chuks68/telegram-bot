/**
 * Startup announcement message builder.
 *
 * Produces an optional MarkdownV2 message that tells a chat the notifier has
 * come online, what it watches, which network it is on, and where each target
 * resumes. Designed to be sent once at boot; whether to send it is left to the
 * caller (src/index.ts opt-in).
 *
 * Safety constraints:
 *  - All interpolated strings go through escapeMd.
 *  - No bot tokens, chat ids, operator ids, or cursor file paths are included.
 *  - The contract ids are public on-chain identifiers — safe to publish.
 *  - The message is bounded to Telegram's 4096-character limit: contract ids
 *    are truncated via shortAddress, and the resumeLedgers list is bounded to
 *    the number of watched targets (always two in the current deployment).
 */

import { networkLabel, type BotConfig } from "../config.js";
import { escapeMd } from "./format.js";
import { shortAddress } from "../stellar/decode.js";

/** Resume position for one watched contract target. */
export interface TargetResume {
  /** Contract source label, e.g. `"market"` or `"squad"`. */
  source: string;
  /**
   * Ledger the poller will resume from, or `null` on a cold start (no cursor
   * file found or cursor was absent/unparseable).
   */
  ledger: number | null;
}

export interface StartupMessageOptions {
  /**
   * The fields actually read by startupMessage. Typed as the minimal subset
   * so tests can pass a plain object without constructing a full BotConfig.
   * In production, pass the full BotConfig.
   */
  config: Pick<BotConfig,
    | "network"
    | "networkPassphrase"
    | "marketContractId"
    | "squadContractId"
    | "marketContractVersion"
    | "squadContractVersion"
    | "pollIntervalMs"
    | "telegramWebhookUrl"
    // Required by StellarConfig (and therefore by networkLabel) but not read
    // directly in startupMessage — included so the Pick satisfies StellarConfig.
    | "rpcUrl"
    | "horizonUrl"
    | "explorerBaseUrl"
  >;
  /** Semver string, e.g. `"0.1.0"`. Falls back to `"unknown"`. */
  version?: string;
  /**
   * Resume ledger per watched target. An absent entry or a `null` ledger means
   * the target is doing a cold start. Pass an empty array to indicate that all
   * targets are starting cold (equivalent to all entries having `ledger: null`).
   */
  resumeLedgers?: TargetResume[];
}

/**
 * Build a MarkdownV2 startup announcement message.
 *
 * The message fits in a single Telegram `sendMessage` call (well under 4096
 * chars). It never includes secrets, chat ids, or operator ids.
 */
export function startupMessage(opts: StartupMessageOptions): string {
  const { config, version = "unknown", resumeLedgers = [] } = opts;

  const network = networkLabel(config);
  const mode = config.telegramWebhookUrl !== null ? "webhook" : "long\\-polling";
  const interval = Math.round(config.pollIntervalMs / 1000);

  // Build a lookup map from source name → ledger for the resume lines.
  const resumeMap = new Map<string, number | null>(
    resumeLedgers.map((r) => [r.source, r.ledger]),
  );

  const targets: Array<{ source: string; contractId: string; version: string }> = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: config.marketContractVersion,
    },
    {
      source: "squad",
      contractId: config.squadContractId,
      version: config.squadContractVersion,
    },
  ];

  const lines: string[] = [
    `*Mimir notifier online* — Stellar ${escapeMd(network)}`,
    `Version: ${escapeMd(version)} · mode: ${mode} · poll: ${escapeMd(String(interval))}s`,
    ``,
    `*Watching*`,
  ];

  for (const target of targets) {
    const resumeLedger = resumeMap.has(target.source)
      ? resumeMap.get(target.source) ?? null
      : null;

    const resumeLabel =
      resumeLedger === null
        ? "cold start"
        : `resuming from ledger ${escapeMd(String(resumeLedger))}`;

    lines.push(
      `· mimir\\-${escapeMd(target.source)} \\(${escapeMd(target.version)}\\)`,
      `  \`${escapeMd(shortAddress(target.contractId))}\` — ${resumeLabel}`,
    );
  }

  return lines.join("\n");
}
