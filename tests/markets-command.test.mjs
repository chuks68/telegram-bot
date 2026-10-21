import test from "node:test";
import assert from "node:assert";
import { openMarketsFromEvents, marketsMessage } from "../src/commands/markets.js";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../src/constants.js";

const NOW = Date.parse("2024-01-01T00:00:00Z");

function created(marketId, question, deadlineIso, feeBasisPoints, ledger = 1) {
  return {
    type: "market_created",
    ledger,
    payload: {
      marketId,
      question,
      deadline: Math.floor(Date.parse(deadlineIso) / 1000),
      feeBasisPoints,
    },
  };
}

function resolved(marketId, ledger = 10) {
  return {
    type: "resolved",
    ledger,
    payload: { marketId },
  };
}

test("openMarketsFromEvents keeps only unresolved markets", () => {
  const events = [
    created("m1", "Will it rain tomorrow?", "2024-01-02T00:00:00Z", 250, 1),
    created("m2", "Will the sun rise?", "2024-01-03T00:00:00Z", 100, 2),
    resolved("m1", 10),
  ];

  const open = openMarketsFromEvents(events);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].marketId, "m2");
  assert.strictEqual(open[0].question, "Will the sun rise?");
});

test("openMarketsFromEvents excludes markets resolved before creation order", () => {
  const events = [
    created("m1", "Question A?", "2024-01-02T00:00:00Z", 250, 1),
    created("m2", "Question B?", "2024-01-03T00:00:00Z", 100, 2),
    resolved("m2", 11),
  ];

  const open = openMarketsFromEvents(events);
  assert.deepEqual(open.map((m) => m.marketId), ["m1"]);
});

test("marketsMessage renders open markets with deadline and fee", () => {
  const markets = openMarketsFromEvents([
    created("m1", "Will it rain?", "2024-01-02T00:00:00Z", 250, 1),
  ]);

  const msg = marketsMessage(markets, NOW);
  assert.matches(msg, /Will it rain\?/);
  assert.matches(msg, /2.5%/);
  assert.matches(msg, /1d/);
});

test("marketsMessage renders past-deadline markets", () => {
  const markets = openMarketsFromEvents([
    created("m1", "Overdue?", "2023-12-31T00:00:00Z", 500, 1),
  ]);

  const msg = marketsMessage(markets, NOW);
  assert.matches(msg, /Overdue\?/);
  assert.matches(msg, /past deadline/i);
});

test("marketsMessage handles empty market list", () => {
  const msg = marketsMessage([], NOW);
  assert.typeOf(msg, "string");
  assert.matches(msg, /no open markets/i);
});

test("marketsMessage truncates to Telegram max length with hidden count", () => {
  const events = [];
  for (let i = 0; i < 200; i++) {
    events.push(
      created(
        `m${i}`,
        `Question number ${i} with a rather long description to force truncation?`,
        "2024-01-02T00:00:00Z",
        250,
        i + 1
      )
    );
  }

  const markets = openMarketsFromEvents(events);
  const msg = marketsMessage(markets, NOW);
  assert.ok(msg.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.matches(msg, /more/i);
});
