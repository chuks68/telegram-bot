/**
 * Estimate wall-clock time for a ledger number when the RPC omits a close time.
 */

export interface LedgerAnchor {
  ledger: number;
  closedAt: string | number | Date;
}

export interface LedgerTimeEstimate {
  iso: string;
  approximate: true;
}

export class InvalidLedgerError extends TypeError {
  readonly code = "ERR_INVALID_LEDGER";

  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerError";
  }
}

/**
 * Validate that a ledger sequence number is a non-negative integer.
 */
function validateLedger(ledger: unknown, label = "ledger"): number {
  if (typeof ledger !== "number" || !Number.isInteger(ledger) || ledger < 0) {
    throw new InvalidLedgerError(
      `Invalid ${label}: expected a non-negative integer, got ${ledger}`,
    );
  }
  return ledger;
}

/**
 * Estimate wall-clock time for a target ledger given a known anchor ledger.
 *
 * @param ledger Target ledger sequence number (non-negative integer)
 * @param anchor Known reference ledger and its close time
 * @param avgSeconds Average close time in seconds per ledger (default: 5)
 */
export function estimateLedgerTime(
  ledger: number,
  anchor: LedgerAnchor,
  avgSeconds: number = 5,
): LedgerTimeEstimate {
  validateLedger(ledger, "ledger");

  if (!anchor || typeof anchor !== "object") {
    throw new InvalidLedgerError("Invalid anchor: expected an object with ledger and closedAt");
  }

  validateLedger(anchor.ledger, "anchor.ledger");

  const anchorTimeMs =
    anchor.closedAt instanceof Date
      ? anchor.closedAt.getTime()
      : typeof anchor.closedAt === "number"
        ? (Number.isFinite(anchor.closedAt)
            ? (anchor.closedAt < 1e11 ? anchor.closedAt * 1000 : anchor.closedAt)
            : NaN)
        : typeof anchor.closedAt === "string"
          ? new Date(anchor.closedAt).getTime()
          : NaN;

  if (Number.isNaN(anchorTimeMs)) {
    throw new InvalidLedgerError(
      `Invalid anchor.closedAt: could not parse timestamp from ${anchor.closedAt}`,
    );
  }

  if (typeof avgSeconds !== "number" || !Number.isFinite(avgSeconds) || avgSeconds <= 0) {
    throw new InvalidLedgerError(
      `Invalid avgSeconds: expected a positive number, got ${avgSeconds}`,
    );
  }

  const deltaLedgers = ledger - anchor.ledger;
  const deltaMs = Math.round(deltaLedgers * avgSeconds * 1000);
  const estimatedTime = new Date(anchorTimeMs + deltaMs);

  return {
    iso: estimatedTime.toISOString(),
    approximate: true,
  };
}
