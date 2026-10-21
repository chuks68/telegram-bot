export const KNOWN_EVENT_NAMES = [
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
  "oracle_changed",
  "ownership_transferred",
  "agent_attributed",
  "fee_accrued",
  "fee_policy_set",
  "fee_policy_changed",
  "fee_policy_updated",
  "fee_policy_removed",
  "admin",
] as const;

export const DEFAULT_SILENT_EVENTS = [
  "deposited",
  "withdrawn",
  "withdrawal",
  "withdrawal_pending",
  "fee_claimed",
  "fees_claimed",
] as const;

export type EventPriorityPolicy = readonly string[];

export function isSilent(
  event: string,
  policy: EventPriorityPolicy = DEFAULT_SILENT_EVENTS,
): boolean {
  return policy.includes(event);
}