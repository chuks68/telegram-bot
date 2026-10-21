/**
 * Leaderboard notification message formatting.
 *
 * Formats a ranking of challengers by net winnings for Telegram in MarkdownV2.
 */

import { formatUsdc, shortAddress } from "../stellar/decode.js";
import { escapeMd } from "./format.js";
import type { LeaderboardRow } from "../stellar/leaderboard.js";

/**
 * Format a ranking of challengers into a MarkdownV2 Telegram message.
 *
 * Uses `shortAddress` for readable account identities and `formatUsdc` for
 * 7-decimal USDC amounts. All dynamic values are safely escaped with `escapeMd`.
 */
export function leaderboardMessage(
  rows?: readonly (LeaderboardRow | { challenger?: string; address?: string; stake?: bigint; net?: bigint; wins?: number })[] | null,
): string {
  if (!rows || rows.length === 0) {
    return "🏆 *Challenger Leaderboard*\n\nNo settlements recorded\\.";
  }

  const lines = rows.map((row, index) => {
    const address = row.address ?? row.challenger ?? "unknown";
    const shortAddr = escapeMd(shortAddress(address));
    const net = escapeMd(`${formatUsdc(BigInt(row.net ?? 0n))} USDC`);
    const stake = escapeMd(`${formatUsdc(BigInt(row.stake ?? 0n))} USDC`);
    const wins = Number(row.wins ?? 0);
    const winsLabel = `${wins} win${wins === 1 ? "" : "s"}`;
    return `${index + 1}\\. \`${shortAddr}\` — net *${net}* · ${escapeMd(winsLabel)} · staked ${stake}`;
  });

  return ["🏆 *Challenger Leaderboard*", "", ...lines].join("\n");
}
