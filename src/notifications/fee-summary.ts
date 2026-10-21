import type { MarketPayload, SquadFeesClaimedPayload } from "../stellar/decode.js";
import { formatUsdc, shortAddress } from "../stellar/decode.js";
import { escapeMd } from "./format.js";

export interface FeeEvent {
  contractId?: string;
  recipient?: string;
  amount: bigint;
  kind: "market" | "squad";
}

export interface FeeSummary {
  total: bigint;
  byContract: Array<{ contractId: string; total: bigint }>;
  byRecipient: Array<{ recipient: string; total: bigint }>;
  count: number;
}

export type FeeEventInput =
  | { kind: "market"; payload: MarketPayload }
  | { kind: "squad"; payload: SquadFeesClaimedPayload }
  | FeeEvent;

function toBigInt(value: bigint | string | number | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  const trimmed = value.trim();
  if (trimmed === "") return 0n;
  try {
    return BigInt(trimmed);
  } catch {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return 0n;
    return BigInt(Math.trunc(parsed));
  }
}

function normalizeEvent(event: FeeEventInput): FeeEvent {
  if ("payload" in event) {
    const payload = event.payload as any;
    const contractId =
      typeof payload.contractId === "string"
        ? payload.contractId
        : typeof payload.contractIds === "string"
          ? payload.contractIds
          : undefined;
    const recipient =
      typeof payload.recipient === "string"
        ? payload.recipient
        : typeof payload.to === "string"
          ? payload.to
          : undefined;
    const amount = payload.amount ?? payload.fees ?? payload.total ?? 0n;
    return {
      kind: event.kind,
      contractId,
      recipient,
      amount: toBigInt(amount),
    };
  }
  return {
    kind: event.kind,
    contractId: event.contractId,
    recipient: event.recipient,
    amount: toBigInt(event.amount as bigint | string | number),
  };
}

export function summarizeFees(events: FeeEventInput[]): FeeSummary {
  const byContractMap = new Map<string, bigint>();
  const byRecipientMap = new Map<string, bigint>();
  let total = 0n;
  let count = 0;

  for (const raw of events) {
    const event = normalizeEvent(raw);
    const amount = toBigInt(event.amount);
    total += amount;
    count += 1;

    if (event.contractId) {
      byContractMap.set(
        event.contractId,
        (byContractMap.get(event.contractId) ?? 0n) + amount,
      );
    }
    if (event.recipient) {
      byRecipientMap.set(
        event.recipient,
        (byRecipientMap.get(event.recipient) ?? 0n) + amount,
      );
    }
  }

  const byContract = Array.from(byContractMap.entries())
    .map(([contractId, total]) => ({ contractId, total }))
    .sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));

  const byRecipient = Array.from(byRecipientMap.entries())
    .map(([recipient, total]) => ({ recipient, total }))
    .sort((a, b) => (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0));

  return { total, byContract, byRecipient, count };
}

export function feeSummaryMessage(summary: FeeSummary): string {
  const lines: string[] = [];
  lines.push("**Fee summary**");

  if (summary.count === 0 || summary.total === 0n) {
    lines.push("No fees in window.");
    return lines.join("\n");
  }

  lines.push(`\**Total:\** ${escapeMd(formatUsdc(summary.total))}`);
  lines.push(`\**Events:\** ${escapeMd(String(summary.count))}`);

  if (summary.byContract.length > 0) {
    lines.push("");
    lines.push("**By contract:**");
    for (const entry of summary.byContract) {
      lines.push(
        `- ${escapeMd(shortAddress(entry.contractId))}: ${escapeMd(formatUsdc(entry.total))}`,
      );
    }
  }

  if (summary.byRecipient.length > 0) {
    lines.push("");
    lines.push("**By recipient:**");
    for (const entry of summary.byRecipient) {
      lines.push(
        `- ${escapeMd(shortAddress(entry.recipient))}: ${escapeMd(formatUsdc(entry.total))}`,
      );
    }
  }

  return lines.join("\n");
}
