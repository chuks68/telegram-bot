/**
 * Highlight markers and threshold evaluation for large stakes and deposits.
 *
 * Large stakes and deposits are the most interesting events for a channel
 * audience. This module classifies events into highlight levels ('none', 'large', 'huge')
 * and applies non-reserved marker strings to the first line of formatted notifications.
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** 1 USDC in atomic units (7 decimals on Stellar). */
export const USDC_UNIT = 10_000_000n;

/** Default threshold for a "large" stake / deposit (100 USDC). */
export const DEFAULT_LARGE_THRESHOLD = 100n * USDC_UNIT;

/** Default threshold for a "huge" stake / deposit (1,000 USDC). */
export const DEFAULT_HUGE_THRESHOLD = 1_000n * USDC_UNIT;

/** Telegram's MarkdownV2 reserved set. All marker strings must be free of these. */
export const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/;

/** Default highlight markers for large and huge levels. */
export const DEFAULT_MARKERS = {
  large: "🔥",
  huge: "🚨",
} as const;

export type HighlightLevel = "none" | "large" | "huge";

export interface HighlightMarkers {
  large?: string;
  huge?: string;
}

export interface HighlightThresholds {
  large?: bigint;
  huge?: bigint;
  markers?: HighlightMarkers;
}

export const DEFAULT_THRESHOLDS: HighlightThresholds = {
  large: DEFAULT_LARGE_THRESHOLD,
  huge: DEFAULT_HUGE_THRESHOLD,
  markers: DEFAULT_MARKERS,
};

/** Error thrown when a marker contains MarkdownV2 reserved characters. */
export class InvalidMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMarkerError";
  }
}

/**
 * Validates that a marker contains no MarkdownV2 reserved characters.
 */
export function validateMarker(marker: string): void {
  if (MDV2_RESERVED.test(marker)) {
    throw new InvalidMarkerError(
      `Marker "${marker}" contains MarkdownV2 reserved characters`,
    );
  }
}

/**
 * Extract stake or deposit amount from relevant events.
 * Only `claim_challenged` (market) and `deposited` (squad) represent stakes/deposits.
 */
function extractAmount(event: unknown): bigint | null {
  if (!event || typeof event !== "object") return null;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;

  const p = payload as { name?: unknown; stake?: unknown; amount?: unknown };
  if (p.name === "claim_challenged") {
    if (typeof p.stake === "bigint") return p.stake;
    if (typeof p.stake === "number" && Number.isFinite(p.stake)) {
      try {
        return BigInt(p.stake);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (p.name === "deposited") {
    if (typeof p.amount === "bigint") return p.amount;
    if (typeof p.amount === "number" && Number.isFinite(p.amount)) {
      try {
        return BigInt(p.amount);
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

/**
 * Determine the highlight level for an event based on configured or default thresholds.
 *
 * Returns 'none', 'large' or 'huge'.
 * Events other than `claim_challenged` and `deposited` always return 'none'.
 */
export function highlightLevel(
  event: DecodedEvent | unknown,
  thresholds?: HighlightThresholds,
): HighlightLevel {
  const amount = extractAmount(event);
  if (amount === null || amount <= 0n) return "none";

  const large = thresholds?.large ?? DEFAULT_LARGE_THRESHOLD;
  const huge = thresholds?.huge ?? DEFAULT_HUGE_THRESHOLD;

  if (huge >= large) {
    if (huge > 0n && amount >= huge) return "huge";
    if (large > 0n && amount >= large) return "large";
  } else {
    if (large > 0n && amount >= large) return "large";
    if (huge > 0n && amount >= huge) return "huge";
  }
  return "none";
}

/**
 * Get the marker string for a given highlight level, validating safety against MarkdownV2 reserved characters.
 */
export function highlightMarker(
  level: HighlightLevel,
  thresholds?: HighlightThresholds,
): string {
  if (level === "none") return "";

  const customMarker =
    level === "large" ? thresholds?.markers?.large : thresholds?.markers?.huge;
  const marker = customMarker ?? DEFAULT_MARKERS[level];

  validateMarker(marker);
  return marker;
}

/**
 * Prefix the first line of a message with a highlight marker.
 */
export function prefixFirstLine(text: string, marker: string): string {
  if (!marker || text.length === 0) return text;
  const formattedMarker = marker.endsWith(" ") ? marker : `${marker} `;
  return `${formattedMarker}${text}`;
}
