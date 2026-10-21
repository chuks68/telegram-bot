import assert from "node:assert/strict";
import test from "node:test";

import { validateContractId } from "../dist/stellar/client.js";
import * as mockConstants from "../dist/stellar/mock-constants.js";

test("every exported mock contract id passes validateContractId", () => {
  const contractIdEntries = Object.entries(mockConstants).filter(([name]) =>
    name.toLowerCase().includes("contract_id"),
  );

  assert.ok(
    contractIdEntries.length > 0,
    "at least one contract id constant must be exported",
  );

  for (const [name, contractId] of contractIdEntries) {
    try {
      validateContractId(contractId, name);
    } catch (err) {
      assert.fail(`Constant ${name} failed validateContractId: ${err.message}`);
    }
  }
});

test("every exported mock account address starts with G and has length 56", () => {
  const accountEntries = Object.entries(mockConstants).filter(([name]) =>
    name.toLowerCase().includes("address") || name.toLowerCase().includes("account_id"),
  );

  for (const [name, address] of accountEntries) {
    assert.equal(
      typeof address,
      "string",
      `Constant ${name} must be a string; got ${typeof address}`,
    );
    assert.ok(
      address.startsWith("G"),
      `Constant ${name} must start with 'G'; got ${address}`,
    );
    assert.equal(
      address.length,
      56,
      `Constant ${name} must have length 56; got length ${address.length}`,
    );
  }
});

test("market and squad mock ids differ", () => {
  assert.ok(
    mockConstants.MOCK_MARKET_CONTRACT_ID,
    "MOCK_MARKET_CONTRACT_ID must be defined",
  );
  assert.ok(
    mockConstants.MOCK_SQUAD_CONTRACT_ID,
    "MOCK_SQUAD_CONTRACT_ID must be defined",
  );
  assert.notEqual(
    mockConstants.MOCK_MARKET_CONTRACT_ID,
    mockConstants.MOCK_SQUAD_CONTRACT_ID,
    "MOCK_MARKET_CONTRACT_ID and MOCK_SQUAD_CONTRACT_ID must differ",
  );
});

