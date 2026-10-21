/**
 * CLI tool for previewing notification rendering without running poller, RPC or Telegram.
 *
 * Reads a DecodedEvent-shaped JSON document (bigints serialized as strings or numbers)
 * from a file path or from standard input (stdin).
 *
 * Prints MarkdownV2 output of formatEvent, plain-text output of formatPlainTextEvent,
 * and the URL from eventExplorerUrl.
 *
 * Usage:
 *   npx tsx src/render-cli.ts [path/to/event.json] [--format md|plain|both]
 *   cat event.json | npx tsx src/render-cli.ts --format md
 *
 * Exit codes:
 *   0 — success
 *   2 — invalid input (malformed JSON, unknown event name, missing file, invalid format)
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadStellarConfig, type StellarConfig } from "./config.js";
import {
  eventExplorerUrl,
  formatEvent,
  formatPlainTextEvent,
} from "./notifications/format.js";
import type { DecodedEvent, EventPayload } from "./stellar/decode.js";

export type RenderFormat = "md" | "plain" | "both";

export const KNOWN_EVENT_NAMES = new Set([
  // mimir-market
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
  // mimir-squad
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
  // admin / known non-notifying events
  "oracle_changed",
  "ownership_transferred",
  "agent_attributed",
  "fee_accrued",
  "fee_policy_set",
  "fee_policy_changed",
  "fee_policy_updated",
  "fee_policy_removed",
  "admin",
]);

/** Keys in DecodedEvent payloads that represent bigint amounts. */
const BIGINT_KEYS = new Set([
  "stake",
  "totalPaid",
  "totalFees",
  "owedToChallengers",
  "dust",
  "gross",
  "fee",
  "net",
  "amount",
  "shares",
  "poolA",
  "poolB",
]);

export interface RenderCliArgs {
  file?: string;
  format: RenderFormat;
}

export function parseCliArgs(args: readonly string[]): RenderCliArgs {
  let file: string | undefined;
  let format: RenderFormat = "both";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--format") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --format (expected md, plain, or both)");
      }
      if (next !== "md" && next !== "plain" && next !== "both") {
        throw new Error(`Invalid --format: ${next} (expected md, plain, or both)`);
      }
      format = next;
      i++;
    } else if (arg.startsWith("--format=")) {
      const val = arg.slice("--format=".length);
      if (val !== "md" && val !== "plain" && val !== "both") {
        throw new Error(`Invalid --format: ${val} (expected md, plain, or both)`);
      }
      format = val as RenderFormat;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (file !== undefined) {
        throw new Error(`Unexpected argument: ${arg}`);
      }
      file = arg;
    }
  }

  return { file, format };
}

export function hydrateEventJson(rawJson: string): DecodedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid event: JSON root must be an object");
  }

  const obj = parsed as Record<string, unknown>;
  const payload = obj.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid event: missing or invalid payload object");
  }

  const payloadObj = payload as Record<string, unknown>;
  const eventName = payloadObj.name;
  if (typeof eventName !== "string" || !eventName) {
    throw new Error("Invalid event: missing payload.name");
  }

  if (!KNOWN_EVENT_NAMES.has(eventName)) {
    throw new Error(`Unknown event name: ${eventName}`);
  }

  const hydratedPayload: Record<string, unknown> = { ...payloadObj };
  for (const key of BIGINT_KEYS) {
    const val = hydratedPayload[key];
    if (typeof val === "string" && /^-?\d+$/.test(val)) {
      hydratedPayload[key] = BigInt(val);
    } else if (typeof val === "number" && Number.isInteger(val)) {
      hydratedPayload[key] = BigInt(val);
    }
  }

  return {
    ...obj,
    payload: hydratedPayload as unknown as EventPayload,
  } as DecodedEvent;
}

export function getFallbackStellarConfig(): StellarConfig {
  try {
    return loadStellarConfig();
  } catch {
    return {
      network: "testnet",
      marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
      marketContractVersion: "v1",
      squadContractVersion: "v1",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      explorerBaseUrl: "https://stellar.expert/explorer",
    };
  }
}

export function renderEvent(
  config: StellarConfig,
  event: DecodedEvent,
  format: RenderFormat = "both",
): string {
  const mdOutput = formatEvent(config, event);
  const plainOutput = formatPlainTextEvent(config, event);
  const explorerUrl = eventExplorerUrl(config, event);

  const sections: string[] = [];

  if (format === "both") {
    sections.push("=== MarkdownV2 ===");
    sections.push(mdOutput ?? "(no notification)");
    sections.push("");
    sections.push("=== Plain Text ===");
    sections.push(plainOutput ?? "(no notification)");
    sections.push("");
    sections.push("=== Explorer URL ===");
    sections.push(explorerUrl ?? "(none)");
  } else if (format === "md") {
    sections.push(mdOutput ?? "(no notification)");
    if (explorerUrl) {
      sections.push(`Explorer URL: ${explorerUrl}`);
    }
  } else if (format === "plain") {
    sections.push(plainOutput ?? "(no notification)");
    if (explorerUrl) {
      sections.push(`Explorer URL: ${explorerUrl}`);
    }
  }

  return sections.join("\n");
}

export async function runRenderCli(
  argv: readonly string[] = process.argv.slice(2),
  configOverride?: StellarConfig,
): Promise<{ exitCode: number; output?: string; error?: string }> {
  let parsedArgs: RenderCliArgs;
  try {
    parsedArgs = parseCliArgs(argv);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, error };
  }

  let rawContent: string;
  try {
    if (parsedArgs.file) {
      rawContent = readFileSync(parsedArgs.file, "utf8");
    } else {
      rawContent = readFileSync(0, "utf8");
    }
  } catch (err) {
    const error = `Failed to read input: ${err instanceof Error ? err.message : String(err)}`;
    return { exitCode: 2, error };
  }

  let event: DecodedEvent;
  try {
    event = hydrateEventJson(rawContent);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, error };
  }

  const config = configOverride ?? getFallbackStellarConfig();
  const output = renderEvent(config, event, parsedArgs.format);
  return { exitCode: 0, output };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runRenderCli()
    .then((result) => {
      if (result.exitCode !== 0) {
        if (result.error) console.error(result.error);
        process.exit(result.exitCode);
      }
      if (result.output) {
        console.log(result.output);
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
