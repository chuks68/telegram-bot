#!/usr/bin/env node
/**
 * scripts/bench-decode.mjs
 *
 * Micro-benchmark measuring event decode (`decodeEvent` in src/stellar/decode.ts)
 * and notification format (`formatEvent` in src/notifications/format.ts) throughput
 * and per-event latency.
 *
 * Uses synthetic event fixtures from `tests/fixtures/events.mjs`.
 * Hermetic and credential-free: requires no network access and no environment variables.
 *
 * Usage:
 *   node scripts/bench-decode.mjs [--events=N] [--iterations=N] [--warmup=N] [--json]
 *
 * Options:
 *   --events=N, -n N        Number of fixture events per iteration (default: 1000)
 *   --iterations=N, -i N    Number of timed iterations (default: 5)
 *   --warmup=N, -w N        Number of warmup iterations (default: 2)
 *   --json                  Output benchmark results as JSON summary (default)
 *   --help, -h              Show usage instructions
 *
 * Output:
 *   Prints a JSON summary containing throughput (ops/sec), per-event latency
 *   metrics (p50, p95, p99, avg, min, max in ms), and per-iteration statistics.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { decodeEvent } from "../dist/stellar/decode.js";
import { formatEvent } from "../dist/notifications/format.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimCreatedEvent,
  claimChallengedEvent,
  claimResolvedEvent,
  claimCancelledEvent,
  marketSettledEvent,
  challengerPaidEvent,
  feeClaimedEvent,
  withdrawalEvent,
  withdrawalPendingEvent,
  squadMarketCreatedEvent,
  squadDepositedEvent,
  squadWithdrawnEvent,
  squadResolvedEvent,
  squadClaimedEvent,
  squadFeesClaimedEvent,
  oracleChangedEvent,
  feePolicySetEvent,
  ownershipTransferredEvent,
  agentAttributedEvent,
  feeAccruedEvent,
  emptyTopicsEvent,
  truncatedTopicsEvent,
  wrongValueTypeEvent,
  invalidAddressTopic,
  wrongFieldTypeEvent,
  unknownWinnerSideEvent,
  longCategoryEvent,
  longQuestionEvent,
  largeAmountEvent,
  negativeAmountEvent,
} from "../tests/fixtures/events.mjs";

/**
 * Static offline configuration for formatting notifications.
 * Uses fixture contract IDs and example URLs without requiring network or secrets.
 */
export const BENCH_CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: MARKET_CONTRACT,
  squadContractId: SQUAD_CONTRACT,
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://example.invalid/explorer",
};

/**
 * Fixture factories paired with their contract source ('market' | 'squad').
 * Covers normal positive cases, admin events, and boundary/malformed inputs.
 */
export const FIXTURE_FACTORIES = [
  // mimir-market positive cases
  { source: "market", name: "claim_created", fn: claimCreatedEvent },
  { source: "market", name: "claim_challenged", fn: claimChallengedEvent },
  { source: "market", name: "claim_resolved", fn: claimResolvedEvent },
  { source: "market", name: "claim_cancelled", fn: claimCancelledEvent },
  { source: "market", name: "market_settled", fn: marketSettledEvent },
  { source: "market", name: "challenger_paid", fn: challengerPaidEvent },
  { source: "market", name: "fee_claimed", fn: feeClaimedEvent },
  { source: "market", name: "withdrawal", fn: withdrawalEvent },
  { source: "market", name: "withdrawal_pending", fn: withdrawalPendingEvent },
  // mimir-squad positive cases
  { source: "squad", name: "market_created", fn: squadMarketCreatedEvent },
  { source: "squad", name: "deposited", fn: squadDepositedEvent },
  { source: "squad", name: "withdrawn", fn: squadWithdrawnEvent },
  { source: "squad", name: "resolved", fn: squadResolvedEvent },
  { source: "squad", name: "claimed", fn: squadClaimedEvent },
  { source: "squad", name: "fees_claimed", fn: squadFeesClaimedEvent },
  // admin events
  { source: "market", name: "oracle_changed", fn: oracleChangedEvent },
  { source: "market", name: "fee_policy_set", fn: feePolicySetEvent },
  { source: "market", name: "ownership_transferred", fn: ownershipTransferredEvent },
  { source: "market", name: "agent_attributed", fn: agentAttributedEvent },
  { source: "market", name: "fee_accrued", fn: feeAccruedEvent },
  // boundary & edge-payload cases
  { source: "market", name: "empty_topics", fn: emptyTopicsEvent },
  { source: "market", name: "truncated_topics", fn: truncatedTopicsEvent },
  { source: "market", name: "wrong_value_type", fn: wrongValueTypeEvent },
  { source: "market", name: "invalid_address_topic", fn: invalidAddressTopic },
  { source: "market", name: "wrong_field_type", fn: wrongFieldTypeEvent },
  { source: "market", name: "unknown_winner_side", fn: unknownWinnerSideEvent },
  { source: "market", name: "long_category", fn: longCategoryEvent },
  { source: "squad", name: "long_question", fn: longQuestionEvent },
  { source: "market", name: "large_amount", fn: largeAmountEvent },
  { source: "market", name: "negative_amount", fn: negativeAmountEvent },
];

/**
 * Pre-generate N fixture events by cycling through available factories.
 * Events are built beforehand so fixture construction is excluded from benchmark timing.
 */
export function createFixtureEvents(count = 1000) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const item = FIXTURE_FACTORIES[i % FIXTURE_FACTORIES.length];
    const raw = item.fn({
      ledger: 4200000 + i,
      claimId: (i % 500) + 1,
      marketId: (i % 500) + 1,
    });
    events.push({ source: item.source, raw });
  }
  return events;
}

/**
 * Calculate the percentile value of a pre-sorted array of numbers using linear interpolation.
 */
export function calculatePercentile(sortedValues, percentile) {
  if (!sortedValues || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Generous default regression thresholds used by tests/bench-budget.test.mjs.
 * Normal per-event decode+format cost is ~0.2 - 0.7 ms (>1,500 ops/sec).
 * Generous ceilings prevent flaky CI failures under CPU throttling or noisy runners.
 */
export const DEFAULT_BUDGET = {
  maxAvgPerEventMs: 25.0,
  maxP95PerEventMs: 50.0,
  minOpsPerSec: 20.0,
};

/**
 * Run decode and format benchmark.
 *
 * @param {object} [options]
 * @param {number} [options.eventsCount=1000] - Number of events per iteration
 * @param {number} [options.iterations=5]     - Number of timed iterations
 * @param {number} [options.warmupIterations=2] - Number of unmeasured warmup iterations
 * @param {object} [options.config]           - Bot / Stellar config override
 * @returns {object} JSON-serializable benchmark summary
 */
export function runBenchmark(options = {}) {
  const eventsCount = Math.max(0, options.eventsCount ?? options.events ?? 1000);
  const iterations = Math.max(1, options.iterations ?? 5);
  const warmupIterations = Math.max(0, options.warmupIterations ?? options.warmup ?? 2);
  const config = options.config ?? BENCH_CONFIG;

  if (eventsCount === 0) {
    return {
      eventsPerIteration: 0,
      iterations,
      warmupIterations,
      totalEvents: 0,
      totalDurationMs: 0,
      opsPerSec: 0,
      avgPerEventMs: 0,
      p50PerEventMs: 0,
      p95PerEventMs: 0,
      p99PerEventMs: 0,
      minPerEventMs: 0,
      maxPerEventMs: 0,
      p95Ms: 0,
      ops_per_sec: 0,
      p95_per_event_ms: 0,
      iterationStats: [],
    };
  }

  // Pre-generate fixtures before measuring
  const fixtureEvents = createFixtureEvents(eventsCount);

  // Warmup phase (not timed)
  for (let w = 0; w < warmupIterations; w++) {
    for (let i = 0; i < fixtureEvents.length; i++) {
      const e = fixtureEvents[i];
      const decoded = decodeEvent(e.source, e.raw);
      formatEvent(config, decoded);
    }
  }

  // Measurement phase
  const allDurationsMs = [];
  const iterationStats = [];
  let totalMeasuredNs = 0n;

  for (let iter = 0; iter < iterations; iter++) {
    const iterDurationsMs = [];
    const iterStartNs = process.hrtime.bigint();

    for (let i = 0; i < fixtureEvents.length; i++) {
      const e = fixtureEvents[i];
      const t0 = process.hrtime.bigint();
      const decoded = decodeEvent(e.source, e.raw);
      formatEvent(config, decoded);
      const t1 = process.hrtime.bigint();

      const perEventMs = Number(t1 - t0) / 1e6;
      iterDurationsMs.push(perEventMs);
      allDurationsMs.push(perEventMs);
    }

    const iterEndNs = process.hrtime.bigint();
    const iterTotalNs = iterEndNs - iterStartNs;
    totalMeasuredNs += iterTotalNs;

    const iterDurationMs = Number(iterTotalNs) / 1e6;
    const sortedIter = [...iterDurationsMs].sort((a, b) => a - b);
    const iterP95 = calculatePercentile(sortedIter, 95);
    const iterOpsPerSec = iterDurationMs > 0 ? (eventsCount / (iterDurationMs / 1000)) : 0;

    iterationStats.push({
      iteration: iter + 1,
      events: eventsCount,
      durationMs: round(iterDurationMs, 3),
      opsPerSec: round(iterOpsPerSec, 2),
      avgPerEventMs: round(iterDurationMs / eventsCount, 4),
      p95PerEventMs: round(iterP95, 4),
    });
  }

  allDurationsMs.sort((a, b) => a - b);

  const totalEvents = eventsCount * iterations;
  const totalDurationMs = Number(totalMeasuredNs) / 1e6;
  const opsPerSec = totalDurationMs > 0 ? (totalEvents / (totalDurationMs / 1000)) : 0;
  const avgPerEventMs = totalEvents > 0 ? (totalDurationMs / totalEvents) : 0;

  const p50 = calculatePercentile(allDurationsMs, 50);
  const p95 = calculatePercentile(allDurationsMs, 95);
  const p99 = calculatePercentile(allDurationsMs, 99);
  const min = allDurationsMs[0] ?? 0;
  const max = allDurationsMs[allDurationsMs.length - 1] ?? 0;

  return {
    eventsPerIteration: eventsCount,
    iterations,
    warmupIterations,
    totalEvents,
    totalDurationMs: round(totalDurationMs, 3),
    opsPerSec: round(opsPerSec, 2),
    avgPerEventMs: round(avgPerEventMs, 4),
    p50PerEventMs: round(p50, 4),
    p95PerEventMs: round(p95, 4),
    p99PerEventMs: round(p99, 4),
    minPerEventMs: round(min, 4),
    maxPerEventMs: round(max, 4),
    // Aliases for interoperability
    p95Ms: round(p95, 4),
    ops_per_sec: round(opsPerSec, 2),
    p95_per_event_ms: round(p95, 4),
    iterationStats,
  };
}

export const USAGE = `Usage: node scripts/bench-decode.mjs [options]

Options:
  --events=N, -n N        Number of fixture events per iteration (default: 1000)
  --iterations=N, -i N    Number of timed iterations (default: 5)
  --warmup=N, -w N        Number of warmup iterations (default: 2)
  --json                  Output benchmark summary as JSON (default)
  --help, -h              Show this help message`;

export function parseArgs(argv) {
  const options = {
    events: 1000,
    iterations: 5,
    warmup: 2,
    json: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--events=")) {
      options.events = parseInt(arg.slice(9), 10);
    } else if (arg === "-n" && i + 1 < argv.length) {
      options.events = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--iterations=")) {
      options.iterations = parseInt(arg.slice(13), 10);
    } else if (arg === "-i" && i + 1 < argv.length) {
      options.iterations = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--warmup=")) {
      options.warmup = parseInt(arg.slice(9), 10);
    } else if (arg === "-w" && i + 1 < argv.length) {
      options.warmup = parseInt(argv[++i], 10);
    } else if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const result = runBenchmark({
    eventsCount: args.events,
    iterations: args.iterations,
    warmupIterations: args.warmup,
  });

  console.log(JSON.stringify(result, null, 2));
}
