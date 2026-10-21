// src/notifications/pagination.ts
// Utilities for paginating list‑style replies and generating inline keyboards.
// The implementation is deliberately lightweight and does not depend on any
// runtime state other than the parameters passed in.

import { InlineKeyboard } from "grammy";

/** Version identifier for the pagination callback payload. */
const CALLBACK_VERSION = "v1" as const;

/** Maximum byte size for any Telegram callback_data payload. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Chunk an array of items into pages of a given size.
 *
 * @param items   The full list of items to paginate.
 * @param pageSize Number of items per page (must be > 0).
 * @returns An array where each element is the slice of items for that page.
 */
export function paginate<T>(items: readonly T[], pageSize: number): T[][] {
  if (pageSize <= 0) throw new Error("pageSize must be greater than zero");
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize));
  }
  return pages;
}

/**
 * Encode pagination callback data.
 *
 * The format is `pg:<version>:<kind>:<page>` where:
 *   - `pg` is a short prefix to avoid collisions with existing payloads.
 *   - `<version>` allows future structural changes.
 *   - `<kind>` identifies the list being paginated (e.g. "claims").
 *   - `<page>` is a 0‑based page index.
 *
 * The resulting string is guaranteed to be ASCII and well under the 64‑byte
 * limit.
 */
export function encodePaginationCallback(kind: string, page: number): string {
  return `pg:${CALLBACK_VERSION}:${kind}:${page}`;
}

/**
 * Parse a pagination callback string.
 * Returns an object with `kind` and `page` if parsing succeeds and the payload
 * is within size limits; otherwise returns `null`.
 */
export function parsePaginationCallback(
  raw: unknown,
): { kind: string; page: number } | null {
  if (typeof raw !== "string") return null;
  if (Buffer.byteLength(raw, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;
  const parts = raw.split(":");
  // Expected: ["pg", version, kind, page]
  if (parts.length !== 4) return null;
  const [prefix, version, kind, pageStr] = parts;
  if (prefix !== "pg" || version !== CALLBACK_VERSION) return null;
  if (!pageStr || !kind) return null;
  const page = Number(pageStr);
  if (!Number.isInteger(page) || page < 0) return null;
  return { kind, page };
}

/**
 * Build an inline keyboard for pagination.
 *
 * @param kind   Identifier for the list type (passed to the callback encoder).
 * @param page   Current 0‑based page index.
 * @param pages  Total number of pages.
 * @returns InlineKeyboard with "Prev" / "Next" buttons where applicable.
 */
export function pageKeyboard(
  kind: string,
  page: number,
  pages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const hasPrev = page > 0;
  const hasNext = page < pages - 1;

  if (hasPrev) {
    keyboard.text("◀ Prev", encodePaginationCallback(kind, page - 1));
  }
  if (hasNext) {
    // Add a new row if we already added a Prev button for better layout.
    if (hasPrev) keyboard.row();
    keyboard.text("Next ▶", encodePaginationCallback(kind, page + 1));
  }
  return keyboard;
}
