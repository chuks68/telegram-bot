export interface BackfillPlanInput {
  /** Inclusive start ledger of the requested range. */
  from: number;
  /** Inclusive end ledger of the requested range. */
  to: number;
  /** Oldest ledger retained by the RPC (inclusive). */
  oldest: number;
  /** Latest ledger available from the RPC (inclusive). */
  latest: number;
  /** Maximum number of ledgers per RPC page (chunk size). */
  maxSpan: number;
}

export interface LedgerChunk {
  /** Inclusive start ledger of this chunk. */
  from: number;
  /** Inclusive end ledger of this chunk. */
  to: number;
  /** Number of ledgers covered by this chunk (`to - from + 1`). */
  count: number;
}

export interface UnreachableRange {
  /** Inclusive start ledger of the unreachable range. */
  from: number;
  /** Inclusive end ledger of the unreachable range. */
  to: number;
  /** Number of ledgers covered by this range (`to - from + 1`). */
  count: number;
  /** Human-readable reason the range cannot be recovered. */
  reason: string;
}

export interface BackfillPlan {
  /** Ordered, contiguous, non-overlapping chunks covering the reachable range. */
  chunks: LedgerChunk[];
  /** Ranges that fall outside the retained window and cannot be recovered. */
  unreachable: UnreachableRange[];
  /** Requested range, echoed for convenience. */
  requested: { from: number; to: number };
  /** Resolved reachable range (clamped to the retained window), or null if none. */
  reachable: { from: number; to: number } | null;
  /** Effective max span used to build chunks. */
  maxSpan: number;
}

export type BackfillPlanErrorCode =
  | "INVALID_RANGE"
  | "INVALID_BOUNDS"
  | "INVALID_MAX_SPAN";

export class BackfillPlanError extends Error {
  readonly code: BackfillPlanErrorCode;

  constructor(code: BackfillPlanErrorCode, message: string) {
    super(message);
    this.name = "BackfillPlanError";
    this.code = code;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Split a requested ledger range into RPC-safe chunks that respect the
 * retained ledger window and the maximum page span.
 *
 * Ranges older than `oldest` are reported as unreachable rather than
 * silently clamped. Ranges above `latest` are clamped to `latest` since
 * those ledgers have not been produced yet and will be reachable later.
 */
export function planBackfill(input: BackfillPlanInput): BackfillPlan {
  const { from, to, oldest, latest, maxSpan } = input;

  if (!isInteger(from) || !isInteger(to)) {
    throw new BackfillPlanError(
      "INVALID_RANGE",
      `\`from\` and \`to\` must be integers (got from=${from}, to=${to})`,
    );
  }
  if (from < 0 || to < 0) {
    throw new BackfillPlanError(
      "INVALID_RANGE",
      `\`from\` and \`to\` must be non-negative (got from=${from}, to=${to})`,
    );
  }
  if (from > to) {
    throw new BackfillPlanError(
      "INVALID_RANGE",
      `\`from\` (${from}) must be less than or equal to \`to\` (${to})`,
    );
  }

  if (!isInteger(oldest) || !isInteger(latest)) {
    throw new BackfillPlanError(
      "INVALID_BOUNDS",
      `\`oldest\` and \`latest\` must be integers (got oldest=${oldest}, latest=${latest})`,
    );
  }
  if (oldest < 0 || latest < 0) {
    throw new BackfillPlanError(
      "INVALID_BOUNDS",
      `\`oldest\` and \`latest\` must be non-negative (got oldest=${oldest}, latest=${latest})`,
    );
  }
  if (oldest > latest) {
    throw new BackfillPlanError(
      "INVALID_BOUNDS",
      `\`oldest\` (${oldest}) must be less than or equal to \`latest\` (${latest})`,
    );
  }

  if (!isInteger(maxSpan) || maxSpan < 1) {
    throw new BackfillPlanError(
      "INVALID_MAX_SPAN",
      `\`maxSpan\` must be a positive integer (got ${maxSpan})`,
    );
  }

  const unreachable: UnreachableRange[] = [];

  // Report any portion of the requested range that predates the retained window.
  if (from < oldest) {
    const unreachableTo = Math.min(to, oldest - 1);
    unreachable.push({
      from,
      to: unreachableTo,
      count: unreachableTo - from + 1,
      reason: `range predates the oldest retained ledger (${oldest})`,
    });
  }

  // Clamp the reachable range to the retained window [oldest, latest].
  const reachableFrom = Math.max(from, oldest);
  const reachableTo = Math.min(to, latest);

  if (reachableFrom > reachableTo) {
    return {
      chunks: [],
      unreachable,
      requested: { from, to },
      reachable: null,
      maxSpan,
    };
  }

  const chunks: LedgerChunk[] = [];
  for (let cursor = reachableFrom; cursor <= reachableTo; cursor += maxSpan) {
    const chunkTo = Math.min(cursor + maxSpan - 1, reachableTo);
    chunks.push({ from: cursor, to: chunkTo, count: chunkTo - cursor + 1 });
  }

  return {
    chunks,
    unreachable,
    requested: { from, to },
    reachable: { from: reachableFrom, to: reachableTo },
    maxSpan,
  };
}

/**
 * Format a backfill plan for CLI output. Returns a human-readable
 * multi-line string summarizing the plan.
 */
export function describePlan(plan: BackfillPlan): string {
  const lines: string[] = [];
  const { requested, reachable, chunks, unreachable, maxSpan } = plan;

  lines.push(`Backfill plan for ledgers ${requested.from}..${requested.to}`);
  lines.push(`  max span: ${maxSpan}`);

  if (reachable) {
    const total = reachable.to - reachable.from + 1;
    lines.push(
      `  reachable: ${reachable.from}..${reachable.to} (${total} ledgers, ${chunks.length} chunk(s))`,
    );
  } else {
    lines.push(`  reachable: none`);
  }

  if (chunks.length > 0) {
    lines.push(`  chunks:`);
    for (const chunk of chunks) {
      lines.push(`    - ${chunk.from}..${chunk.to} (${chunk.count} ledgers)`);
    }
  }

  if (unreachable.length > 0) {
    lines.push(`  unreachable:`);
    for (const range of unreachable) {
      lines.push(`    - ${range.from}..${range.to} (${range.count} ledgers): ${range.reason}`);
    }
  }

  return lines.join("\n");
}
