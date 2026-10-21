export interface ParticipantSummary {
  creators: number;
  challengers: number;
  depositors: number;
  claimers: number;
  total: number;
}

export interface StellarEvent {
  name?: string;
  event?: string;
  type?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

type Role = "creator" | "challenger" | "depositor" | "claimer";

/**
 * Explicit field map per event name. Each entry lists the payload
 * fields that carry addresses for the given role. No reflection is used.
 */
const EVENT_FIELD_MAP: Record<string, Array<{ role: Role; field: string }>> = {
  create_challenge: [
    { role: "creator", field: "creator" },
    { role: "challenger", field: "challenger" },
  ],
  create_contest: [
    { role: "creator", field: "creator" },
  ],
  challenge: [{ role: "challenger", field: "challenger" }],
  deposit: [{ role: "depositor", field: "participant" }],
  deposit_participant: [{ role: "depositor", field: "participant" }],
  claim: [{ role: "claimer", field: "recipient" }],
  claim_reward: [{ role: "claimer", field: "recipient" }],
  claim_captain: [{ role: "claimer", field: "captain" }],
  claim_participant: [{ role: "claimer", field: "participant" }],
};

function eventName(event: StellarEvent): string | undefined {
  if (typeof event.name === "string") return event.name;
  if (typeof event.event === "string") return event.event;
  if (typeof event.type === "string") return event.type;
  return undefined;
}

function payload(event: StellarEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === "object") return event.payload;
  if (event.data && typeof event.data === "object") return event.data;
  return {};
}

function addressFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function participantSummary(events: StellarEvent[]): ParticipantSummary {
  const creators = new Set<string>();
  const challengers = new Set<string>();
  const depositors = new Set<string>();
  const claimers = new Set<string>();
  const overall = new Set<string>();

  const roleSets: Record<Role, Set<string>> = {
    creator: creators,
    challenger: challengers,
    depositor: depositors,
    claimer: claimers,
  };

  if (!Array.isArray(events)) {
    return { creators: 0, challengers: 0, depositors: 0, claimers: 0, total: 0 };
  }

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const name = eventName(event);
    if (!name) continue;
    const mappings = EVENT_FIELD_MAP[name];
    if (!mappings) continue;

    const data = payload(event);
    for (const { role, field } of mappings) {
      const address = addressFrom(data[field]);
      if (!address) continue;
      roleSets[role].add(address);
      overall.add(address);
    }
  }

  return {
    creators: creators.size,
    challengers: challengers.size,
    depositors: depositors.size,
    claimers: claimers.size,
    total: overall.size,
  };
}
