/**
 * Coherent, deterministic scenarios for the local mock RPC.
 *
 * `defaultMockScenario()` (mock-rpc.ts) is a small hand-written slice, and the
 * synthetic fixtures in client.ts emit isolated events. Digests, summaries and
 * claim timelines need many entities that each walk a *complete* lifecycle, so
 * this module generates them from a seed:
 *
 *  - claim:  claim_created → (claim_challenged…) → claim_resolved | claim_cancelled
 *            → market_settled → challenger_paid (one per challenger)
 *  - squad:  market_created → deposited / withdrawn… → resolved → claimed (winners)
 *
 * Everything (ledgers, amounts, addresses, outcomes) derives from the seed via
 * a small PRNG, so the same options always yield byte-identical scenarios.
 * Every event matches the v1 decoder shapes in `src/stellar/decode.ts`.
 */

import { createHash } from "node:crypto";

import { StrKey } from "@stellar/stellar-sdk";

import type { MockEventInput, MockScenario } from "../stellar/mock-rpc.js";

export interface ScenarioOptions {
  /** PRNG seed; the same seed and options always give the same scenario. */
  seed: number | string;
  /** Number of market-contract claims to generate. Default 3. */
  claims?: number;
  /** Number of squad markets to generate. Default 2. */
  markets?: number;
  /** Ledger span the scenario covers (`1..ledgers`). Default 200. */
  ledgers?: number;
}

const CATEGORIES = ["crypto", "sports", "politics", "science", "culture"] as const;
const QUESTIONS = [
  "Will the next protocol upgrade ship on schedule?",
  "Will the squad's pick finish in the top three?",
  "Will the claim's source publish a correction?",
  "Will the weekly volume exceed last week's?",
] as const;

/** Challenger payout fee, in basis points (matches the default scenario's 5%). */
const PAYOUT_FEE_BPS = 500n;
const STROOPS = 10_000_000n;
const BASE_DEADLINE = 1_893_456_000;

/** mulberry32: tiny, fast, and fully deterministic across platforms. */
function makeRng(seed: number | string): () => number {
  let state = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positiveInt(value: number | undefined, fallback: number, name: string, min: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min) {
    throw new Error(`generateScenario: ${name} must be an integer >= ${min}; got ${String(value)}`);
  }
  return resolved;
}

/**
 * Generate a coherent multi-claim / multi-market scenario. Events are sorted
 * by ledger; within one entity, lifecycle order is preserved even when two
 * steps share a ledger.
 */
export function generateScenario(options: ScenarioOptions): MockScenario {
  const claims = positiveInt(options.claims, 3, "claims", 0);
  const markets = positiveInt(options.markets, 2, "markets", 0);
  const ledgers = positiveInt(options.ledgers, 200, "ledgers", 1);
  const rand = makeRng(options.seed);

  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  /** `count` non-decreasing ledgers in `1..ledgers`. */
  const ledgerSteps = (count: number): number[] =>
    Array.from({ length: count }, () => int(1, ledgers)).sort((a, b) => a - b);

  const addressCache = new Map<string, string>();
  const address = (role: string, index: number): string => {
    const key = `${role}:${index}`;
    let value = addressCache.get(key);
    if (value === undefined) {
      const raw = createHash("sha256").update(`mimir-scenario:${String(options.seed)}:${key}`).digest();
      value = StrKey.encodeEd25519PublicKey(raw);
      addressCache.set(key, value);
    }
    return value;
  };
  const participant = (): string => address("participant", int(0, 7));

  // Each entity's events, in lifecycle order; merged with a stable sort below.
  const timelines: MockEventInput[][] = [];

  for (let claimId = 1; claimId <= claims; claimId += 1) {
    const creator = participant();
    const challengerCount = int(0, 3);
    const challengers: { who: string; stake: bigint }[] = [];
    for (let i = 0; i < challengerCount; i += 1) {
      const who = address("challenger", (claimId * 4 + i) % 16);
      if (challengers.some((c) => c.who === who)) continue;
      challengers.push({ who, stake: BigInt(int(1, 50)) * STROOPS });
    }
    const cancelled = rand() < 0.25;
    const winnerSide = int(1, 2);
    const steps = ledgerSteps(3 + challengers.length * 2);
    let step = 0;
    const next = (): number => steps[step++] as number;
    const events: MockEventInput[] = [];

    events.push({
      source: "market",
      ledger: next(),
      eventName: "claim_created",
      topics: [claimId, { address: creator }],
      fields: { category: pick(CATEGORIES) },
    });
    for (const c of challengers) {
      events.push({
        source: "market",
        ledger: next(),
        eventName: "claim_challenged",
        topics: [claimId, { address: c.who }],
        fields: { stake: c.stake },
      });
    }

    if (cancelled) {
      events.push({ source: "market", ledger: next(), eventName: "claim_cancelled", topics: [claimId] });
    } else {
      const evidence = createHash("sha256").update(`evidence:${String(options.seed)}:${claimId}`).digest("hex");
      events.push({
        source: "market",
        ledger: next(),
        eventName: "claim_resolved",
        topics: [claimId],
        fields: {
          winner_side: winnerSide,
          summary: `Generated resolution for claim ${claimId}: side ${winnerSide} prevails`,
          confidence: int(50, 100),
          evidence_hash: { bytes: evidence },
        },
      });
    }

    // Cancelled claims refund stakes; challengers win on side 2 (as in the default scenario).
    const challengersWin = cancelled || winnerSide === 2;
    const payouts = challengersWin
      ? challengers.map((c) => {
          const gross = cancelled ? c.stake : c.stake + c.stake / 2n;
          const fee = cancelled ? 0n : (gross * PAYOUT_FEE_BPS) / 10_000n;
          return { ...c, gross, fee, net: gross - fee };
        })
      : [];
    const owed = payouts.reduce((sum, p) => sum + p.gross, 0n);
    const fees = payouts.reduce((sum, p) => sum + p.fee, 0n);
    events.push({
      source: "market",
      ledger: next(),
      eventName: "market_settled",
      topics: [claimId],
      fields: { total_paid: owed, total_fees: fees, owed_to_challengers: owed, dust: 0n },
    });
    for (const p of payouts) {
      events.push({
        source: "market",
        ledger: next(),
        eventName: "challenger_paid",
        topics: [claimId, { address: p.who }],
        fields: { stake: p.stake, gross: p.gross, fee: p.fee, net: p.net },
      });
    }
    timelines.push(events);
  }

  for (let marketId = 1; marketId <= markets; marketId += 1) {
    const captain = participant();
    const feeBps = pick([50, 100, 200, 250]);
    const depositCount = int(2, 5);
    const deposits = new Map<string, { side: number; who: string; amount: bigint }>();
    const order: { side: number; who: string; amount: bigint }[] = [];
    for (let i = 0; i < depositCount; i += 1) {
      const side = i < 2 ? i + 1 : int(1, 2); // both pools are funded
      const who = address("depositor", (marketId * 8 + i) % 32);
      const amount = BigInt(int(1, 100)) * STROOPS;
      const entry = { side, who, amount };
      deposits.set(who, entry);
      order.push(entry);
    }
    const withdrawals = order
      .filter(() => rand() < 0.3)
      .map((d) => ({ ...d, amount: d.amount / 2n }));

    const steps = ledgerSteps(1 + order.length + withdrawals.length + 1 + order.length);
    let step = 0;
    const next = (): number => steps[step++] as number;
    const events: MockEventInput[] = [];

    events.push({
      source: "squad",
      ledger: next(),
      eventName: "market_created",
      topics: [marketId, { address: captain }],
      fields: { deadline: BASE_DEADLINE + marketId * 86_400, fee_bps: feeBps, question: pick(QUESTIONS) },
    });
    for (const d of order) {
      events.push({
        source: "squad",
        ledger: next(),
        eventName: "deposited",
        topics: [marketId, d.side, { address: d.who }],
        fields: { amount: d.amount, shares: d.amount },
      });
    }
    for (const w of withdrawals) {
      const held = deposits.get(w.who);
      if (held) held.amount -= w.amount;
      events.push({
        source: "squad",
        ledger: next(),
        eventName: "withdrawn",
        topics: [marketId, w.side, { address: w.who }],
        fields: { amount: w.amount },
      });
    }

    const positions = [...deposits.values()];
    const poolA = positions.filter((p) => p.side === 1).reduce((s, p) => s + p.amount, 0n);
    const poolB = positions.filter((p) => p.side === 2).reduce((s, p) => s + p.amount, 0n);
    const result = int(1, 2);
    events.push({
      source: "squad",
      ledger: next(),
      eventName: "resolved",
      topics: [marketId],
      fields: { result, pool_a: poolA, pool_b: poolB },
    });

    const winningPool = result === 1 ? poolA : poolB;
    const total = poolA + poolB;
    for (const p of positions) {
      if (p.side !== result || p.amount === 0n || winningPool === 0n) continue;
      const gross = (p.amount * total) / winningPool;
      const fee = (gross * BigInt(feeBps)) / 10_000n;
      events.push({
        source: "squad",
        ledger: next(),
        eventName: "claimed",
        topics: [marketId, { address: p.who }],
        fields: { gross, fee, net: gross - fee },
      });
    }
    timelines.push(events);
  }

  // Array.prototype.sort is stable, so per-entity order survives ledger ties.
  const events = timelines.flat().sort((a, b) => a.ledger - b.ledger);
  return { latestLedger: ledgers, oldestLedger: 1, ledgersPerPage: 50, events };
}
