/**
 * In-memory LRU cache storing (chatId, ref) -> messageId with atomic file persistence.
 *
 * Used to remember which Telegram message announced which claim or market so
 * later events can reply to or edit it.
 *
 * Bounded on entries and key/value sizes.
 * Corrupt files on load are moved aside (quarantined) rather than fatal.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MESSAGE_INDEX_CAPACITY = 1000;
export const MESSAGE_INDEX_SCHEMA_VERSION = 1;

/** Bounds on string representations */
export const MAX_CHAT_ID_CHARS = 128;
export const MAX_REF_CHARS = 256;

export type EventRef = `market:${string | number}` | `squad:${string | number}` | string;

export interface MessageIndexFileEntry {
  chatId: string | number;
  ref: string;
  messageId: number;
}

export interface MessageIndexFile {
  version: 1;
  updatedAt: string;
  entries: MessageIndexFileEntry[];
}

export interface MessageIndexOptions {
  /** File path to persist the index. If undefined or null, persistence is disabled. */
  filePath?: string | null;
  /** Maximum number of items to retain in memory and file. Defaults to 1000. */
  capacity?: number;
  /** Optional clock provider for timestamps. */
  now?: () => number;
}

export function indexQuarantinePath(filePath: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${filePath}.corrupt.${stamp}`;
}

export function makeCompoundKey(chatId: string | number, ref: string): string {
  return `${String(chatId)}:::${ref}`;
}

export function isValidRef(ref: unknown): ref is string {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF_CHARS) {
    return false;
  }
  return ref.startsWith("market:") || ref.startsWith("squad:");
}

export function isValidChatId(chatId: unknown): chatId is string | number {
  if (typeof chatId === "number") {
    return Number.isSafeInteger(chatId);
  }
  if (typeof chatId === "string") {
    return chatId.length > 0 && chatId.length <= MAX_CHAT_ID_CHARS;
  }
  return false;
}

export function isValidMessageId(messageId: unknown): messageId is number {
  return typeof messageId === "number" && Number.isSafeInteger(messageId) && messageId > 0;
}

export class MessageIndex {
  readonly capacity: number;
  readonly filePath: string | null;
  private readonly now: () => number;

  /**
   * Map maintains insertion order.
   * Key: makeCompoundKey(chatId, ref)
   * Value: { chatId: string | number, ref: string, messageId: number }
   */
  private readonly entries = new Map<string, { chatId: string | number; ref: string; messageId: number }>();

  constructor(options: MessageIndexOptions = {}) {
    const cap = options.capacity ?? DEFAULT_MESSAGE_INDEX_CAPACITY;
    this.capacity = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : DEFAULT_MESSAGE_INDEX_CAPACITY;
    this.filePath = options.filePath ?? null;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Look up a message ID by chatId and event ref.
   * If found, refreshes LRU recency.
   */
  lookup(chatId: string | number, ref: string): number | undefined {
    if (!isValidChatId(chatId) || !isValidRef(ref)) {
      return undefined;
    }
    const key = makeCompoundKey(chatId, ref);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    // Refresh LRU recency: re-insert at end of Map
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.messageId;
  }

  /**
   * Record a (chatId, ref) -> messageId mapping.
   * Evicts the oldest entry if capacity is reached.
   * Persists changes if filePath is set.
   */
  async record(chatId: string | number, ref: string, messageId: number): Promise<void> {
    if (!isValidChatId(chatId) || !isValidRef(ref) || !isValidMessageId(messageId)) {
      return;
    }
    if (this.capacity === 0) {
      return;
    }

    const key = makeCompoundKey(chatId, ref);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      // Evict oldest (first key in iteration)
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, { chatId, ref, messageId });
    await this.persist();
  }

  /**
   * Forget a (chatId, ref) mapping.
   * Persists changes if filePath is set.
   * Returns true if an entry was removed, false otherwise.
   */
  async forget(chatId: string | number, ref: string): Promise<boolean> {
    if (!isValidChatId(chatId) || !isValidRef(ref)) {
      return false;
    }
    const key = makeCompoundKey(chatId, ref);
    const deleted = this.entries.delete(key);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Move corrupt index file aside to <filePath>.corrupt.<timestamp>.
   */
  async quarantine(reason: string, at: Date = new Date(this.now())): Promise<string | null> {
    if (!this.filePath) return null;
    const dest = indexQuarantinePath(this.filePath, at);
    try {
      await rename(this.filePath, dest);
      console.warn(
        `[message-index] index file unreadable at ${this.filePath}, quarantined to ${dest}: ${reason}`,
      );
      return dest;
    } catch (err) {
      console.warn(
        `[message-index] failed to quarantine corrupt index file ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Load index from disk. Corrupt file is moved aside and an empty index is started.
   */
  async load(): Promise<void> {
    if (!this.filePath) {
      this.entries.clear();
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries.clear();
        return;
      }
      // If unreadable, quarantine and start clean
      await this.quarantine(`cannot read file: ${(err as NodeJS.ErrnoException).message}`);
      this.entries.clear();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await this.quarantine(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      this.entries.clear();
      return;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== MESSAGE_INDEX_SCHEMA_VERSION ||
      !Array.isArray((parsed as Record<string, unknown>).entries)
    ) {
      await this.quarantine("schema validation failed: expected version 1 with entries array");
      this.entries.clear();
      return;
    }

    this.entries.clear();
    const rawEntries = (parsed as MessageIndexFile).entries;
    for (const item of rawEntries) {
      if (
        item &&
        typeof item === "object" &&
        isValidChatId(item.chatId) &&
        isValidRef(item.ref) &&
        isValidMessageId(item.messageId)
      ) {
        const key = makeCompoundKey(item.chatId, item.ref);
        if (this.entries.has(key)) {
          this.entries.delete(key);
        }
        this.entries.set(key, {
          chatId: item.chatId,
          ref: item.ref,
          messageId: item.messageId,
        });
      }
    }

    // Bound to capacity if loaded file had more entries (oldest evicted)
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }

  /**
   * Persist in-memory state to disk atomically (write to temp file then rename).
   */
  async persist(): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const payload: MessageIndexFile = {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      entries: Array.from(this.entries.values()),
    };

    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}-${this.now()}`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error(
        `[message-index] could not persist index to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Return array copy of current entries (oldest to newest) */
  toJSON(): MessageIndexFileEntry[] {
    return Array.from(this.entries.values());
  }
}

/** Convenience factory */
export async function createMessageIndex(options: MessageIndexOptions = {}): Promise<MessageIndex> {
  const index = new MessageIndex(options);
  await index.load();
  return index;
}
