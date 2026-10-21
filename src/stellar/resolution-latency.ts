import type { DecodedEvent } from "./decode.js";

export interface LatencyDuration {
  seconds: number;
  ledgers: number;
}

export interface ClaimLatency {
  claimId: number;
  creationLedger: number;
  creationAt: number;
  resolutionLedger: number;
  resolutionAt: number;
  duration: LatencyDuration;
}

export interface LatencySummary {
  p50: LatencyDuration;
  p90: LatencyDuration;
  max: LatencyDuration;
}

export interface LatencyGroup {
  claims: ClaimLatency[];
  summary: LatencySummary | null;
}

export interface ResolutionLatencyReport {
  resolved: LatencyGroup;
  cancelled: LatencyGroup;
  excludedCount: number;
}

/**
 * Calculates the p-th percentile (0 <= p <= 100) using nearest-rank integer indexing.
 * For a sorted non-empty array of length N, rank = Math.ceil((p / 100) * N) -> index = rank - 1.
 * For p=0, returns values[0].
 */
function nearestRank(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index]!;
}

function computeSummary(claims: ClaimLatency[]): LatencySummary | null {
  if (claims.length === 0) {
    return null;
  }

  const sortedSec = claims.map((c) => c.duration.seconds).sort((a, b) => a - b);
  const sortedLed = claims.map((c) => c.duration.ledgers).sort((a, b) => a - b);

  return {
    p50: {
      seconds: nearestRank(sortedSec, 50),
      ledgers: nearestRank(sortedLed, 50),
    },
    p90: {
      seconds: nearestRank(sortedSec, 90),
      ledgers: nearestRank(sortedLed, 90),
    },
    max: {
      seconds: sortedSec[sortedSec.length - 1]!,
      ledgers: sortedLed[sortedLed.length - 1]!,
    },
  };
}

/**
 * Computes durations from creation to resolution/cancellation per claim.
 *
 * Excludes claims missing either creation or resolution/cancellation event.
 * If multiple creation or resolution events exist for the same claimId, deterministic
 * earliest creation and earliest resolution/cancellation are used.
 *
 * Uses integer math only.
 */
export function resolutionLatency(events: readonly DecodedEvent[]): ResolutionLatencyReport {
  const creations = new Map<number, { at: number; ledger: number }>();
  const resolutions = new Map<number, { at: number; ledger: number }>();
  const cancellations = new Map<number, { at: number; ledger: number }>();

  for (const event of events) {
    const payload = event.payload;
    if (!payload || !("name" in payload) || !("claimId" in payload)) {
      continue;
    }

    const claimId = payload.claimId;
    if (typeof claimId !== "number" || !Number.isFinite(claimId)) {
      continue;
    }

    if (payload.name === "claim_created") {
      const existing = creations.get(claimId);
      if (!existing || event.ledger < existing.ledger || (event.ledger === existing.ledger && event.at < existing.at)) {
        creations.set(claimId, { at: Math.trunc(event.at), ledger: Math.trunc(event.ledger) });
      }
    } else if (payload.name === "claim_resolved") {
      const existing = resolutions.get(claimId);
      if (!existing || event.ledger < existing.ledger || (event.ledger === existing.ledger && event.at < existing.at)) {
        resolutions.set(claimId, { at: Math.trunc(event.at), ledger: Math.trunc(event.ledger) });
      }
    } else if (payload.name === "claim_cancelled") {
      const existing = cancellations.get(claimId);
      if (!existing || event.ledger < existing.ledger || (event.ledger === existing.ledger && event.at < existing.at)) {
        cancellations.set(claimId, { at: Math.trunc(event.at), ledger: Math.trunc(event.ledger) });
      }
    }
  }

  // All known claimIds across any event type
  const allClaimIds = new Set<number>([
    ...creations.keys(),
    ...resolutions.keys(),
    ...cancellations.keys(),
  ]);

  const resolvedClaims: ClaimLatency[] = [];
  const cancelledClaims: ClaimLatency[] = [];
  let excludedCount = 0;

  for (const claimId of allClaimIds) {
    const creation = creations.get(claimId);
    const resolution = resolutions.get(claimId);
    const cancellation = cancellations.get(claimId);

    // If missing creation, it cannot form a duration
    if (!creation) {
      excludedCount++;
      continue;
    }

    // A claim may have resolution or cancellation or neither
    // If both exist (rare/edge case), pick the one with earlier ledger/at
    let endEvent: { at: number; ledger: number } | null = null;
    let endType: "resolved" | "cancelled" | null = null;

    if (resolution && cancellation) {
      if (
        resolution.ledger < cancellation.ledger ||
        (resolution.ledger === cancellation.ledger && resolution.at <= cancellation.at)
      ) {
        endEvent = resolution;
        endType = "resolved";
      } else {
        endEvent = cancellation;
        endType = "cancelled";
      }
    } else if (resolution) {
      endEvent = resolution;
      endType = "resolved";
    } else if (cancellation) {
      endEvent = cancellation;
      endType = "cancelled";
    }

    if (!endEvent || !endType) {
      // Incomplete claim (missing end)
      excludedCount++;
      continue;
    }

    const durationSec = Math.max(0, Math.trunc(endEvent.at - creation.at));
    const durationLedgers = Math.max(0, Math.trunc(endEvent.ledger - creation.ledger));

    const claimLatency: ClaimLatency = {
      claimId,
      creationLedger: creation.ledger,
      creationAt: creation.at,
      resolutionLedger: endEvent.ledger,
      resolutionAt: endEvent.at,
      duration: {
        seconds: durationSec,
        ledgers: durationLedgers,
      },
    };

    if (endType === "resolved") {
      resolvedClaims.push(claimLatency);
    } else {
      cancelledClaims.push(claimLatency);
    }
  }

  // Ensure deterministic ordering by claimId ascending
  resolvedClaims.sort((a, b) => a.claimId - b.claimId);
  cancelledClaims.sort((a, b) => a.claimId - b.claimId);

  return {
    resolved: {
      claims: resolvedClaims,
      summary: computeSummary(resolvedClaims),
    },
    cancelled: {
      claims: cancelledClaims,
      summary: computeSummary(cancelledClaims),
    },
    excludedCount,
  };
}
