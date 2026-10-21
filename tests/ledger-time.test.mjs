/**
 * Tests for src/stellar/ledger-time.ts
 *
 * Covers:
 *   - same-ledger estimation (delta = 0)
 *   - past ledger estimation (relative to anchor)
 *   - future ledger estimation (relative to anchor)
 *   - custom avgSeconds parameter
 *   - acceptance of various closedAt formats (ISO string, unix epoch seconds, ms, Date)
 *   - rejection of negative or non-integer ledgers with InvalidLedgerError
 *   - rejection of invalid anchors or invalid avgSeconds
 */

import assert from "node:assert/strict";
import test from "node:test";

import { estimateLedgerTime, InvalidLedgerError } from "../dist/stellar/ledger-time.js";

test("estimateLedgerTime: same-ledger estimation returns anchor close time with approximate flag", () => {
  const anchorTime = "2026-10-19T12:00:00.000Z";
  const anchor = { ledger: 1000, closedAt: anchorTime };

  const result = estimateLedgerTime(1000, anchor);
  assert.deepEqual(result, {
    iso: anchorTime,
    approximate: true,
  });
});

test("estimateLedgerTime: future ledger estimation with default 5-second avgSeconds", () => {
  const anchorTime = "2026-10-19T12:00:00.000Z";
  const anchor = { ledger: 1000, closedAt: anchorTime };

  // 10 ledgers in the future = +50 seconds
  const result = estimateLedgerTime(1010, anchor);
  assert.deepEqual(result, {
    iso: "2026-10-19T12:00:50.000Z",
    approximate: true,
  });
});

test("estimateLedgerTime: past ledger estimation with default 5-second avgSeconds", () => {
  const anchorTime = "2026-10-19T12:00:00.000Z";
  const anchor = { ledger: 1000, closedAt: anchorTime };

  // 12 ledgers in the past = -60 seconds
  const result = estimateLedgerTime(988, anchor);
  assert.deepEqual(result, {
    iso: "2026-10-19T11:59:00.000Z",
    approximate: true,
  });
});

test("estimateLedgerTime: custom avgSeconds parameter", () => {
  const anchorTime = "2026-10-19T12:00:00.000Z";
  const anchor = { ledger: 1000, closedAt: anchorTime };

  // avgSeconds = 6.5, 4 ledgers future = +26 seconds
  const result = estimateLedgerTime(1004, anchor, 6.5);
  assert.deepEqual(result, {
    iso: "2026-10-19T12:00:26.000Z",
    approximate: true,
  });
});

test("estimateLedgerTime: supports Date and unix timestamp (seconds and ms) for closedAt", () => {
  const date = new Date("2026-10-19T12:00:00.000Z");
  const anchorDate = { ledger: 1000, closedAt: date };
  assert.equal(estimateLedgerTime(1002, anchorDate, 5).iso, "2026-10-19T12:00:10.000Z");

  const unixSeconds = Math.floor(date.getTime() / 1000);
  const anchorSec = { ledger: 1000, closedAt: unixSeconds };
  assert.equal(estimateLedgerTime(1002, anchorSec, 5).iso, "2026-10-19T12:00:10.000Z");

  const unixMs = date.getTime();
  const anchorMs = { ledger: 1000, closedAt: unixMs };
  assert.equal(estimateLedgerTime(1002, anchorMs, 5).iso, "2026-10-19T12:00:10.000Z");
});

test("estimateLedgerTime: rejects negative or non-integer target ledger with InvalidLedgerError", () => {
  const anchor = { ledger: 1000, closedAt: "2026-10-19T12:00:00.000Z" };

  assert.throws(
    () => estimateLedgerTime(-1, anchor),
    (err) => err instanceof InvalidLedgerError && err.code === "ERR_INVALID_LEDGER",
  );

  assert.throws(
    () => estimateLedgerTime(100.5, anchor),
    (err) => err instanceof InvalidLedgerError && /expected a non-negative integer/.test(err.message),
  );

  assert.throws(
    () => estimateLedgerTime("1000", anchor),
    (err) => err instanceof InvalidLedgerError,
  );

  assert.throws(
    () => estimateLedgerTime(NaN, anchor),
    (err) => err instanceof InvalidLedgerError,
  );

  assert.throws(
    () => estimateLedgerTime(Infinity, anchor),
    (err) => err instanceof InvalidLedgerError,
  );
});

test("estimateLedgerTime: rejects negative or non-integer anchor ledger with InvalidLedgerError", () => {
  assert.throws(
    () => estimateLedgerTime(1000, { ledger: -5, closedAt: "2026-10-19T12:00:00.000Z" }),
    (err) => err instanceof InvalidLedgerError && /anchor\.ledger/.test(err.message),
  );

  assert.throws(
    () => estimateLedgerTime(1000, { ledger: 10.2, closedAt: "2026-10-19T12:00:00.000Z" }),
    (err) => err instanceof InvalidLedgerError && /anchor\.ledger/.test(err.message),
  );
});

test("estimateLedgerTime: rejects invalid anchor or closedAt", () => {
  assert.throws(
    () => estimateLedgerTime(1000, null),
    (err) => err instanceof InvalidLedgerError,
  );

  assert.throws(
    () => estimateLedgerTime(1000, { ledger: 1000, closedAt: "not-a-date" }),
    (err) => err instanceof InvalidLedgerError && /could not parse timestamp/.test(err.message),
  );
});

test("estimateLedgerTime: rejects non-positive or invalid avgSeconds", () => {
  const anchor = { ledger: 1000, closedAt: "2026-10-19T12:00:00.000Z" };

  assert.throws(
    () => estimateLedgerTime(1000, anchor, 0),
    (err) => err instanceof InvalidLedgerError && /avgSeconds/.test(err.message),
  );

  assert.throws(
    () => estimateLedgerTime(1000, anchor, -5),
    (err) => err instanceof InvalidLedgerError && /avgSeconds/.test(err.message),
  );

  assert.throws(
    () => estimateLedgerTime(1000, anchor, NaN),
    (err) => err instanceof InvalidLedgerError && /avgSeconds/.test(err.message),
  );
});
