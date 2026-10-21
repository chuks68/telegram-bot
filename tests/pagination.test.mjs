// tests/pagination.test.mjs
import { describe, it, expect } from "@jest/globals";
import {
  paginate,
  encodePaginationCallback,
  parsePaginationCallback,
  pageKeyboard,
} from "../src/notifications/pagination.js";
import { InlineKeyboard } from "grammy";

/** Helper to extract callback data from InlineKeyboard buttons */
function getButtonData(keyboard) {
  return keyboard.inline_keyboard?.flat().map((b) => b.callback_data);
}

describe("paginate", () => {
  it("splits items into correct page sizes", () => {
    const items = [1, 2, 3, 4, 5];
    const pages = paginate(items, 2);
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("throws on non‑positive pageSize", () => {
    expect(() => paginate([1, 2], 0)).toThrow();
  });
});

describe("encodePaginationCallback", () => {
  it("produces a string under 64 bytes", () => {
    const data = encodePaginationCallback("claims", 0);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    expect(data).toMatch(/^pg:v1:claims:0$/);
  });
});

describe("parsePaginationCallback", () => {
  it("parses valid payload", () => {
    const raw = encodePaginationCallback("markets", 2);
    const parsed = parsePaginationCallback(raw);
    expect(parsed).toEqual({ kind: "markets", page: 2 });
  });
  it("rejects malformed strings", () => {
    expect(parsePaginationCallback("invalid")) .toBeNull();
    expect(parsePaginationCallback("pg:v2:claims:0")) .toBeNull(); // wrong version
    expect(parsePaginationCallback("pg:v1:claims:-1")) .toBeNull(); // negative page
  });
  it("rejects overly long payloads", () => {
    const long = "pg:" + "v1:" + "x".repeat(100) + ":0";
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(64);
    expect(parsePaginationCallback(long)).toBeNull();
  });
});

describe("pageKeyboard", () => {
  const kind = "leaderboard";
  it("omits Prev on first page", () => {
    const kb = pageKeyboard(kind, 0, 3);
    const data = getButtonData(kb);
    expect(data).toEqual([encodePaginationCallback(kind, 1)]);
  });
  it("omits Next on last page", () => {
    const kb = pageKeyboard(kind, 2, 3);
    const data = getButtonData(kb);
    expect(data).toEqual([encodePaginationCallback(kind, 1)]);
  });
  it("shows both on middle page", () => {
    const kb = pageKeyboard(kind, 1, 3);
    const data = getButtonData(kb);
    expect(data).toEqual([
      encodePaginationCallback(kind, 0),
      encodePaginationCallback(kind, 2),
    ]);
  });
});
