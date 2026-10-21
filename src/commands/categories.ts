/**
 * Claim categories message builder and bounded category counter.
 *
 * Tracks category values seen in delivered `claim_created` events and formats
 * them for Telegram in MarkdownV2:
 * - Bounded memory: maximum distinct categories tracked with eviction.
 * - Sanitised and escaped category strings.
 * - Sorted by count (descending) then name (ascending).
 * - Capped list length.
 * - Marks categories filtered out by configuration.
 */

import { escapeMd } from "../notifications/format.js";
import type { BotConfig } from "../config.js";
import type { DecodedEvent } from "../stellar/decode.js";

/** Default ceiling on tracked distinct categories in memory. */
export const DEFAULT_MAX_CATEGORIES = 256;

/** Default maximum number of categories rendered in the message. */
export const DEFAULT_MAX_LIST_LENGTH = 20;

/** Maximum character length permitted for a category name. */
export const MAX_CATEGORY_NAME_LENGTH = 100;

/** Minimal configuration shape required to check category filters. */
export type CategoriesConfig = Partial<Pick<BotConfig, "notificationCategories">>;

/** Options for customizing message generation. */
export interface CategoriesMessageOptions {
  /** Maximum number of categories to display before capping. */
  maxListLength?: number;
}

/** Configuration options for CategoryCounter. */
export interface CategoryCounterOptions {
  /** Maximum distinct categories to keep in memory. Defaults to 256. */
  maxCategories?: number;
  /** Optional bot configuration providing notification category filters. */
  config?: CategoriesConfig;
}

/** Entry representing a tracked category with occurrence count. */
export interface CategoryEntry {
  name: string;
  count: number;
}

/**
 * Sanitizes an untrusted category string:
 * - Strips ASCII control characters and bidirectional override characters.
 * - Trims leading/trailing whitespace and collapses whitespace runs.
 * - Enforces a maximum character length without splitting Unicode code points.
 */
export function sanitizeCategory(
  raw: unknown,
  maxLength: number = MAX_CATEGORY_NAME_LENGTH,
): string {
  if (typeof raw !== "string") return "";
  // Strip control characters (\x00-\x1F, \x7F) and bidi overrides
  const stripped = raw
    .replace(/[\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (stripped.length === 0) return "";
  const chars = Array.from(stripped);
  return chars.length <= maxLength ? stripped : chars.slice(0, maxLength).join("");
}

interface StoredCategory {
  name: string;
  count: number;
  lastUpdated: number;
}

/**
 * In-memory bounded counter for categories seen from delivered claim_created events.
 *
 * Guarantees bounded memory:
 * - Input strings are sanitised and truncated to a bounded length.
 * - Distinct category count is capped; when full, lowest-count entries are evicted.
 * - Does not persist counts to disk (out of scope).
 */
export class CategoryCounter {
  private readonly counts = new Map<string, StoredCategory>();
  private readonly maxCategories: number;
  public config?: CategoriesConfig | undefined;
  private sequence = 0;

  constructor(options: CategoryCounterOptions = {}) {
    this.maxCategories =
      typeof options.maxCategories === "number" && options.maxCategories > 0
        ? options.maxCategories
        : DEFAULT_MAX_CATEGORIES;
    this.config = options.config;
  }

  /**
   * Records a category from a raw string or an extracted `claim_created` event.
   *
   * @param categoryOrEvent category name string or DecodedEvent
   * @returns `true` if a category was successfully counted; `false` otherwise
   */
  record(categoryOrEvent: unknown): boolean {
    let rawCategory: unknown = categoryOrEvent;

    // Extract category if a DecodedEvent object was passed
    if (typeof categoryOrEvent === "object" && categoryOrEvent !== null && "payload" in categoryOrEvent) {
      const event = categoryOrEvent as DecodedEvent;
      if (event.payload.name === "claim_created") {
        rawCategory = event.payload.category;
      } else {
        return false;
      }
    }

    const sanitized = sanitizeCategory(rawCategory);
    if (!sanitized) return false;

    const key = sanitized.toLowerCase();
    const existing = this.counts.get(key);

    if (existing) {
      existing.count += 1;
      existing.lastUpdated = ++this.sequence;
      return true;
    }

    // Capacity bound check
    if (this.counts.size >= this.maxCategories) {
      this.evictLowest();
    }

    this.counts.set(key, {
      name: sanitized,
      count: 1,
      lastUpdated: ++this.sequence,
    });
    return true;
  }

  /** Records delivered claim_created event explicitly. */
  recordDelivered(event: DecodedEvent): boolean {
    return this.record(event);
  }

  /** Retrieves the count for a given category (case-insensitive). */
  get(category: string): number {
    const key = sanitizeCategory(category).toLowerCase();
    return this.counts.get(key)?.count ?? 0;
  }

  /** True if the category has been seen. */
  has(category: string): boolean {
    const key = sanitizeCategory(category).toLowerCase();
    return this.counts.has(key);
  }

  /** Current number of distinct categories tracked. */
  get size(): number {
    return this.counts.size;
  }

  /** Total number of category events recorded. */
  get total(): number {
    let sum = 0;
    for (const entry of this.counts.values()) {
      sum += entry.count;
    }
    return sum;
  }

  /** Returns all entries as [name, count] pairs. */
  entries(): [string, number][] {
    return Array.from(this.counts.values(), (e) => [e.name, e.count]);
  }

  /** Returns an object mapping category name to count. */
  countsRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const entry of this.counts.values()) {
      record[entry.name] = entry.count;
    }
    return record;
  }

  /** Clears all stored category counts. */
  clear(): void {
    this.counts.clear();
    this.sequence = 0;
  }

  /**
   * Returns top categories sorted by count (descending) then name (ascending).
   */
  top(limit?: number): CategoryEntry[] {
    const items = Array.from(this.counts.values(), (e) => ({
      name: e.name,
      count: e.count,
    }));

    items.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.name.localeCompare(b.name);
    });

    return typeof limit === "number" && limit >= 0 ? items.slice(0, limit) : items;
  }

  /** Evicts the entry with the lowest count, breaking ties by oldest lastUpdated. */
  private evictLowest(): void {
    let candidateKey: string | null = null;
    let lowestCount = Infinity;
    let oldestSeq = Infinity;

    for (const [key, entry] of this.counts.entries()) {
      if (
        entry.count < lowestCount ||
        (entry.count === lowestCount && entry.lastUpdated < oldestSeq)
      ) {
        candidateKey = key;
        lowestCount = entry.count;
        oldestSeq = entry.lastUpdated;
      }
    }

    if (candidateKey !== null) {
      this.counts.delete(candidateKey);
    }
  }
}

/** Factory function for creating a CategoryCounter. */
export function createCategoryCounter(
  options?: CategoryCounterOptions,
): CategoryCounter {
  return new CategoryCounter(options);
}

/** Shape of inputs accepted by categoriesMessage. */
export type CategoryCounterInput =
  | CategoryCounter
  | Map<string, number>
  | Record<string, number>
  | Iterable<[string, number]>;

/**
 * Extracts and sorts normalized category entries from various counter representations.
 */
function extractEntries(counter: CategoryCounterInput): CategoryEntry[] {
  if (counter instanceof CategoryCounter) {
    return counter.top();
  }

  const entries: CategoryEntry[] = [];
  if (counter instanceof Map || Symbol.iterator in Object(counter)) {
    const iterable = counter as Iterable<[string, number]>;
    for (const [rawName, count] of iterable) {
      const name = sanitizeCategory(rawName);
      if (name && typeof count === "number" && count > 0) {
        entries.push({ name, count });
      }
    }
  } else if (typeof counter === "object" && counter !== null) {
    for (const [rawName, count] of Object.entries(counter)) {
      const name = sanitizeCategory(rawName);
      if (name && typeof count === "number" && count > 0) {
        entries.push({ name, count });
      }
    }
  }

  // Sort by count descending, then name ascending
  entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.name.localeCompare(b.name);
  });

  return entries;
}

/**
 * Builds a Telegram MarkdownV2 message listing seen claim categories.
 *
 * Requirements:
 * - Sorts by count then name.
 * - Caps the list length (default: 20).
 * - Marks categories currently filtered out by configuration.
 * - Sanitises and escapes all dynamic values with escapeMd.
 *
 * @param counter Bounded CategoryCounter, Map, Record, or iterable of entries
 * @param config Optional bot config with notificationCategories filter
 * @param options Display options such as maxListLength
 */
export function categoriesMessage(
  counter: CategoryCounterInput,
  config?: CategoriesConfig,
  options?: CategoriesMessageOptions,
): string {
  const effectiveConfig =
    config ?? (counter instanceof CategoryCounter ? counter.config : undefined);
  const maxListLength = options?.maxListLength ?? DEFAULT_MAX_LIST_LENGTH;

  const entries = extractEntries(counter);
  const lines: string[] = ["*Claim Categories*", ""];

  if (entries.length === 0) {
    lines.push("No claim categories recorded yet\\.");
    return lines.join("\n");
  }

  // Determine active category allowlist if configured
  const allowedCategories = effectiveConfig?.notificationCategories ?? [];
  const filterActive = allowedCategories.length > 0;
  const allowedSet = new Set(
    allowedCategories.map((c) => c.trim().toLowerCase()),
  );

  const displayed = entries.slice(0, maxListLength);
  const remaining = entries.length - displayed.length;

  for (const entry of displayed) {
    const isFiltered =
      filterActive && !allowedSet.has(entry.name.toLowerCase());
    const filterSuffix = isFiltered ? " \\(filtered\\)" : "";
    lines.push(`• \`${escapeMd(entry.name)}\`: ${entry.count}${filterSuffix}`);
  }

  if (remaining > 0) {
    lines.push("");
    lines.push(`_…and ${remaining} more_`);
  }

  return lines.join("\n");
}
