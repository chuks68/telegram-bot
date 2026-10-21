/**
 * Challenger leaderboard computed from decoded Mimir contract settlement events.
 *
 * Aggregates `challenger_paid` events to rank challengers by net USDC winnings.
 * Ties are broken deterministically by challenger address.
 */

import type { DecodedEvent, MarketPayload } from "./decode.js";

export interface LeaderboardRow {
  challenger: string;
  address: string;
  stake: bigint;
  net: bigint;
  wins: number;
}

export type LeaderboardEntry = LeaderboardRow;

export interface BuildLeaderboardOptions {
  limit?: number;
}

/**
 * Compute a ranking of challengers by net winnings from settlement events.
 *
 * - Sums stake and net per challenger as bigint
 * - Counts number of winning settlements (wins)
 * - Ignores non-challenger_paid events
 * - Sorts descending by net winnings, breaking ties ascending by address
 * - Applies optional { limit } slice
 */
export function buildLeaderboard(
  events?: Iterable<DecodedEvent | { payload?: MarketPayload | any; [key: string]: any }> | readonly any[] | null,
  options?: BuildLeaderboardOptions,
): LeaderboardRow[] {
  if (!events) return [];

  const aggregates = new Map<string, { stake: bigint; net: bigint; wins: number }>();

  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    const payload = (event as any).payload ?? event;
    if (!payload || typeof payload !== "object" || payload.name !== "challenger_paid") {
      continue;
    }

    const challenger = typeof payload.challenger === "string" ? payload.challenger.trim() : "";
    if (!challenger) continue;

    const stake = BigInt(payload.stake ?? 0n);
    const net = BigInt(payload.net ?? 0n);

    const existing = aggregates.get(challenger);
    if (existing) {
      existing.stake += stake;
      existing.net += net;
      existing.wins += 1;
    } else {
      aggregates.set(challenger, {
        stake,
        net,
        wins: 1,
      });
    }
  }

  const rows: LeaderboardRow[] = Array.from(aggregates.entries()).map(([challenger, stats]) => ({
    challenger,
    address: challenger,
    stake: stats.stake,
    net: stats.net,
    wins: stats.wins,
  }));

  rows.sort((a, b) => {
    if (b.net > a.net) return 1;
    if (b.net < a.net) return -1;
    if (a.address < b.address) return -1;
    if (a.address > b.address) return 1;
    return 0;
  });

  if (options?.limit !== undefined && options.limit !== null) {
    const limit = Math.max(0, Math.floor(Number(options.limit)));
    return rows.slice(0, limit);
  }

  return rows;
}
