/**
 * Active notification filters message builder.
 *
 * Formats the active notification filters for the bot:
 * - Enabled / disabled event types (derived from feature flags and contract sources)
 * - Claim category allowlists (from config.notificationCategories)
 * - Chat routing destinations (safely redacted with redactChatId)
 *
 * All dynamic values are escaped with escapeMd.
 */

import { escapeMd } from "../notifications/format.js";
import { redactChatId } from "../status.js";
import type { BotConfig } from "../config.js";
import type { NotificationFeatureFlags } from "../notifications/featureFlags.js";
import { DEFAULT_FEATURE_FLAGS } from "../notifications/featureFlags.js";

/** Event types supported by mimir-market. */
export const MARKET_EVENT_TYPES = [
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
] as const;

/** Event types supported by mimir-squad. */
export const SQUAD_EVENT_TYPES = [
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
] as const;

/** Minimal configuration shape required by filtersMessage. */
export type FiltersConfig = Partial<
  Pick<
    BotConfig,
    | "featureFlags"
    | "notificationCategories"
    | "chatId"
    | "chatIds"
    | "marketChatId"
    | "squadChatId"
  >
>;

/**
 * Builds a MarkdownV2 formatted message describing the active notification filters.
 *
 * Under default configuration, renders an "all notifications enabled" line.
 * When filters or gates are active, lists:
 * - Enabled/disabled event types
 * - Category allowlists
 * - Chat routing destinations (redacted)
 */
export function filtersMessage(config: FiltersConfig = {}): string {
  const flags: NotificationFeatureFlags =
    config.featureFlags ?? DEFAULT_FEATURE_FLAGS;
  const categories = config.notificationCategories ?? [];

  const isDefault =
    flags.enabled &&
    flags.market &&
    flags.squad &&
    categories.length === 0;

  const defaultChat = config.chatId ?? config.chatIds?.[0];
  const marketChat = config.marketChatId || defaultChat;
  const squadChat = config.squadChatId || defaultChat;

  const lines: string[] = [
    "*Active Notification Filters*",
    "",
  ];

  if (isDefault) {
    lines.push("All notifications are enabled\\.");
    lines.push("");
  }

  // Feature Flags / Status
  lines.push("*Feature Flags*");
  lines.push(`· Master switch: ${flags.enabled ? "enabled" : "disabled"}`);
  lines.push(`· mimir\\-market: ${flags.market ? "enabled" : "disabled"}`);
  lines.push(`· mimir\\-squad: ${flags.squad ? "enabled" : "disabled"}`);
  lines.push("");

  // Event Types
  const enabledEvents: string[] = [];
  const disabledEvents: string[] = [];

  for (const name of MARKET_EVENT_TYPES) {
    if (flags.enabled && flags.market) {
      enabledEvents.push(name);
    } else {
      disabledEvents.push(name);
    }
  }

  for (const name of SQUAD_EVENT_TYPES) {
    if (flags.enabled && flags.squad) {
      enabledEvents.push(name);
    } else {
      disabledEvents.push(name);
    }
  }

  lines.push("*Event Types*");
  if (enabledEvents.length > 0) {
    lines.push(
      `· Enabled \\(${enabledEvents.length}\\): ${enabledEvents.map((e) => `\`${escapeMd(e)}\``).join(", ")}`,
    );
  } else {
    lines.push("· Enabled: none");
  }

  if (disabledEvents.length > 0) {
    lines.push(
      `· Disabled \\(${disabledEvents.length}\\): ${disabledEvents.map((e) => `\`${escapeMd(e)}\``).join(", ")}`,
    );
  } else {
    lines.push("· Disabled: none");
  }
  lines.push("");

  // Category Allowlists
  lines.push("*Category Allowlist*");
  if (categories.length > 0) {
    lines.push(
      `· Categories: ${categories.map((c) => `\`${escapeMd(c)}\``).join(", ")}`,
    );
    lines.push("· Note: category filter applies only to `claim\\_created` events");
  } else {
    lines.push("· Categories: all allowed \\(no filter\\)");
  }
  lines.push("");

  // Chat Routing
  lines.push("*Chat Routing*");
  lines.push(`· Default chat: \`${escapeMd(redactChatId(defaultChat))}\``);
  if (config.marketChatId && config.marketChatId !== defaultChat) {
    lines.push(`· mimir\\-market chat: \`${escapeMd(redactChatId(marketChat))}\``);
  }
  if (config.squadChatId && config.squadChatId !== defaultChat) {
    lines.push(`· mimir\\-squad chat: \`${escapeMd(redactChatId(squadChat))}\``);
  }

  return lines.join("\n");
}
