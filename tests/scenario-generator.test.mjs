import assert from "node:assert/strict";
import test from "node:test";

import { rpc } from "@stellar/stellar-sdk";

import { generateScenario } from "../dist/dev/scenario-generator.js";
import { decodeEvent } from "../dist/stellar/decode.js";
import { MOCK_MARKET_CONTRACT_ID, MOCK_SQUAD_CONTRACT_ID } from "../dist/stellar/mock-constants.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";

const OPTIONS = { seed: 42, claims: 8, markets: 5, ledgers: 300 };

const serialize = (value) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

/** Serve the scenario on the mock RPC and decode every event the real SDK returns. */
async function decodeScenario(scenario) {
  const mock = await startMockRpc({
    port: 0,
    scenario: { ...scenario, ledgersPerPage: scenario.latestLedger },
  });
  try {
    const server = new rpc.Server(mock.url, { allowHttp: true });
    const page = await server.getEvents({
      startLedger: scenario.oldestLedger,
      filters: [{ type: "contract", contractIds: [MOCK_MARKET_CONTRACT_ID, MOCK_SQUAD_CONTRACT_ID] }],
      limit: 1000,
    });
    return page.events.map((event) => {
      const id = String(event.contractId?.contractId?.() ?? event.contractId);
      return decodeEvent(id === MOCK_SQUAD_CONTRACT_ID ? "squad" : "market", event);
    });
  } finally {
    await mock.close();
  }
}

test("same seed yields byte-identical scenarios; different seeds differ", () => {
  assert.equal(serialize(generateScenario(OPTIONS)), serialize(generateScenario(OPTIONS)));
  assert.notEqual(
    serialize(generateScenario(OPTIONS)),
    serialize(generateScenario({ ...OPTIONS, seed: 43 })),
  );
});

test("generated events decode without falling back to unknown", async () => {
  const scenario = generateScenario(OPTIONS);
  const decoded = await decodeScenario(scenario);
  assert.equal(decoded.length, scenario.events.length);
  for (const event of decoded) {
    assert.notEqual(event.payload.name, "unknown", serialize(event.payload));
  }
});

test("claims and squad markets follow their full lifecycles in order", async () => {
  for (const seed of [1, 7, "mimir"]) {
    const scenario = generateScenario({ ...OPTIONS, seed });
    const decoded = await decodeScenario(scenario);

    const claims = new Map();
    const markets = new Map();
    for (const { payload } of decoded) {
      if (payload.claimId !== undefined) {
        if (!claims.has(payload.claimId)) claims.set(payload.claimId, []);
        claims.get(payload.claimId).push(payload.name);
      } else if (payload.marketId !== undefined) {
        if (!markets.has(payload.marketId)) markets.set(payload.marketId, []);
        markets.get(payload.marketId).push(payload.name);
      }
    }

    assert.equal(claims.size, OPTIONS.claims);
    assert.equal(markets.size, OPTIONS.markets);

    const claimShape =
      /^claim_created( claim_challenged)* (claim_resolved|claim_cancelled) market_settled( challenger_paid)*$/;
    for (const [id, names] of claims) {
      assert.match(names.join(" "), claimShape, `claim ${id}: ${names.join(" ")}`);
      const challenged = names.filter((n) => n === "claim_challenged").length;
      assert.ok(names.filter((n) => n === "challenger_paid").length <= challenged);
    }

    const marketShape = /^market_created( deposited)+( withdrawn)* resolved( claimed)*$/;
    for (const [id, names] of markets) {
      assert.match(names.join(" "), marketShape, `market ${id}: ${names.join(" ")}`);
    }
  }
});
