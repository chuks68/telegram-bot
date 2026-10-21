// src/notifications/pagination.js
// JavaScript version of pagination utilities for test imports.

import { InlineKeyboard } from "grammy";

const CALLBACK_VERSION = "v1";
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
export function paginate(items, pageSize) {
  if (pageSize <= 0) throw new Error("pageSize must be greater than zero");
  const pages = [];
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize));
  }
  return pages;
}
export function encodePaginationCallback(kind, page) {
  return `pg:${CALLBACK_VERSION}:${kind}:${page}`;
}
export function parsePaginationCallback(raw) {
  if (typeof raw !== "string") return null;
  if (Buffer.byteLength(raw, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;
  const parts = raw.split(":");
  if (parts.length !== 4) return null;
  const [prefix, version, kind, pageStr] = parts;
  if (prefix !== "pg" || version !== CALLBACK_VERSION) return null;
  const page = Number(pageStr);
  if (!Number.isInteger(page) || page < 0) return null;
  return { kind, page };
}
export function pageKeyboard(kind, page, pages) {
  const keyboard = new InlineKeyboard();
  const hasPrev = page > 0;
  const hasNext = page < pages - 1;
  if (hasPrev) {
    keyboard.text("◀ Prev", encodePaginationCallback(kind, page - 1));
  }
  if (hasNext) {
    if (hasPrev) keyboard.row();
    keyboard.text("Next ▶", encodePaginationCallback(kind, page + 1));
  }
  return keyboard;
}
