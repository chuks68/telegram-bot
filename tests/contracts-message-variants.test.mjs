import assert from "node:assert/strict";
import test from "node:test";

import { contractsMessage } from "../dist/bot.js";

const MARKET_ID = "C".padEnd(56, "M");
const SQUAD_ID = "C".padEnd(56, "S");

function fakeConfig(overrides = {}) {
  return {
    botToken: "MOCK_UNLEAKED_SAMPLE",
    chatIds: ["-1001234567890"],
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    ...overrides,
  };
}

test("contractsMessage renders market-only configuration exactly when squad contract is not configured", () => {
  const config = fakeConfig({ squadContractId: "" });
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar testnet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market* \\(v1\\)\n" +
      `\`${MARKET_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${MARKET_ID})\n` +
      "\n" +
      "*mimir\\-squad* \\(v1\\)\n" +
      "``\n" +
      "[View on stellar\\.expert]()",
  );
  assert.doesNotMatch(message, /MOCK_UNLEAKED_SAMPLE/);
});

test("contractsMessage renders squad-only configuration exactly when market contract is not configured", () => {
  const config = fakeConfig({ marketContractId: "" });
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar testnet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market* \\(v1\\)\n" +
      "``\n" +
      "[View on stellar\\.expert]()\n" +
      "\n" +
      "*mimir\\-squad* \\(v1\\)\n" +
      `\`${SQUAD_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${SQUAD_ID})`,
  );
  assert.doesNotMatch(message, /MOCK_UNLEAKED_SAMPLE/);
});

test("contractsMessage renders with custom STELLAR_EXPLORER_BASE_URL", () => {
  const customExplorer = "https://custom.explorer.stellar.org/subpath";
  const config = fakeConfig({
    explorerBaseUrl: customExplorer,
  });
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar testnet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market* \\(v1\\)\n" +
      `\`${MARKET_ID}\`\n` +
      `[View on stellar\\.expert](${customExplorer}/testnet/contract/${MARKET_ID})\n` +
      "\n" +
      "*mimir\\-squad* \\(v1\\)\n" +
      `\`${SQUAD_ID}\`\n` +
      `[View on stellar\\.expert](${customExplorer}/testnet/contract/${SQUAD_ID})`,
  );
  assert.doesNotMatch(message, /https:\/\/stellar\.expert/);
  assert.doesNotMatch(message, /MOCK_UNLEAKED_SAMPLE/);
});

test("contractsMessage renders with a named network (futurenet)", () => {
  const config = fakeConfig({
    network: "futurenet",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  });
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar futurenet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market* \\(v1\\)\n" +
      `\`${MARKET_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${MARKET_ID})\n` +
      "\n" +
      "*mimir\\-squad* \\(v1\\)\n" +
      `\`${SQUAD_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${SQUAD_ID})`,
  );
  assert.doesNotMatch(message, /MOCK_UNLEAKED_SAMPLE/);
});

test("contractsMessage renders with a named network (mainnet) and custom explorer base URL", () => {
  const customExplorer = "https://custom.explorer.stellar.org";
  const config = fakeConfig({
    network: "mainnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    explorerBaseUrl: customExplorer,
  });
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar mainnet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market* \\(v1\\)\n" +
      `\`${MARKET_ID}\`\n` +
      `[View on stellar\\.expert](${customExplorer}/public/contract/${MARKET_ID})\n` +
      "\n" +
      "*mimir\\-squad* \\(v1\\)\n" +
      `\`${SQUAD_ID}\`\n` +
      `[View on stellar\\.expert](${customExplorer}/public/contract/${SQUAD_ID})`,
  );
  assert.doesNotMatch(message, /MOCK_UNLEAKED_SAMPLE/);
});

test("contractsMessage does not leak any secrets in output across variants", () => {
  const canaryValue = "CANARY_VALUE_THAT_MUST_NEVER_APPEAR_IN_OUTPUT";
  const configs = [
    fakeConfig({ botToken: canaryValue, squadContractId: "" }),
    fakeConfig({ botToken: canaryValue, marketContractId: "" }),
    fakeConfig({ botToken: canaryValue, explorerBaseUrl: "https://explorer.example.com" }),
    fakeConfig({ botToken: canaryValue, network: "futurenet" }),
    fakeConfig({ botToken: canaryValue, network: "mainnet" }),
  ];

  for (const cfg of configs) {
    const message = contractsMessage(cfg);
    assert.doesNotMatch(message, new RegExp(canaryValue));
  }
});
