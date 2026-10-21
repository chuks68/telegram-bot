/**
 * JSON reviver for scanner output.
 *
 * Restores bigint fields from string representations after JSON.parse.
 * This is the inverse of scanJsonReplacer in events.ts.
 */

import type { ScanJsonReport, ScanJsonEvent, ScanJsonTarget } from "./events.js";

/** Known bigint field paths per event name. */
const BIGINT_FIELDS: Record<string, readonly string[]> = {
  // Market events
  claim_challenged: ["stake"],
  market_settled: ["totalPaid", "totalFees", "owedToChallengers", "dust"],
  challenger_paid: ["stake", "gross", "fee", "net"],
  fee_claimed: ["amount"],
  withdrawal: ["amount"],
  withdrawal_pending: ["amount"],

  // Squad events
  deposited: ["amount", "shares"],
  withdrawn: ["amount"],
  resolved: ["poolA", "poolB"],
  claimed: ["gross", "fee", "net"],
  fees_claimed: ["amount"],

  // Admin events
  fee_accrued: ["amount"],
};

/** Error type for unknown or incompatible scan report formats. */
export class ScanReviverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanReviverError";
  }
}

/**
 * Parse a decimal string into a bigint. Returns undefined for non-numeric strings.
 */
function parseBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Recursively revive bigint fields in an object based on its event name.
 */
function revivePayload(payload: ScanJsonEvent["payload"]): ScanJsonEvent["payload"] {
  if (!payload || typeof payload !== "object") return payload;

  const name = (payload as { name?: string }).name;
  if (!name || typeof name !== "string") return payload;

  const fields = BIGINT_FIELDS[name];
  if (!fields) {
    // Unknown event: leave all fields as-is (they're already strings from JSON)
    return payload;
  }

  const revived = { ...payload };
  for (const field of fields) {
    const value = (revived as Record<string, unknown>)[field];
    const bigintValue = parseBigInt(value);
    if (bigintValue !== undefined) {
      (revived as Record<string, unknown>)[field] = bigintValue;
    }
  }

  return revived;
}

/**
 * Revive bigint fields in a single ScanJsonEvent.
 */
function reviveEvent(event: ScanJsonEvent): ScanJsonEvent {
  return {
    ...event,
    payload: revivePayload(event.payload),
  };
}

/**
 * Revive bigint fields in a ScanJsonTarget.
 */
function reviveTarget(target: ScanJsonTarget): ScanJsonTarget {
  return {
    ...target,
    events: target.events.map(reviveEvent),
  };
}

/**
 * Parse and revive a scan report from JSON, restoring bigint fields.
 *
 * @param json - The JSON string to parse
 * @returns The revived ScanJsonReport
 * @throws ScanReviverError if the format is unknown or incompatible
 */
export function reviveScanReport(json: string): ScanJsonReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ScanReviverError(
      `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ScanReviverError("JSON is not an object");
  }

  const report = parsed as Partial<ScanJsonReport>;

  // Validate format version
  if (report.format !== "mimir-scan-v1") {
    throw new ScanReviverError(
      `unknown format: expected "mimir-scan-v1", got "${report.format ?? "undefined"}"`,
    );
  }

  // Validate required fields
  if (!report.network || typeof report.network !== "string") {
    throw new ScanReviverError("missing or invalid 'network' field");
  }
  if (!report.rpcUrl || typeof report.rpcUrl !== "string") {
    throw new ScanReviverError("missing or invalid 'rpcUrl' field");
  }
  if (!report.ledgers || typeof report.ledgers !== "object") {
    throw new ScanReviverError("missing or invalid 'ledgers' field");
  }
  if (!Array.isArray(report.targets)) {
    throw new ScanReviverError("missing or invalid 'targets' field");
  }

  // Revive bigint fields in each target
  const revivedTargets = report.targets.map(reviveTarget);

  return {
    format: "mimir-scan-v1",
    network: report.network,
    rpcUrl: report.rpcUrl,
    ledgers: report.ledgers,
    rpcTiming: report.rpcTiming,
    targets: revivedTargets,
  };
}
