import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAdminRecord,
  sanitizeField,
  MAX_ADMIN_FORMAT_LENGTH,
} from "../dist/notifications/admin.js";
import { shortAddress } from "../dist/stellar/decode.js";

const MOCK_ORACLE_ADDR = "GBZXN7PIRZGNMHGA72XZQCLCJH5I6D25GI5AO5AGNDJTCX7754YNOUTZ";
const MOCK_PREV_OWNER = "GD6W5V5G5S6DGB3M46X4B6F7B2U67WJ5C3S2E3M46X4B6F7B2U67WJ5C";
const MOCK_NEW_OWNER = "GA2W5V5G5S6DGB3M46X4B6F7B2U67WJ5C3S2E3M46X4B6F7B2U67WJ5A";
const MOCK_CONTRACT = "CA2W5V5G5S6DGB3M46X4B6F7B2U67WJ5C3S2E3M46X4B6F7B2U67WJ5A";
const MOCK_AGENT = MOCK_ORACLE_ADDR;
const MOCK_TX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("shortens addresses with shortAddress and sanitizes fields", () => {
  const shortened = sanitizeField(MOCK_ORACLE_ADDR);
  assert.equal(shortened, shortAddress(MOCK_ORACLE_ADDR));
  assert.ok(shortened.includes("…"));

  const contractShortened = sanitizeField(MOCK_CONTRACT);
  assert.equal(contractShortened, shortAddress(MOCK_CONTRACT));
});

test("formatAdminRecord: covers oracle_changed", () => {
  const record = {
    type: "oracle_changed",
    ledger: 123456,
    at: 1724000000,
    transactionHash: MOCK_TX,
    contractId: MOCK_CONTRACT,
    admin: MOCK_ORACLE_ADDR,
    explorerUrl: `https://stellar.expert/explorer/public/tx/${MOCK_TX}`,
    details: {
      newOracle: MOCK_ORACLE_ADDR,
    },
  };

  const formatted = formatAdminRecord(record);
  assert.match(formatted, /\[admin\] oracle_changed/);
  assert.match(formatted, /ledger 123456/);
  assert.match(formatted, /tx: https:\/\/stellar\.expert/);
  assert.match(formatted, /admin=GBZXN…OUTZ/);
  assert.match(formatted, /newOracle=GBZXN…OUTZ/);
  assert.doesNotMatch(formatted, /undefined/);
});

test("formatAdminRecord: covers ownership_transferred", () => {
  const record = {
    type: "ownership_transferred",
    ledger: 123457,
    at: 1724000010,
    transactionHash: MOCK_TX,
    admin: MOCK_NEW_OWNER,
    details: {
      previousOwner: MOCK_PREV_OWNER,
      newOwner: MOCK_NEW_OWNER,
    },
  };

  const formatted = formatAdminRecord(record);
  assert.match(formatted, /\[admin\] ownership_transferred/);
  assert.match(formatted, /ledger 123457/);
  assert.match(formatted, /tx: 012345/);
  assert.match(formatted, /admin=GA2W5…WJ5A/);
  assert.match(formatted, /previousOwner=GD6W5…WJ5C/);
  assert.match(formatted, /newOwner=GA2W5…WJ5A/);
  assert.doesNotMatch(formatted, /undefined/);
});

test("formatAdminRecord: covers fee_policy_* events", () => {
  const eventNames = [
    "fee_policy_set",
    "fee_policy_changed",
    "fee_policy_updated",
    "fee_policy_removed",
  ];

  for (const name of eventNames) {
    const record = {
      type: name,
      ledger: 123458,
      at: 1724000020,
      transactionHash: MOCK_TX,
      admin: MOCK_NEW_OWNER,
      details: {
        category: "crypto",
        feeBps: 150,
      },
    };

    const formatted = formatAdminRecord(record);
    assert.match(formatted, new RegExp(`\\[admin\\] ${name}`));
    assert.match(formatted, /ledger 123458/);
    assert.match(formatted, /category=crypto/);
    assert.match(formatted, /feeBps=150/);
    assert.doesNotMatch(formatted, /undefined/);
  }
});

test("formatAdminRecord: covers fee_accrued", () => {
  const record = {
    type: "fee_accrued",
    ledger: 123459,
    at: 1724000030,
    contractId: MOCK_CONTRACT,
    admin: MOCK_NEW_OWNER,
    details: {
      amount: "50000000",
    },
  };

  const formatted = formatAdminRecord(record);
  assert.match(formatted, /\[admin\] fee_accrued/);
  assert.match(formatted, /ledger 123459/);
  assert.match(formatted, /contract=CA2W5…WJ5A/);
  assert.match(formatted, /amount=50000000/);
  assert.doesNotMatch(formatted, /undefined/);
});

test("formatAdminRecord: covers agent_attributed", () => {
  const record = {
    type: "agent_attributed",
    ledger: 123460,
    at: 1724000040,
    admin: MOCK_AGENT,
    details: {
      agent: MOCK_AGENT,
    },
  };

  const formatted = formatAdminRecord(record);
  assert.match(formatted, /\[admin\] agent_attributed/);
  assert.match(formatted, /ledger 123460/);
  assert.ok(formatted.includes(`admin=${shortAddress(MOCK_AGENT)}`));
  assert.ok(formatted.includes(`agent=${shortAddress(MOCK_AGENT)}`));
  assert.doesNotMatch(formatted, /undefined/);
});

test("formatAdminRecord: missing optional fields are omitted, not printed as undefined", () => {
  const record = {
    type: "oracle_changed",
    ledger: 123461,
    at: 1724000050,
    // transactionHash, contractId, admin, explorerUrl are omitted
    details: {
      optionalA: undefined,
      optionalB: null,
      definedVal: "test",
    },
  };

  const formatted = formatAdminRecord(record);
  assert.equal(formatted, "[admin] oracle_changed · ledger 123461 | definedVal=test");
  assert.doesNotMatch(formatted, /undefined/);
  assert.doesNotMatch(formatted, /null/);
  assert.doesNotMatch(formatted, /tx:/);
  assert.doesNotMatch(formatted, /admin=/);
  assert.doesNotMatch(formatted, /contract=/);
});

test("formatAdminRecord: output length is bounded", () => {
  const hugeDetails = {};
  for (let i = 0; i < 50; i++) {
    hugeDetails[`key_${i}`] = "A".repeat(100);
  }

  const record = {
    type: "oracle_changed",
    ledger: 123462,
    at: 1724000060,
    details: hugeDetails,
  };

  const formatted = formatAdminRecord(record, 200);
  assert.ok(formatted.length <= 200);
  assert.ok(formatted.endsWith("…"));

  const defaultFormatted = formatAdminRecord(record);
  assert.ok(defaultFormatted.length <= MAX_ADMIN_FORMAT_LENGTH);
});

test("formatAdminRecord: sanitises and redacts sensitive tokens in fields", () => {
  const secretKey = "S" + "A".repeat(55);
  const record = {
    type: "oracle_changed",
    ledger: 123463,
    at: 1724000070,
    details: {
      secretLeak: secretKey,
      normalField: "normal",
    },
  };

  const formatted = formatAdminRecord(record);
  assert.doesNotMatch(formatted, new RegExp(secretKey));
  assert.match(formatted, /secretLeak=\[REDACTED\]/);
});
