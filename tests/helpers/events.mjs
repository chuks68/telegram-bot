/**
 * tests/helpers/events.mjs
 *
 * Test event builders for Mimir contract events.
 *
 * Exports `marketEvent(name, overrides)` and `squadEvent(name, overrides)` with
 * valid defaults for every payload type in `MarketPayload` and `SquadPayload`.
 *
 * Generates unique event IDs and strictly increasing ledger sequences by default.
 */

export const DEFAULT_MARKET_CONTRACT_ID =
  "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
export const DEFAULT_SQUAD_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const DEFAULT_ACCOUNT_A =
  "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
export const DEFAULT_ACCOUNT_B =
  "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

let currentLedger = 1000;
let currentEventSeq = 0;

/**
 * Reset ledger and event sequence counters (primarily for tests needing deterministic baselines).
 */
export function resetEventCounters(startLedger = 1000) {
  currentLedger = startLedger;
  currentEventSeq = 0;
}

const META_KEYS = new Set([
  "source",
  "contractId",
  "version",
  "ledger",
  "txHash",
  "at",
  "eventId",
  "id",
  "eventType",
  "transactionIndex",
  "operationIndex",
  "inSuccessfulContractCall",
  "skip",
  "payload",
]);

/**
 * Returns default payload for a given market event name.
 */
function defaultMarketPayload(name) {
  switch (name) {
    case "claim_created":
      return {
        name: "claim_created",
        claimId: 1,
        creator: DEFAULT_ACCOUNT_A,
        category: "crypto",
      };
    case "claim_challenged":
      return {
        name: "claim_challenged",
        claimId: 1,
        challenger: DEFAULT_ACCOUNT_B,
        stake: 10_000_000n,
      };
    case "claim_resolved":
      return {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 1,
        summary: "Claim resolved by oracle",
        confidence: 100,
        evidenceHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
    case "claim_cancelled":
      return {
        name: "claim_cancelled",
        claimId: 1,
      };
    case "market_settled":
      return {
        name: "market_settled",
        claimId: 1,
        totalPaid: 100_000_000n,
        totalFees: 5_000_000n,
        owedToChallengers: 95_000_000n,
        dust: 0n,
      };
    case "challenger_paid":
      return {
        name: "challenger_paid",
        claimId: 1,
        challenger: DEFAULT_ACCOUNT_B,
        stake: 10_000_000n,
        gross: 20_000_000n,
        fee: 1_000_000n,
        net: 19_000_000n,
      };
    case "fee_claimed":
      return {
        name: "fee_claimed",
        recipient: DEFAULT_ACCOUNT_A,
        amount: 5_000_000n,
      };
    case "withdrawal":
      return {
        name: "withdrawal",
        to: DEFAULT_ACCOUNT_A,
        amount: 10_000_000n,
      };
    case "withdrawal_pending":
      return {
        name: "withdrawal_pending",
        to: DEFAULT_ACCOUNT_A,
        amount: 10_000_000n,
      };
    default:
      return { name };
  }
}

/**
 * Returns default payload for a given squad event name.
 */
function defaultSquadPayload(name) {
  switch (name) {
    case "market_created":
      return {
        name: "market_created",
        marketId: 1,
        captain: DEFAULT_ACCOUNT_A,
        deadline: 1_800_000_000,
        feeBps: 100,
        question: "Will event occur?",
      };
    case "deposited":
      return {
        name: "deposited",
        marketId: 1,
        side: 1,
        participant: DEFAULT_ACCOUNT_B,
        amount: 10_000_000n,
        shares: 10_000_000n,
      };
    case "withdrawn":
      return {
        name: "withdrawn",
        marketId: 1,
        side: 1,
        participant: DEFAULT_ACCOUNT_B,
        amount: 10_000_000n,
      };
    case "resolved":
      return {
        name: "resolved",
        marketId: 1,
        result: 1,
        poolA: 100_000_000n,
        poolB: 50_000_000n,
      };
    case "claimed":
      return {
        name: "claimed",
        marketId: 1,
        participant: DEFAULT_ACCOUNT_B,
        gross: 20_000_000n,
        fee: 1_000_000n,
        net: 19_000_000n,
      };
    case "fees_claimed":
      return {
        name: "fees_claimed",
        recipient: DEFAULT_ACCOUNT_A,
        amount: 5_000_000n,
      };
    default:
      return { name };
  }
}

/**
 * Helper to build an event object given source, name, default payload generator, and overrides.
 */
function buildEvent(source, defaultContractId, defaultPayloadFn, nameArg, overridesArg = {}) {
  let name = nameArg;
  let overrides = overridesArg;

  // Handle call where overrides object is passed as the first argument
  if (typeof nameArg === "object" && nameArg !== null) {
    overrides = nameArg;
    name = overrides.name ?? overrides.payload?.name;
  }

  if (!name) {
    name = source === "market" ? "claim_created" : "market_created";
  }

  const basePayload = defaultPayloadFn(name);

  // Partition overrides into metadata vs payload overrides
  const metaOverrides = {};
  const payloadOverrides = {};

  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (META_KEYS.has(key)) {
        metaOverrides[key] = val;
      } else {
        payloadOverrides[key] = val;
      }
    }
  }

  const ledger = metaOverrides.ledger ?? currentLedger++;
  const seq = currentEventSeq++;
  const eventId = metaOverrides.eventId ?? metaOverrides.id ?? `${ledger}-${seq}`;

  const payload = {
    ...basePayload,
    ...payloadOverrides,
    ...(metaOverrides.payload || {}),
  };

  const meta = {
    source,
    contractId: metaOverrides.contractId ?? defaultContractId,
    version: metaOverrides.version ?? "v1",
    ledger,
    txHash: metaOverrides.txHash ?? "",
    at: metaOverrides.at ?? 1_724_000_000 + ledger,
    eventId,
    eventType: metaOverrides.eventType ?? "contract",
    transactionIndex: metaOverrides.transactionIndex !== undefined ? metaOverrides.transactionIndex : 0,
    operationIndex: metaOverrides.operationIndex !== undefined ? metaOverrides.operationIndex : 0,
    inSuccessfulContractCall:
      metaOverrides.inSuccessfulContractCall !== undefined
        ? metaOverrides.inSuccessfulContractCall
        : true,
  };

  if ("skip" in metaOverrides) {
    meta.skip = metaOverrides.skip;
  }

  return {
    ...meta,
    payload,
  };
}

/**
 * Build a decoded market event with valid defaults and unique IDs/ledgers.
 *
 * @param {string} [name="claim_created"] Event name
 * @param {Record<string, any>} [overrides={}] Metadata or payload overrides
 */
export function marketEvent(name, overrides) {
  return buildEvent("market", DEFAULT_MARKET_CONTRACT_ID, defaultMarketPayload, name, overrides);
}

/**
 * Build a decoded squad event with valid defaults and unique IDs/ledgers.
 *
 * @param {string} [name="market_created"] Event name
 * @param {Record<string, any>} [overrides={}] Metadata or payload overrides
 */
export function squadEvent(name, overrides) {
  return buildEvent("squad", DEFAULT_SQUAD_CONTRACT_ID, defaultSquadPayload, name, overrides);
}
