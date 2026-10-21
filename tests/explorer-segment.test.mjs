import assert from "node:assert/strict";
import test from "node:test";

import {
  accountExplorerUrl,
  contractExplorerUrl,
  explorerNetworkSegment,
  txExplorerUrl,
} from "../dist/stellar/client.js";

// Pins which stellar.expert path segment each configured network gets, and the
// URL it produces. URL formats are not changed here; every case asserts exact
// strings as the helpers behave today.

const PUBLIC = "Public Global Stellar Network ; September 2015";
const TESTNET = "Test SDF Network ; September 2015";
const FUTURENET = "Test SDF Future Network ; October 2022";
const STANDALONE = "Standalone Network ; February 2017";
const BASE = "https://stellar.expert/explorer";

const TX = "a".repeat(64);
const ACCOUNT = "G" + "A".repeat(55);
const CONTRACT = "C" + "B".repeat(55);

function config(overrides) {
  return { rpcUrl: "https://example.invalid/rpc", networkPassphrase: TESTNET, ...overrides };
}

const cases = [
  // [label, config, segment, helper, id, url]
  ["network testnet", config({ network: "testnet" }), "testnet", txExplorerUrl, TX, `${BASE}/testnet/tx/${TX}`],
  ["network mainnet", config({ network: "mainnet", networkPassphrase: PUBLIC }), "public", txExplorerUrl, TX, `${BASE}/public/tx/${TX}`],
  ["no network, public passphrase", config({ networkPassphrase: PUBLIC }), "public", accountExplorerUrl, ACCOUNT, `${BASE}/public/account/${ACCOUNT}`],
  ["no network, testnet passphrase", config({}), "testnet", accountExplorerUrl, ACCOUNT, `${BASE}/testnet/account/${ACCOUNT}`],
  ["network futurenet", config({ network: "futurenet", networkPassphrase: FUTURENET }), "testnet", contractExplorerUrl, CONTRACT, `${BASE}/testnet/contract/${CONTRACT}`],
  ["custom network name", config({ network: "custom", networkPassphrase: STANDALONE }), "testnet", contractExplorerUrl, CONTRACT, `${BASE}/testnet/contract/${CONTRACT}`],
  ["no network, standalone passphrase", config({ networkPassphrase: STANDALONE }), "testnet", txExplorerUrl, TX, `${BASE}/testnet/tx/${TX}`],
  // Only the exact lower-case name maps to public; other spellings fall back to testnet.
  ["network Mainnet (mixed case)", config({ network: "Mainnet", networkPassphrase: PUBLIC }), "testnet", txExplorerUrl, TX, `${BASE}/testnet/tx/${TX}`],
  ["network MAINNET (upper case)", config({ network: "MAINNET", networkPassphrase: PUBLIC }), "testnet", accountExplorerUrl, ACCOUNT, `${BASE}/testnet/account/${ACCOUNT}`],
  ["network public", config({ network: "public", networkPassphrase: PUBLIC }), "testnet", contractExplorerUrl, CONTRACT, `${BASE}/testnet/contract/${CONTRACT}`],
  // A configured explorer base keeps the same segment; trailing slashes are trimmed.
  ["custom explorer base", config({ network: "mainnet", networkPassphrase: PUBLIC, explorerBaseUrl: "https://explorer.example/x/" }), "public", txExplorerUrl, TX, `https://explorer.example/x/public/tx/${TX}`],
];

for (const [label, cfg, segment, helper, id, url] of cases) {
  test(`explorerNetworkSegment: ${label}`, () => {
    assert.equal(explorerNetworkSegment(cfg), segment);
    assert.equal(helper(cfg, id), url);
  });
}
