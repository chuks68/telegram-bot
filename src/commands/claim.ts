/**
 * Format the lifecycle timeline of a market claim from observed events.
 */

import { escapeMd, clip } from "../notifications/format.js";
import {
  formatUsdc,
  shortAddress,
  winnerSideLabel,
  sortEvents,
  type DecodedEvent,
} from "../stellar/decode.js";
import { txExplorerUrl } from "../stellar/client.js";
import type { StellarConfig } from "../config.js";

/** Usage instructions when an invalid claim argument is provided. */
export const CLAIM_USAGE_MESSAGE =
  "*Usage:* `/claim <claim_id>`\nPlease provide a non\\-negative integer claim ID\\.";

/** Message when no events for the requested claim ID have been observed recently. */
export function claimNotSeenMessage(claimId: number): string {
  return `Claim \\#${escapeMd(String(claimId))} not seen recently\\.`;
}

/**
 * Validate and parse a claim ID argument from raw text or command input.
 * Accepts a non-negative integer, e.g. "42", "0", or "/claim 42".
 * Returns the parsed integer claim ID, or null if invalid.
 */
export function parseClaimArg(text?: string | null): number | null {
  if (typeof text !== "string") return null;
  let trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex === -1) return null;
    trimmed = trimmed.slice(spaceIndex).trim();
  }
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id < 0) {
    return null;
  }
  return id;
}

/**
 * Format a one-line summary for a market event relating to a claim.
 */
function eventSummary(event: DecodedEvent): string {
  const p = event.payload;
  switch (p.name) {
    case "claim_created": {
      const cat = escapeMd(clip(p.category));
      const creator = escapeMd(shortAddress(p.creator));
      return `Created: ${cat} by ${creator}`;
    }
    case "claim_challenged": {
      const stake = escapeMd(formatUsdc(p.stake));
      const challenger = escapeMd(shortAddress(p.challenger));
      return `Challenged: ${stake} USDC by ${challenger}`;
    }
    case "claim_resolved": {
      const winner = escapeMd(winnerSideLabel(p.winnerSide));
      const conf = escapeMd(String(p.confidence));
      const base = `Resolved: winner ${winner} (${conf}% confidence)`;
      if (p.summary) {
        const cleanSummary = p.summary.replace(/[\r\n]+/g, " ").trim();
        if (cleanSummary) {
          return `${base} — _${escapeMd(clip(cleanSummary))}_`;
        }
      }
      return base;
    }
    case "claim_cancelled": {
      return "Cancelled — stakes returned";
    }
    case "market_settled": {
      const paid = escapeMd(formatUsdc(p.totalPaid));
      const fees = escapeMd(formatUsdc(p.totalFees));
      return `Settled: paid ${paid} USDC (fees ${fees} USDC)`;
    }
    case "challenger_paid": {
      const challenger = escapeMd(shortAddress(p.challenger));
      const net = escapeMd(formatUsdc(p.net));
      return `Challenger paid: ${challenger} net ${net} USDC`;
    }
    default: {
      const name = "name" in p ? String(p.name) : "unknown";
      return escapeMd(name.replace(/_/g, " "));
    }
  }
}

/**
 * Generate a MarkdownV2 timeline reply for a specific claim from observed events.
 */
export function claimTimelineMessage(
  claimId: unknown,
  events: readonly DecodedEvent[],
  config: StellarConfig,
): string {
  let resolvedClaimId: number | null = null;
  if (typeof claimId === "number") {
    resolvedClaimId = Number.isInteger(claimId) && claimId >= 0 ? claimId : null;
  } else if (typeof claimId === "string") {
    resolvedClaimId = parseClaimArg(claimId);
  }

  if (resolvedClaimId === null) {
    return CLAIM_USAGE_MESSAGE;
  }

  const matching = (events ?? []).filter(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      e.payload &&
      typeof e.payload === "object" &&
      "claimId" in e.payload &&
      (e.payload as { claimId?: number }).claimId === resolvedClaimId,
  );

  if (matching.length === 0) {
    return claimNotSeenMessage(resolvedClaimId);
  }

  const sorted = sortEvents(matching);

  const lines = sorted.map((event) => {
    const url = config && event.txHash ? txExplorerUrl(config, event.txHash) : "";
    const txPart = url ? ` · [tx](${url})` : "";
    const summary = eventSummary(event);
    return `· ledger ${event.ledger}${txPart} — ${summary}`;
  });

  return [`*Claim \\#${escapeMd(String(resolvedClaimId))}*`, "", ...lines].join("\n");
}
