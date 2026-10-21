/**
 * Differential test: v1 and v2 decoders agree on shared fields.
 *
 * Proves that decodeMarketV1/decodeMarketV2 and decodeSquadV1/decodeSquadV2
 * produce identical results for every field present in both versions.
 * Divergence would silently change notifications after an upgrade.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { scValToNative, xdr, Address, Keypair } from "@stellar/stellar-sdk";

import {
  decodeMarketV1,
  decodeMarketV2,
  decodeSquadV1,
  decodeSquadV2,
} from "../dist/stellar/decode.js";

// ── Seeded RNG for reproducible test data ─────────────────────────────────────

class SeededRNG {
  constructor(seed = 0x12345678) {
    this.state = seed;
  }

  next() {
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
    return this.state / 0x7fffffff;
  }

  nextInt(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextBigInt(min, max) {
    const range = max - min;
    const random = BigInt(this.nextInt(0, Number.MAX_SAFE_INTEGER));
    return min + (random * range) / BigInt(Number.MAX_SAFE_INTEGER);
  }

  nextString(length, charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    let result = "";
    for (let i = 0; i < length; i++) {
      result += charset[this.nextInt(0, charset.length - 1)];
    }
    return result;
  }
}

const rng = new SeededRNG(0xDEADBEEF);

// ── Deterministic test identities ────────────────────────────────────────────

const CREATOR_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x01));
const CHALL_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x02));
const CAPTAIN_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x03));
const FEE_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x04));

const CREATOR = CREATOR_KP.publicKey();
const CHALL = CHALL_KP.publicKey();
const CAPTAIN = CAPTAIN_KP.publicKey();
const FEE_ADDR = FEE_KP.publicKey();

// ── XDR builders (same approach as fixtures) ─────────────────────────────────

function sym(s) {
  return xdr.ScVal.scvSymbol(s);
}

function str(s) {
  return xdr.ScVal.scvString(s);
}

function u32(n) {
  return xdr.ScVal.scvU32(n);
}

function u64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
}

function i128(n) {
  const bn = BigInt(n);
  const isNeg = bn < 0n;
  const abs = isNeg ? -bn : bn;
  const lo = abs & 0xFFFF_FFFF_FFFF_FFFFn;
  let hi = abs >> 64n;
  if (isNeg) {
    hi = (~hi + (lo === 0n ? 1n : 0n)) & 0xFFFF_FFFF_FFFF_FFFFn;
    const loVal = lo === 0n ? 0n : ((~lo + 1n) & 0xFFFF_FFFF_FFFF_FFFFn);
    return xdr.ScVal.scvI128(new xdr.Int128Parts({
      hi: xdr.Int64.fromString(String(BigInt.asIntN(64, hi))),
      lo: xdr.Uint64.fromString(String(loVal)),
    }));
  }
  return xdr.ScVal.scvI128(new xdr.Int128Parts({
    hi: xdr.Int64.fromString("0"),
    lo: xdr.Uint64.fromString(String(lo)),
  }));
}

function addrVal(strkey) {
  return new Address(strkey).toScVal();
}

function bytesVal(hexStr) {
  return xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

function scMap(pairs) {
  return xdr.ScVal.scvMap(
    pairs.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
  );
}

// ── Test generators ───────────────────────────────────────────────────────────

function generateBigInt() {
  // Mix of small, boundary, and large values
  const choice = rng.nextInt(0, 2);
  switch (choice) {
    case 0:
      return rng.nextBigInt(0n, 1_000_000n);
    case 1:
      return rng.nextBigInt(0n, BigInt(Number.MAX_SAFE_INTEGER));
    case 2:
      return rng.nextBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 10_000_000_000_000_000_000n);
  }
}

function generateString(maxLength = 200) {
  const length = rng.nextInt(1, maxLength);
  return rng.nextString(length);
}

// ── Market events (shared between v1 and v2) ───────────────────────────────

const MARKET_SHARED_EVENTS = [
  "claim_challenged",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
];

for (const eventName of MARKET_SHARED_EVENTS) {
  test(`market: ${eventName} v1/v2 agree on shared fields`, () => {
    let topics;
    let fields;

    switch (eventName) {
      case "claim_challenged": {
        const claimId = rng.nextInt(1, 1000);
        const stake = generateBigInt();
        topics = [sym(eventName), u64(claimId), addrVal(CHALL)];
        fields = scMap([["stake", i128(stake)]]);
        break;
      }

      case "claim_cancelled": {
        const claimId = rng.nextInt(1, 1000);
        topics = [sym(eventName), u64(claimId)];
        fields = scMap([]);
        break;
      }

      case "market_settled": {
        const claimId = rng.nextInt(1, 1000);
        const totalPaid = generateBigInt();
        const totalFees = generateBigInt();
        const owedToChallengers = generateBigInt();
        const dust = generateBigInt();
        topics = [sym(eventName), u64(claimId)];
        fields = scMap([
          ["total_paid", i128(totalPaid)],
          ["total_fees", i128(totalFees)],
          ["owed_to_challengers", i128(owedToChallengers)],
          ["dust", i128(dust)],
        ]);
        break;
      }

      case "challenger_paid": {
        const claimId = rng.nextInt(1, 1000);
        const stake = generateBigInt();
        const gross = generateBigInt();
        const fee = generateBigInt();
        const net = generateBigInt();
        topics = [sym(eventName), u64(claimId), addrVal(CHALL)];
        fields = scMap([
          ["stake", i128(stake)],
          ["gross", i128(gross)],
          ["fee", i128(fee)],
          ["net", i128(net)],
        ]);
        break;
      }

      case "fee_claimed": {
        const amount = generateBigInt();
        topics = [sym(eventName), addrVal(FEE_ADDR)];
        fields = scMap([["amount", i128(amount)]]);
        break;
      }

      case "withdrawal":
      case "withdrawal_pending": {
        const amount = generateBigInt();
        topics = [sym(eventName), addrVal(CREATOR)];
        fields = scMap([["amount", i128(amount)]]);
        break;
      }
    }

    // Convert topics and fields to native values for decoder input
    const nativeTopics = topics.map((t) => scValToNative(t));
    const nativeFields = {};
    const fieldsMap = fields.map();
    for (const entry of fieldsMap) {
      const key = scValToNative(entry.key());
      const val = scValToNative(entry.val());
      nativeFields[key] = val;
    }

    const v1 = decodeMarketV1(eventName, nativeTopics, nativeFields);
    const v2 = decodeMarketV2(eventName, nativeTopics, nativeFields);

    assert.ok(v1, `v1 decoder should return a payload for ${eventName}`);
    assert.ok(v2, `v2 decoder should return a payload for ${eventName}`);

    // Compare all fields except v2-specific ones
    for (const key of Object.keys(v1)) {
      if (key === "name") continue; // Event name is always the same
      assert.deepStrictEqual(
        v1[key],
        v2[key],
        `${eventName}: field "${key}" differs between v1 and v2`,
      );
    }
  });
}

// ── Squad events (shared between v1 and v2) ───────────────────────────────

const SQUAD_SHARED_EVENTS = [
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
];

for (const eventName of SQUAD_SHARED_EVENTS) {
  test(`squad: ${eventName} v1/v2 agree on shared fields`, () => {
    let topics;
    let fields;

    switch (eventName) {
      case "deposited": {
        const marketId = rng.nextInt(1, 1000);
        const side = rng.nextInt(0, 1);
        const amount = generateBigInt();
        const shares = generateBigInt();
        topics = [sym(eventName), u64(marketId), u32(side), addrVal(CREATOR)];
        fields = scMap([
          ["amount", i128(amount)],
          ["shares", i128(shares)],
        ]);
        break;
      }

      case "withdrawn": {
        const marketId = rng.nextInt(1, 1000);
        const side = rng.nextInt(0, 1);
        const amount = generateBigInt();
        topics = [sym(eventName), u64(marketId), u32(side), addrVal(CREATOR)];
        fields = scMap([["amount", i128(amount)]]);
        break;
      }

      case "resolved": {
        const marketId = rng.nextInt(1, 1000);
        const result = rng.nextInt(0, 1);
        const poolA = generateBigInt();
        const poolB = generateBigInt();
        topics = [sym(eventName), u64(marketId)];
        fields = scMap([
          ["result", u32(result)],
          ["pool_a", i128(poolA)],
          ["pool_b", i128(poolB)],
        ]);
        break;
      }

      case "claimed": {
        const marketId = rng.nextInt(1, 1000);
        const gross = generateBigInt();
        const fee = generateBigInt();
        const net = generateBigInt();
        topics = [sym(eventName), u64(marketId), addrVal(CREATOR)];
        fields = scMap([
          ["gross", i128(gross)],
          ["fee", i128(fee)],
          ["net", i128(net)],
        ]);
        break;
      }

      case "fees_claimed": {
        const amount = generateBigInt();
        topics = [sym(eventName), addrVal(FEE_ADDR)];
        fields = scMap([["amount", i128(amount)]]);
        break;
      }
    }

    // Convert topics and fields to native values for decoder input
    const nativeTopics = topics.map((t) => scValToNative(t));
    const nativeFields = {};
    const fieldsMap = fields.map();
    for (const entry of fieldsMap) {
      const key = scValToNative(entry.key());
      const val = scValToNative(entry.val());
      nativeFields[key] = val;
    }

    const v1 = decodeSquadV1(eventName, nativeTopics, nativeFields);
    const v2 = decodeSquadV2(eventName, nativeTopics, nativeFields);

    assert.ok(v1, `v1 decoder should return a payload for ${eventName}`);
    assert.ok(v2, `v2 decoder should return a payload for ${eventName}`);

    // Compare all fields except v2-specific ones
    for (const key of Object.keys(v1)) {
      if (key === "name") continue; // Event name is always the same
      assert.deepStrictEqual(
        v1[key],
        v2[key],
        `${eventName}: field "${key}" differs between v1 and v2`,
      );
    }
  });
}

// ── Boundary cases ───────────────────────────────────────────────────────────

test("market: boundary amounts - zero, max safe integer, large bigint", () => {
  const eventName = "claim_challenged";
  const claimId = 1;
  const testAmounts = [0n, 1n, BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER) + 1n, 10_000_000_000_000_000_000n];

  for (const stake of testAmounts) {
    const topics = [sym(eventName), u64(claimId), addrVal(CHALL)];
    const fields = scMap([["stake", i128(stake)]]);

    const nativeTopics = topics.map((t) => scValToNative(t));
    const nativeFields = {};
    const fieldsMap = fields.map();
    for (const entry of fieldsMap) {
      const key = scValToNative(entry.key());
      const val = scValToNative(entry.val());
      nativeFields[key] = val;
    }

    const v1 = decodeMarketV1(eventName, nativeTopics, nativeFields);
    const v2 = decodeMarketV2(eventName, nativeTopics, nativeFields);

    assert.deepStrictEqual(v1.stake, v2.stake, `boundary amount ${stake} differs`);
  }
});

test("squad: boundary string lengths", () => {
  const eventName = "market_created";
  const marketId = 1;
  const testLengths = [1, 50, 200, 500];

  for (const length of testLengths) {
    const question = "Q".repeat(length);
    const topics = [sym(eventName), u64(marketId), addrVal(CAPTAIN)];
    const fields = scMap([
      ["deadline", u64(1_800_000_000)],
      ["fee_bps", u32(200)],
      ["question", str(question)],
    ]);

    const nativeTopics = topics.map((t) => scValToNative(t));
    const nativeFields = {};
    const fieldsMap = fields.map();
    for (const entry of fieldsMap) {
      const key = scValToNative(entry.key());
      const val = scValToNative(entry.val());
      nativeFields[key] = val;
    }

    const v1 = decodeSquadV1(eventName, nativeTopics, nativeFields);
    const v2 = decodeSquadV2(eventName, nativeTopics, nativeFields);

    // market_created has v2-specific 'category' field, so compare only shared fields
    assert.strictEqual(v1.marketId, v2.marketId);
    assert.strictEqual(v1.captain, v2.captain);
    assert.strictEqual(v1.deadline, v2.deadline);
    assert.strictEqual(v1.feeBps, v2.feeBps);
    assert.strictEqual(v1.question, v2.question);
  }
});
