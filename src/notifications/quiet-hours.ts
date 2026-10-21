/**
 * Quiet hours notification policy and deferred digest queue.
 *
 * Lets a chat defer low-priority notifications during configured quiet hours
 * (specified as a UTC window) and release them as a digest afterwards.
 *
 * Key components:
 * - `decide(event, policy, now)`: Pure function returning "send" | "defer".
 * - `DeferredQueue`: Bounded in-memory queue with `flushDue(now)` returning
 *   events for `formatDigest`.
 * - Windows crossing midnight (e.g. 22:00 to 06:00 UTC) are fully handled.
 * - Critical events (always-send event names) always pass immediately.
 */

import type { DecodedEvent } from "../stellar/decode.js";
import { formatDigest, type FormatDigestOptions } from "./format.js";

/** Outcome of evaluating an event against quiet hours policy. */
export type QuietHoursDecision = "send" | "defer";

/** Specification of a UTC time window. */
export interface UtcWindow {
  /** Start hour in UTC (0-23), start time "HH:MM", or minutes from midnight. */
  start?: number | string;
  /** End hour in UTC (0-23), end time "HH:MM", or minutes from midnight. */
  end?: number | string;
  /** Explicit start hour (0-23). */
  startHour?: number;
  /** Explicit end hour (0-23). */
  endHour?: number;
  /** Explicit start minute (0-59). */
  startMinute?: number;
  /** Explicit end minute (0-59). */
  endMinute?: number;
  /** Explicit start UTC hour/time. */
  startUtc?: number | string;
  /** Explicit end UTC hour/time. */
  endUtc?: number | string;
}

/** Tuple representation `[start, end]` or object representation of a UTC window. */
export type WindowSpec =
  | UtcWindow
  | [number | string, number | string]
  | { start: number | string; end: number | string };

/** Policy controlling quiet hours deferrals. */
export interface QuietHoursPolicy {
  /** The UTC quiet hours window. */
  window?: WindowSpec;
  /** Alias for `window`. */
  utcWindow?: WindowSpec;
  /** Window start (when specified directly on policy). */
  start?: number | string;
  /** Window end (when specified directly on policy). */
  end?: number | string;
  /** Window start hour (when specified directly on policy). */
  startHour?: number;
  /** Window end hour (when specified directly on policy). */
  endHour?: number;
  /** Window start minute (when specified directly on policy). */
  startMinute?: number;
  /** Window end minute (when specified directly on policy). */
  endMinute?: number;
  /** Window start UTC (when specified directly on policy). */
  startUtc?: number | string;
  /** Window end UTC (when specified directly on policy). */
  endUtc?: number | string;

  /** Set or list of event names that must always be sent immediately (e.g. claim_resolved). */
  alwaysSend?: Iterable<string>;
  /** Alias for `alwaysSend`. */
  alwaysSendEvents?: Iterable<string>;
  /** Alias for `alwaysSend`. */
  alwaysSendEventNames?: Iterable<string>;
  /** Alias for `alwaysSend`. */
  criticalEvents?: Iterable<string>;
}

/** Default set of critical event names that bypass quiet hours. */
export const DEFAULT_ALWAYS_SEND_EVENTS: ReadonlySet<string> = Object.freeze(
  new Set(["claim_resolved", "market_settled", "resolved"]),
);

/**
 * Extract the event name from a DecodedEvent or duck-typed event object.
 */
export function resolveEventName(event: unknown): string {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const obj = event as Record<string, unknown>;
    if (obj.payload && typeof obj.payload === "object") {
      const payload = obj.payload as Record<string, unknown>;
      if (payload.name === "unknown" && typeof payload.eventName === "string") {
        return payload.eventName;
      }
      if (typeof payload.name === "string") {
        return payload.name;
      }
    }
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.eventName === "string") return obj.eventName;
  }
  return "";
}

/**
 * Parse an hour/time value to minutes from UTC midnight [0, 1440).
 */
export function parseTimeToMinutes(val: number | string | undefined, defaultVal = 0): number {
  if (val === undefined || val === null) return defaultVal;

  if (typeof val === "number") {
    // Hour of day 0..24 (including fractional hours like 22.5)
    if (val >= 0 && val <= 24) {
      return (val * 60) % 1440;
    }
    // Minutes from midnight
    return val % 1440;
  }

  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":");
      const h = parseInt(parts[0] ?? "0", 10) || 0;
      const m = parseInt(parts[1] ?? "0", 10) || 0;
      return (h * 60 + m) % 1440;
    }
    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      if (num >= 0 && num <= 24) {
        return (num * 60) % 1440;
      }
      return num % 1440;
    }
  }

  return defaultVal;
}

/**
 * Parse a WindowSpec into normalized start and end minutes from midnight.
 */
export function parseWindow(
  windowSpec?: WindowSpec,
): { startMinutes: number; endMinutes: number } | null {
  if (!windowSpec) return null;

  if (Array.isArray(windowSpec)) {
    const [start, end] = windowSpec;
    return {
      startMinutes: parseTimeToMinutes(start),
      endMinutes: parseTimeToMinutes(end),
    };
  }

  if (typeof windowSpec === "object") {
    const win = windowSpec as UtcWindow;
    let startMin: number | undefined;
    let endMin: number | undefined;

    if (win.startHour !== undefined) {
      startMin = (win.startHour * 60 + (win.startMinute ?? 0)) % 1440;
    } else if (win.startUtc !== undefined) {
      startMin = parseTimeToMinutes(win.startUtc);
    } else if (win.start !== undefined) {
      startMin = parseTimeToMinutes(win.start);
    }

    if (win.endHour !== undefined) {
      endMin = (win.endHour * 60 + (win.endMinute ?? 0)) % 1440;
    } else if (win.endUtc !== undefined) {
      endMin = parseTimeToMinutes(win.endUtc);
    } else if (win.end !== undefined) {
      endMin = parseTimeToMinutes(win.end);
    }

    if (startMin !== undefined && endMin !== undefined) {
      return { startMinutes: startMin, endMinutes: endMin };
    }
  }

  return null;
}

/**
 * Extract the window specification from a policy.
 */
export function extractWindow(
  policy?: QuietHoursPolicy,
): { startMinutes: number; endMinutes: number } | null {
  if (!policy) return null;
  if (policy.window) return parseWindow(policy.window);
  if (policy.utcWindow) return parseWindow(policy.utcWindow);
  return parseWindow(policy as WindowSpec);
}

/**
 * Extract always-send / critical event names from a policy.
 */
export function extractAlwaysSend(policy?: QuietHoursPolicy): Set<string> {
  if (!policy) return new Set();
  const raw =
    policy.alwaysSend ??
    policy.alwaysSendEvents ??
    policy.alwaysSendEventNames ??
    policy.criticalEvents;

  if (!raw) return new Set();
  if (raw instanceof Set) return raw;
  return new Set(raw);
}

/**
 * Check if an event name matches any of the always-send entries (case and hyphen/underscore tolerant).
 */
export function isAlwaysSendEvent(eventName: string, alwaysSend: Set<string>): boolean {
  if (!eventName) return false;
  if (alwaysSend.has(eventName)) return true;
  const lower = eventName.toLowerCase();
  if (alwaysSend.has(lower)) return true;
  if (alwaysSend.has(lower.replace(/_/g, "-"))) return true;
  if (alwaysSend.has(lower.replace(/-/g, "_"))) return true;
  return false;
}

/**
 * Calculate the time of day in UTC minutes [0, 1440) for a given `now`.
 * Supports Date objects, numeric hours / minutes / timestamps, and ISO / time strings.
 */
export function getUtcMinutesOfDay(now?: Date | number | string): number {
  if (now === undefined || now === null) {
    const d = new Date();
    return (
      d.getUTCHours() * 60 +
      d.getUTCMinutes() +
      d.getUTCSeconds() / 60 +
      d.getUTCMilliseconds() / 60000
    );
  }

  if (now instanceof Date) {
    return (
      now.getUTCHours() * 60 +
      now.getUTCMinutes() +
      now.getUTCSeconds() / 60 +
      now.getUTCMilliseconds() / 60000
    );
  }

  if (typeof now === "number") {
    // Hour of day (0..24)
    if (now >= 0 && now < 24) {
      return now * 60;
    }
    // Minutes of day (24..1440)
    if (now >= 24 && now < 1440) {
      return now;
    }
    // Epoch timestamp (seconds or milliseconds)
    const ms = now < 1e11 ? now * 1000 : now;
    const d = new Date(ms);
    return (
      d.getUTCHours() * 60 +
      d.getUTCMinutes() +
      d.getUTCSeconds() / 60 +
      d.getUTCMilliseconds() / 60000
    );
  }

  if (typeof now === "string") {
    const trimmed = now.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      const parts = trimmed.split(":");
      const h = parseInt(parts[0] ?? "0", 10) || 0;
      const m = parseInt(parts[1] ?? "0", 10) || 0;
      const s = parts[2] ? parseInt(parts[2], 10) || 0 : 0;
      return (h * 60 + m + s / 60) % 1440;
    }
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return (
        parsed.getUTCHours() * 60 +
        parsed.getUTCMinutes() +
        parsed.getUTCSeconds() / 60 +
        parsed.getUTCMilliseconds() / 60000
      );
    }
  }

  const d = new Date();
  return (
    d.getUTCHours() * 60 +
    d.getUTCMinutes() +
    d.getUTCSeconds() / 60 +
    d.getUTCMilliseconds() / 60000
  );
}

/**
 * Returns true if `now` falls within the policy's configured quiet hours window.
 * Properly handles windows that cross midnight (e.g. 22:00 to 06:00 UTC).
 */
export function isInQuietHours(policy?: QuietHoursPolicy, now?: Date | number | string): boolean {
  const win = extractWindow(policy);
  if (!win) return false;

  const { startMinutes, endMinutes } = win;
  if (startMinutes === endMinutes) return false;

  const currentMinutes = getUtcMinutesOfDay(now);

  if (startMinutes < endMinutes) {
    // Window does not cross midnight (e.g. 02:00 to 06:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Window crosses midnight (e.g. 22:00 to 06:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Pure decision function: determines whether an event should be sent immediately
 * or deferred into quiet hours digest.
 *
 * Deterministic given `now`:
 * - Critical events (specified in `policy.alwaysSend`) always return "send".
 * - Events occurring during quiet hours return "defer".
 * - All other events return "send".
 */
export function decide(
  event: DecodedEvent | unknown,
  policy: QuietHoursPolicy,
  now: Date | number | string,
): QuietHoursDecision {
  const eventName = resolveEventName(event);
  const alwaysSend = extractAlwaysSend(policy);

  if (isAlwaysSendEvent(eventName, alwaysSend)) {
    return "send";
  }

  if (isInQuietHours(policy, now)) {
    return "defer";
  }

  return "send";
}

/** Options for configuring a DeferredQueue instance. */
export interface DeferredQueueOptions {
  /** Maximum number of events allowed in the queue. Defaults to 1000. */
  maxSize?: number;
  /** Alias for maxSize. */
  capacity?: number;
  /** Optional policy associated with this queue. */
  policy?: QuietHoursPolicy;
}

/**
 * Bounded in-memory queue for deferred notifications.
 *
 * Holds deferred events while quiet hours are active, capping storage at `maxSize`
 * and tracking overflow counts when capacity is reached.
 * Flushes events when quiet hours end (`flushDue(now)`), ready for `formatDigest`.
 */
export class DeferredQueue {
  private _maxSize: number = 1000;
  private _events: DecodedEvent[] = [];
  private _overflowCount: number = 0;
  private _policy?: QuietHoursPolicy;

  constructor(
    arg1?: number | QuietHoursPolicy | DeferredQueueOptions,
    arg2?: number | QuietHoursPolicy,
  ) {
    if (typeof arg1 === "number") {
      this._maxSize = arg1;
      if (arg2 && typeof arg2 === "object") {
        this._policy = arg2 as QuietHoursPolicy;
      }
    } else if (arg1 && typeof arg1 === "object") {
      const opts = arg1 as DeferredQueueOptions & QuietHoursPolicy;
      if (typeof opts.maxSize === "number") {
        this._maxSize = opts.maxSize;
      } else if (typeof opts.capacity === "number") {
        this._maxSize = opts.capacity;
      }

      if (opts.policy) {
        this._policy = opts.policy;
      } else if (
        opts.window ||
        opts.utcWindow ||
        opts.alwaysSend ||
        opts.alwaysSendEvents ||
        opts.startHour !== undefined ||
        opts.start !== undefined
      ) {
        this._policy = opts;
      }

      if (typeof arg2 === "number") {
        this._maxSize = arg2;
      } else if (arg2 && typeof arg2 === "object") {
        this._policy = arg2 as QuietHoursPolicy;
      }
    }
  }

  /** Current number of events waiting in the queue. */
  get size(): number {
    return this._events.length;
  }

  /** Current number of events waiting in the queue (alias for size). */
  get length(): number {
    return this._events.length;
  }

  /** Maximum capacity of the queue. */
  get maxSize(): number {
    return this._maxSize;
  }

  /** Maximum capacity of the queue (alias for maxSize). */
  get capacity(): number {
    return this._maxSize;
  }

  /** Cumulative number of events dropped due to queue capacity overflow. */
  get overflowCount(): number {
    return this._overflowCount;
  }

  /** Cumulative number of events dropped due to queue capacity overflow (alias). */
  get overflows(): number {
    return this._overflowCount;
  }

  /** Cumulative number of events dropped due to queue capacity overflow (alias). */
  get overflow(): number {
    return this._overflowCount;
  }

  /** Cumulative number of events dropped due to queue capacity overflow (alias). */
  get droppedCount(): number {
    return this._overflowCount;
  }

  /** The policy associated with this queue, if any. */
  get policy(): QuietHoursPolicy | undefined {
    return this._policy;
  }

  set policy(policy: QuietHoursPolicy | undefined) {
    this._policy = policy;
  }

  /** Whether the queue is currently empty. */
  isEmpty(): boolean {
    return this._events.length === 0;
  }

  /** Read-only snapshot of events currently in the queue. */
  peek(): readonly DecodedEvent[] {
    return [...this._events];
  }

  /** Array copy of events currently in the queue. */
  toArray(): DecodedEvent[] {
    return [...this._events];
  }

  /**
   * Enqueue a deferred event into the bounded buffer.
   * If the queue is at capacity, the event is dropped and `overflowCount` is incremented.
   * Returns `true` if enqueued, `false` if dropped due to capacity overflow.
   */
  enqueue(event: DecodedEvent): boolean {
    if (this._events.length >= this._maxSize) {
      this._overflowCount++;
      return false;
    }
    this._events.push(event);
    return true;
  }

  /** Alias for `enqueue`. */
  add(event: DecodedEvent): boolean {
    return this.enqueue(event);
  }

  /** Enqueue multiple events into the bounded queue. Returns number of enqueued events. */
  enqueueAll(events: Iterable<DecodedEvent>): number {
    let count = 0;
    for (const event of events) {
      if (this.enqueue(event)) {
        count++;
      }
    }
    return count;
  }

  /** Push multiple events into the queue. */
  push(...events: DecodedEvent[]): number {
    return this.enqueueAll(events);
  }

  /**
   * Unconditionally drain and return all queued events.
   * Resets the queued events list to empty.
   */
  flush(): DecodedEvent[] & { overflowCount: number; overflows: number } {
    const released = [...this._events];
    this._events = [];
    const result = Object.assign(released, {
      overflowCount: this._overflowCount,
      overflows: this._overflowCount,
    });
    return result;
  }

  /**
   * Release deferred events if quiet hours have ended (or if no quiet hours policy is active).
   *
   * When `now` is still within quiet hours, returns an empty array `[]` without modifying the queue.
   * When `now` is outside quiet hours, all queued events are drained and returned for `formatDigest`.
   *
   * Deterministic given `now`.
   */
  flushDue(
    now?: Date | number | string,
    policy?: QuietHoursPolicy,
  ): DecodedEvent[] & { overflowCount: number; overflows: number } {
    const effectivePolicy = policy ?? this._policy;
    if (effectivePolicy && isInQuietHours(effectivePolicy, now)) {
      const empty: DecodedEvent[] = [];
      return Object.assign(empty, {
        overflowCount: this._overflowCount,
        overflows: this._overflowCount,
      });
    }
    return this.flush();
  }

  /**
   * Format queued events into a digest string if quiet hours are due.
   * Convenience helper combining `flushDue(now)` and `formatDigest`.
   */
  flushDigest(
    now?: Date | number | string,
    options?: FormatDigestOptions,
    policy?: QuietHoursPolicy,
  ): string | null {
    const events = this.flushDue(now, policy);
    return formatDigest(events, options);
  }

  /** Clear all events and reset the overflow count. */
  clear(): void {
    this._events = [];
    this._overflowCount = 0;
  }

  /** Reset only the overflow count. Returns the previous overflow count. */
  resetOverflowCount(): number {
    const prev = this._overflowCount;
    this._overflowCount = 0;
    return prev;
  }
}
