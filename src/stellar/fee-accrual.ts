/**
 * Protocol fee accrual tracking from admin events.
 *
 * Aggregates `fee_accrued` admin events into per-recipient and per-contract totals
 * for operator reporting.
 *
 * Invariants:
 * - Non-admin events are ignored.
 * - Admin events that are not `fee_accrued` are ignored.
 * - Missing amounts are counted separately rather than treated as zero.
 * - Bigint totals throughout to avoid precision loss on atomic USDC amounts.
 * - Deterministic ordering for all output collections.
 */

import type {
  AdminPayload,
  DecodedEvent,
  EventPayload,
  FeeAccruedPayload,
} from "./decode.js";

/** Check if a payload represents a decoded admin event. */
export function isAdminPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { name?: unknown };
  if (typeof p.name !== "string") return false;
  if (p.name === "admin") return true;
  if (
    p.name === "oracle_changed" ||
    p.name === "ownership_transferred" ||
    p.name === "agent_attributed" ||
    p.name === "fee_accrued" ||
    p.name === "fee_policy_set" ||
    p.name === "fee_policy_changed" ||
    p.name === "fee_policy_updated" ||
    p.name === "fee_policy_removed"
  ) {
    return true;
  }
  return p.name.startsWith("fee_policy_") || p.name.startsWith("admin_");
}

export interface RecipientAccrual {
  recipient: string;
  address: string;
  total: bigint;
  amount: bigint;
  totalAmount: bigint;
  count: number;
  eventCount: number;
  eventsCount: number;
  validAmountCount: number;
  missingAmountCount: number;
  missingAmount: number;
  missingAmounts: number;
  contracts: string[];
}

export interface ContractAccrual {
  contractId: string;
  contract: string;
  total: bigint;
  amount: bigint;
  totalAmount: bigint;
  count: number;
  eventCount: number;
  eventsCount: number;
  validAmountCount: number;
  missingAmountCount: number;
  missingAmount: number;
  missingAmounts: number;
  recipients: string[];
}

export type LookupArray<T> = T[] & { get(key: string): T | undefined };

export interface FeeAccrualReport {
  total: bigint;
  totalAmount: bigint;
  count: number;
  totalEvents: number;
  validAmountCount: number;
  missingAmountCount: number;
  missingAmount: number;
  missingAmounts: number;
  eventsMissingAmount: number;
  missingRecipientCount: number;
  missingContractCount: number;
  recipients: RecipientAccrual[];
  contracts: ContractAccrual[];
  topRecipients: RecipientAccrual[];
  topContracts: ContractAccrual[];
  byRecipient: LookupArray<RecipientAccrual>;
  byContract: LookupArray<ContractAccrual>;
  byRecipientMap: Map<string, RecipientAccrual>;
  byContractMap: Map<string, ContractAccrual>;
}

export type FeeAccrualEvent =
  | DecodedEvent
  | { payload: FeeAccruedPayload | AdminPayload | EventPayload | unknown; contractId?: string }
  | FeeAccruedPayload
  | unknown;

function parseAmount(val: unknown): { hasAmount: boolean; amount: bigint } {
  if (val === undefined || val === null) {
    return { hasAmount: false, amount: 0n };
  }
  if (typeof val === "bigint") {
    if (val >= 0n) return { hasAmount: true, amount: val };
    return { hasAmount: false, amount: 0n };
  }
  if (typeof val === "number") {
    if (Number.isSafeInteger(val) && val >= 0) {
      return { hasAmount: true, amount: BigInt(val) };
    }
    return { hasAmount: false, amount: 0n };
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        return { hasAmount: true, amount: BigInt(trimmed) };
      } catch {
        return { hasAmount: false, amount: 0n };
      }
    }
  }
  return { hasAmount: false, amount: 0n };
}

function extractPayloadAndContract(event: unknown): {
  payload: unknown;
  contractId?: string;
} {
  if (!event || typeof event !== "object") {
    return { payload: null };
  }

  const rec = event as Record<string, unknown>;
  const contractId =
    typeof rec.contractId === "string" && rec.contractId.trim().length > 0
      ? rec.contractId.trim()
      : typeof rec.contract === "string" && rec.contract.trim().length > 0
        ? rec.contract.trim()
        : undefined;

  if ("payload" in rec && rec.payload && typeof rec.payload === "object") {
    const payloadRec = rec.payload as Record<string, unknown>;
    const payloadContractId =
      typeof payloadRec.contractId === "string" && payloadRec.contractId.trim().length > 0
        ? payloadRec.contractId.trim()
        : typeof payloadRec.contract === "string" && payloadRec.contract.trim().length > 0
          ? payloadRec.contract.trim()
          : undefined;

    return {
      payload: rec.payload,
      contractId: contractId ?? payloadContractId,
    };
  }

  return {
    payload: event,
    contractId,
  };
}

function makeLookupArray<T>(
  items: T[],
  getKey: (item: T) => string,
): LookupArray<T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(getKey(item), item);
  }
  const arr = items.slice() as LookupArray<T>;
  arr.get = (key: string) => map.get(key);
  return arr;
}

/**
 * Aggregate fee_accrued admin events into per-recipient and per-contract totals.
 *
 * @param events Collection of raw or decoded Stellar events.
 * @returns Structured fee accrual report with deterministic ordering.
 */
export function feeAccrual(
  events?: Iterable<FeeAccrualEvent> | readonly FeeAccrualEvent[] | null,
): FeeAccrualReport {
  interface RecipientAccumulator {
    recipient: string;
    total: bigint;
    count: number;
    validAmountCount: number;
    missingAmountCount: number;
    contracts: Set<string>;
  }

  interface ContractAccumulator {
    contractId: string;
    total: bigint;
    count: number;
    validAmountCount: number;
    missingAmountCount: number;
    recipients: Set<string>;
  }

  let totalAmount = 0n;
  let totalEvents = 0;
  let missingAmountCount = 0;
  let missingRecipientCount = 0;
  let missingContractCount = 0;

  const recipientMap = new Map<string, RecipientAccumulator>();
  const contractMap = new Map<string, ContractAccumulator>();

  if (events && (Array.isArray(events) || typeof (events as any)[Symbol.iterator] === "function")) {
    for (const rawEvent of events as Iterable<FeeAccrualEvent>) {
      if (!rawEvent || typeof rawEvent !== "object") continue;

      const { payload, contractId } = extractPayloadAndContract(rawEvent);
      if (!payload || typeof payload !== "object") continue;

      // Acceptance criterion: Non-admin events are ignored.
      if (!isAdminPayload(payload)) continue;

      const p = payload as Record<string, unknown>;
      // Only fee_accrued events represent protocol fee accrual.
      if (p.name !== "fee_accrued") continue;

      totalEvents += 1;

      const { hasAmount, amount } = parseAmount(p.amount);
      if (hasAmount) {
        totalAmount += amount;
      } else {
        missingAmountCount += 1;
      }

      const rawRecipient =
        typeof p.recipient === "string" && p.recipient.trim().length > 0
          ? p.recipient.trim()
          : typeof p.to === "string" && p.to.trim().length > 0
            ? p.to.trim()
            : undefined;

      if (rawRecipient) {
        let acc = recipientMap.get(rawRecipient);
        if (!acc) {
          acc = {
            recipient: rawRecipient,
            total: 0n,
            count: 0,
            validAmountCount: 0,
            missingAmountCount: 0,
            contracts: new Set<string>(),
          };
          recipientMap.set(rawRecipient, acc);
        }
        acc.count += 1;
        if (hasAmount) {
          acc.total += amount;
          acc.validAmountCount += 1;
        } else {
          acc.missingAmountCount += 1;
        }
        if (contractId) {
          acc.contracts.add(contractId);
        }
      } else {
        missingRecipientCount += 1;
      }

      if (contractId) {
        let acc = contractMap.get(contractId);
        if (!acc) {
          acc = {
            contractId,
            total: 0n,
            count: 0,
            validAmountCount: 0,
            missingAmountCount: 0,
            recipients: new Set<string>(),
          };
          contractMap.set(contractId, acc);
        }
        acc.count += 1;
        if (hasAmount) {
          acc.total += amount;
          acc.validAmountCount += 1;
        } else {
          acc.missingAmountCount += 1;
        }
        if (rawRecipient) {
          acc.recipients.add(rawRecipient);
        }
      } else {
        missingContractCount += 1;
      }
    }
  }

  // Deterministic ordering:
  // recipients: alphabetical by recipient address
  const recipientsList: RecipientAccrual[] = Array.from(recipientMap.values())
    .map((r) => ({
      recipient: r.recipient,
      address: r.recipient,
      total: r.total,
      amount: r.total,
      totalAmount: r.total,
      count: r.count,
      eventCount: r.count,
      eventsCount: r.count,
      validAmountCount: r.validAmountCount,
      missingAmountCount: r.missingAmountCount,
      missingAmount: r.missingAmountCount,
      missingAmounts: r.missingAmountCount,
      contracts: Array.from(r.contracts).sort(),
    }))
    .sort((a, b) => a.recipient.localeCompare(b.recipient));

  // contracts: alphabetical by contractId
  const contractsList: ContractAccrual[] = Array.from(contractMap.values())
    .map((c) => ({
      contractId: c.contractId,
      contract: c.contractId,
      total: c.total,
      amount: c.total,
      totalAmount: c.total,
      count: c.count,
      eventCount: c.count,
      eventsCount: c.count,
      validAmountCount: c.validAmountCount,
      missingAmountCount: c.missingAmountCount,
      missingAmount: c.missingAmountCount,
      missingAmounts: c.missingAmountCount,
      recipients: Array.from(c.recipients).sort(),
    }))
    .sort((a, b) => a.contractId.localeCompare(b.contractId));

  // topRecipients: sorted by total descending, ties broken by recipient ascending
  const topRecipients: RecipientAccrual[] = recipientsList.slice().sort((a, b) => {
    if (b.total !== a.total) {
      return b.total > a.total ? 1 : -1;
    }
    return a.recipient.localeCompare(b.recipient);
  });

  // topContracts: sorted by total descending, ties broken by contractId ascending
  const topContracts: ContractAccrual[] = contractsList.slice().sort((a, b) => {
    if (b.total !== a.total) {
      return b.total > a.total ? 1 : -1;
    }
    return a.contractId.localeCompare(b.contractId);
  });

  const byRecipient = makeLookupArray(recipientsList, (r) => r.recipient);
  const byContract = makeLookupArray(contractsList, (c) => c.contractId);

  const byRecipientMap = new Map<string, RecipientAccrual>();
  for (const r of recipientsList) {
    byRecipientMap.set(r.recipient, r);
  }

  const byContractMap = new Map<string, ContractAccrual>();
  for (const c of contractsList) {
    byContractMap.set(c.contractId, c);
  }

  return {
    total: totalAmount,
    totalAmount,
    count: totalEvents,
    totalEvents,
    validAmountCount: totalEvents - missingAmountCount,
    missingAmountCount,
    missingAmount: missingAmountCount,
    missingAmounts: missingAmountCount,
    eventsMissingAmount: missingAmountCount,
    missingRecipientCount,
    missingContractCount,
    recipients: recipientsList,
    contracts: contractsList,
    topRecipients,
    topContracts,
    byRecipient,
    byContract,
    byRecipientMap,
    byContractMap,
  };
}
