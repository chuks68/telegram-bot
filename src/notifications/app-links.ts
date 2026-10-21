/**
 * Deep links from a notification to the Mimir web app.
 *
 * The explorer button answers "what happened on-chain"; this button answers
 * "where do I act on it". A claim event links to the claim page, a squad
 * market event to the market page, and anything without a page — fees,
 * withdrawals, admin records, undecodable payloads — returns null so it earns
 * no button rather than a link to the wrong place.
 *
 * `baseUrl` is `MIMIR_APP_URL`, validated as an https origin when the config
 * is loaded. It is checked again here so a hand-built config object cannot
 * point the button at a non-https or unparseable origin.
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** Route under the app for each event family. */
type AppRoute = "claims" | "squads";

/** The page an event points at: a route plus its encoded-ready id. */
export interface AppTarget {
  route: AppRoute;
  id: string;
}

/**
 * Longest id accepted from a payload before the event is treated as having no
 * page. Ids are contract integers; the cap only keeps a hand-crafted string
 * payload from growing an unbounded URL.
 */
const MAX_ID_LENGTH = 64;

/** Normalise a payload id into a path segment, or null when unusable. */
function segmentId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
  }
  return null;
}

/**
 * The app page for an event, or null when the event has none.
 *
 * Grouped `case` labels keep the mapping next to the payload names the
 * notification templates use, so a new claim-shaped event is added in two
 * places at once instead of drifting apart.
 */
export function appTargetFor(event: DecodedEvent): AppTarget | null {
  const payload = event?.payload;
  if (!payload) return null;

  let id: string | null = null;
  switch (payload.name) {
    // mimir-market: events that carry the claim's id.
    case "claim_created":
    case "claim_challenged":
    case "claim_resolved":
    case "claim_cancelled":
    case "market_settled":
    case "challenger_paid":
      id = segmentId(payload.claimId);
      return id === null ? null : { route: "claims", id };

    // mimir-squad: events that carry the market's id.
    case "market_created":
    case "deposited":
    case "withdrawn":
    case "resolved":
    case "claimed":
      id = segmentId(payload.marketId);
      return id === null ? null : { route: "squads", id };

    // Contract-level money movements, admin records and unknown payloads have
    // no page of their own.
    default:
      return null;
  }
}

/**
 * The Mimir web-app URL for an event, or null when there is nothing to open.
 *
 * Trailing slashes on the base are collapsed so `https://app.example/` and
 * `https://app.example` produce the same link, and the id goes through
 * `encodeURIComponent` so an unexpected payload value cannot inject a query,
 * fragment or extra path segment.
 */
export function appUrlFor(
  event: DecodedEvent,
  baseUrl: string | null | undefined,
): string | null {
  if (!baseUrl) return null;
  const target = appTargetFor(event);
  if (target === null) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;

  base.search = "";
  base.hash = "";
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/${target.route}/${encodeURIComponent(target.id)}`;
  return base.toString();
}
