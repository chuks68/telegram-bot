/**
 * Interactive developer REPL preloaded with decoder, formatter, mock constants,
 * sample config, and fixture events.
 *
 * Designed to speed up exploration of Soroban payloads and Telegram notification
 * formatting during development without requiring .env credentials or network access.
 *
 * Usage:
 *   npx tsx src/dev/repl.ts
 *   node dist/dev/repl.js
 */

import fs from "node:fs";
import path from "node:path";
import repl from "node:repl";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StellarConfig } from "../config.js";
import type { DecodedEvent } from "../stellar/decode.js";
import type { MockEventInput } from "../stellar/mock-rpc.js";

// Ensure decode-stats.js exists in dist/ if running from compiled dist
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDecodeStats = path.resolve(currentDir, "../stellar/decode-stats.js");
if (!fs.existsSync(distDecodeStats)) {
  try {
    fs.mkdirSync(path.dirname(distDecodeStats), { recursive: true });
    fs.writeFileSync(distDecodeStats, "export function recordDecodeOutcome() {}\n");
  } catch {
    // Ignore if dist/ is read-only or not present
  }
}

import * as decode from "../stellar/decode.js";
import * as format from "../notifications/format.js";
import * as mockConstants from "../stellar/mock-constants.js";
import { defaultMockScenario } from "../stellar/mock-rpc.js";

// @ts-ignore untyped mjs test fixtures
import * as fixtures from "../../tests/fixtures/events.mjs";

/** Sample StellarConfig configured for offline mock exploration. */
export const sampleConfig: StellarConfig & { version: string; botToken: string; chatId: string } = {
  network: "testnet",
  marketContractId: mockConstants.MOCK_MARKET_CONTRACT_ID,
  squadContractId: mockConstants.MOCK_SQUAD_CONTRACT_ID,
  marketContractVersion: "v1",
  squadContractVersion: "v1",
  rpcUrl: `http://127.0.0.1:${mockConstants.MOCK_RPC_DEFAULT_PORT}`,
  horizonUrl: `http://127.0.0.1:${mockConstants.MOCK_RPC_DEFAULT_PORT}/horizon`,
  networkPassphrase: mockConstants.MOCK_NETWORK_PASSPHRASE,
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  version: "0.1.0",
  botToken: mockConstants.MOCK_BOT_TOKEN,
  chatId: mockConstants.MOCK_CHAT_ID,
};

function unwrapMockValue(val: unknown): unknown {
  if (val && typeof val === "object") {
    if ("address" in val) return (val as { address: string }).address;
    if ("symbol" in val) return (val as { symbol: string }).symbol;
    if ("bytes" in val) return (val as { bytes: string }).bytes;
  }
  return val;
}

function camelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert a MockEventInput from defaultMockScenario into a fully typed DecodedEvent.
 */
export function scenarioEventToDecoded(
  input: MockEventInput,
  overrides: Record<string, unknown> = {},
): DecodedEvent {
  const source = input.source ?? "market";
  const contractId =
    input.contractId ??
    (source === "squad"
      ? mockConstants.MOCK_SQUAD_CONTRACT_ID
      : mockConstants.MOCK_MARKET_CONTRACT_ID);
  const name = input.eventName;

  const topics = input.topics ?? [];
  const fields = input.fields ?? {};

  const payload: Record<string, unknown> = { name };

  if (name === "claim_created") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
    payload.creator =
      unwrapMockValue(topics[1]) ??
      "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
    payload.category = unwrapMockValue(fields.category) ?? "crypto";
    if (fields.title) payload.title = unwrapMockValue(fields.title);
  } else if (name === "claim_challenged") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
    payload.challenger =
      unwrapMockValue(topics[1]) ??
      "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";
    payload.stake = unwrapMockValue(fields.stake) ?? 20_000_000n;
  } else if (name === "claim_resolved") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
    payload.winnerSide = unwrapMockValue(fields.winner_side) ?? 2;
    payload.summary =
      unwrapMockValue(fields.summary) ??
      "On-chain smoke: challengers awarded so the payout pull can be exercised";
    payload.confidence = unwrapMockValue(fields.confidence) ?? 100;
    payload.evidenceHash =
      unwrapMockValue(fields.evidence_hash) ?? "deadbeef".repeat(8);
  } else if (name === "claim_cancelled") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
  } else if (name === "market_settled") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
    payload.totalPaid = unwrapMockValue(fields.total_paid) ?? 18_000_000n;
    payload.totalFees = unwrapMockValue(fields.total_fees) ?? 1_000_000n;
    payload.owedToChallengers =
      unwrapMockValue(fields.owed_to_challengers) ?? 17_000_000n;
    payload.dust = unwrapMockValue(fields.dust) ?? 0n;
  } else if (name === "challenger_paid") {
    payload.claimId = unwrapMockValue(topics[0]) ?? 7;
    payload.challenger =
      unwrapMockValue(topics[1]) ??
      "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";
    payload.stake = unwrapMockValue(fields.stake) ?? 20_000_000n;
    payload.gross = unwrapMockValue(fields.gross) ?? 17_000_000n;
    payload.fee = unwrapMockValue(fields.fee) ?? 850_000n;
    payload.net = unwrapMockValue(fields.net) ?? 16_150_000n;
  } else if (name === "market_created") {
    payload.marketId = unwrapMockValue(topics[0]) ?? 5;
    payload.captain =
      unwrapMockValue(topics[1]) ??
      "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
    payload.deadline = unwrapMockValue(fields.deadline) ?? 1_893_456_000;
    payload.feeBps = unwrapMockValue(fields.fee_bps) ?? 100;
    payload.question =
      unwrapMockValue(fields.question) ?? "Will Mimir settle its first claim on-chain?";
  } else if (name === "deposited") {
    payload.marketId = unwrapMockValue(topics[0]) ?? 5;
    payload.side = unwrapMockValue(topics[1]) ?? 1;
    payload.participant =
      unwrapMockValue(topics[2]) ??
      "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
    payload.amount = unwrapMockValue(fields.amount) ?? 50_000_000n;
    payload.shares = unwrapMockValue(fields.shares) ?? 50_000_000n;
  } else if (name === "withdrawn") {
    payload.marketId = unwrapMockValue(topics[0]) ?? 5;
    payload.side = unwrapMockValue(topics[1]) ?? 1;
    payload.participant =
      unwrapMockValue(topics[2]) ??
      "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
    payload.amount = unwrapMockValue(fields.amount) ?? 10_000_000n;
  } else if (name === "resolved") {
    payload.marketId = unwrapMockValue(topics[0]) ?? 5;
    payload.result = unwrapMockValue(fields.result) ?? 1;
    payload.poolA = unwrapMockValue(fields.pool_a) ?? 60_000_000n;
    payload.poolB = unwrapMockValue(fields.pool_b) ?? 40_000_000n;
  } else if (name === "claimed") {
    payload.marketId = unwrapMockValue(topics[0]) ?? 5;
    payload.participant =
      unwrapMockValue(topics[1]) ??
      "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
    payload.gross = unwrapMockValue(fields.gross) ?? 55_000_000n;
    payload.fee = unwrapMockValue(fields.fee) ?? 2_750_000n;
    payload.net = unwrapMockValue(fields.net) ?? 52_250_000n;
  } else {
    for (const [k, v] of Object.entries(fields)) {
      payload[k] = unwrapMockValue(v);
    }
  }

  // Apply overrides to payload
  Object.assign(payload, overrides);

  const ledger =
    typeof overrides.ledger === "number" ? overrides.ledger : input.ledger;
  const txHash =
    typeof overrides.txHash === "string"
      ? overrides.txHash
      : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  return {
    source,
    contractId: (overrides.contractId as string) ?? contractId,
    version: "v1",
    ledger,
    txHash,
    at: 1700000000 + ledger * 5,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: payload as any,
  };
}

/**
 * Render a formatted Telegram notification for an event from the in-process mock scenario.
 *
 * @param name Event name (e.g. "claim_created", "market_created", "claim_challenged")
 * @param overrides Optional field overrides to customize the rendered notification
 * @returns MarkdownV2 formatted notification string
 */
export function render(name: string, overrides: Record<string, unknown> = {}): string {
  const scenario = defaultMockScenario();
  const eventInput = scenario.events.find((e) => e.eventName === name);
  let decoded: DecodedEvent;

  if (eventInput) {
    decoded = scenarioEventToDecoded(eventInput, overrides);
  } else {
    // Check if fixtures has a builder for this name
    const fixtureFnName = `${camelCase(name)}Event`;
    const fixtureFn = (fixtures as Record<string, any>)[fixtureFnName];
    if (typeof fixtureFn === "function") {
      const source =
        name.startsWith("squad") ||
        name === "deposited" ||
        name === "withdrawn" ||
        name === "resolved" ||
        name === "claimed" ||
        name === "fees_claimed"
          ? "squad"
          : "market";
      try {
        const raw = fixtureFn(overrides);
        decoded = decode.decodeEvent(source, raw);
        Object.assign(decoded.payload, overrides);
      } catch {
        decoded = scenarioEventToDecoded(
          { source, ledger: 1000, eventName: name, fields: overrides as any },
          overrides,
        );
      }
    } else {
      const source = name.startsWith("squad") ? "squad" : "market";
      decoded = scenarioEventToDecoded(
        { source, ledger: 1000, eventName: name, fields: overrides as any },
        overrides,
      );
    }
  }

  const rendered = format.formatEvent(sampleConfig, decoded);
  if (rendered) return rendered;

  const plain = format.formatPlainTextEvent(sampleConfig, decoded);
  if (plain) return plain;

  return `[event "${name}" decoded, but does not emit a Telegram notification]`;
}

/**
 * Scan and decode n events from the in-process mock scenario.
 *
 * @param n Number of events to scan (defaults to all events in scenario)
 * @returns Array of DecodedEvent objects
 */
export function scan(n?: number): DecodedEvent[] {
  const scenario = defaultMockScenario();
  const count =
    typeof n === "number" && n > 0
      ? Math.min(n, scenario.events.length)
      : scenario.events.length;
  const slice = scenario.events.slice(0, count);

  const decodedEvents = slice.map((e) => scenarioEventToDecoded(e));

  for (const e of decodedEvents) {
    const p = e.payload as any;
    const name = p.name;
    const id = "claimId" in p ? `#${p.claimId}` : "marketId" in p ? `#${p.marketId}` : "";
    console.log(`[ledger ${e.ledger}] ${e.source}: ${name}${id ? ` ${id}` : ""}`);
  }

  return decodedEvents;
}

export function help(): string {
  return [
    "Mimir Developer REPL",
    "Preloaded context:",
    "  - decode: decodeEvent, formatUsdc, USDC_UNIT, shortAddress",
    "  - format: formatEvent, formatPlainTextEvent, escapeMd, eventExplorerUrl",
    "  - mockConstants: MOCK_MARKET_CONTRACT_ID, MOCK_SQUAD_CONTRACT_ID, etc.",
    "  - config / sampleConfig: offline StellarConfig",
    "  - fixtures / events: synthetic event builders (claimCreatedEvent, etc.)",
    "  - scenario: defaultMockScenario()",
    "Helpers:",
    "  - render(name, overrides?): renders Telegram notification for mock event",
    "  - scan(n?): decodes and logs first n events from mock scenario",
  ].join("\n");
}

/**
 * Start the preloaded REPL session.
 */
export function startRepl(options: repl.ReplOptions = {}): repl.REPLServer {
  const r = repl.start({
    prompt: "mimir> ",
    useColors: true,
    ...options,
  });

  Object.assign(r.context, {
    decode,
    decodeEvent: decode.decodeEvent,
    formatUsdc: decode.formatUsdc,
    USDC_UNIT: decode.USDC_UNIT,
    shortAddress: decode.shortAddress,

    format,
    formatEvent: format.formatEvent,
    formatPlainTextEvent: format.formatPlainTextEvent,
    escapeMd: format.escapeMd,
    eventExplorerUrl: format.eventExplorerUrl,

    mockConstants,
    MOCK_MARKET_CONTRACT_ID: mockConstants.MOCK_MARKET_CONTRACT_ID,
    MOCK_SQUAD_CONTRACT_ID: mockConstants.MOCK_SQUAD_CONTRACT_ID,
    MOCK_RPC_DEFAULT_PORT: mockConstants.MOCK_RPC_DEFAULT_PORT,
    MOCK_NETWORK_PASSPHRASE: mockConstants.MOCK_NETWORK_PASSPHRASE,
    MOCK_BOT_TOKEN: mockConstants.MOCK_BOT_TOKEN,
    MOCK_CHAT_ID: mockConstants.MOCK_CHAT_ID,
    MOCK_CURSOR_FILE: mockConstants.MOCK_CURSOR_FILE,
    MOCK_PROFILE_NAME: mockConstants.MOCK_PROFILE_NAME,

    config: sampleConfig,
    sampleConfig,

    fixtures,
    events: fixtures,

    scenario: defaultMockScenario(),
    defaultMockScenario,

    render,
    scan,
    help,
  });

  for (const [key, val] of Object.entries(fixtures)) {
    r.context[key] = val;
  }

  return r;
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === pathToFileURL(invokedPath).href ||
    import.meta.url === pathToFileURL(path.resolve(invokedPath)).href)
) {
  startRepl();
}
