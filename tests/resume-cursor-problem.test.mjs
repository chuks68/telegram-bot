/**
 * Tests for Issue #462: classify resume cursor problems with fixtures.
 *
 * Covers:
 *   - Table-driven classification of cursors against the retained ledger window
 *   - Synthetic cursors generated via makeDrillCursor
 *   - Boundary classifications: floor, floor - 1, tip, tip + 1
 *   - Unreadable / malformed cursors: must return null (forwarded, never falsely marked stale)
 *   - Integration with existing repository cursor fixtures (cursor-valid.json, cursor-stale.json, cursor-corrupt.txt)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeDrillCursor } from "../dist/drill.js";
import { eventCursorLedger, resumeCursorProblem } from "../dist/stellar/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

// Reference window for table-driven boundary tests
const WINDOW = { oldestLedger: 1000, latestLedger: 2000 };

// ── Table-driven suite: Valid & Boundary Cursors ─────────────────────────────

const BOUNDARY_CASES = [
  {
    name: "valid cursor inside retained window",
    cursor: makeDrillCursor(1500, 0),
    expectedLedger: 1500,
    expectedProblem: null,
    rationale: "cursor between floor and tip is accepted with no problem",
  },
  {
    name: "cursor older than retention window",
    cursor: makeDrillCursor(500, 0),
    expectedLedger: 500,
    expectedProblem: "cursor-before-floor",
    rationale: "cursor strictly below floor is classified as stale to trigger recovery",
  },
  {
    name: "cursor ahead of RPC tip",
    cursor: makeDrillCursor(2500, 0),
    expectedLedger: 2500,
    expectedProblem: "cursor-after-tip",
    rationale: "cursor strictly above tip is impossible on-chain and rejected before RPC call",
  },
  {
    name: "exact oldest retained ledger (floor boundary)",
    cursor: makeDrillCursor(1000, 0),
    expectedLedger: 1000,
    expectedProblem: null,
    rationale: "exact floor is valid and must not trigger rewind",
  },
  {
    name: "oldest retained ledger minus one (off-by-one below floor)",
    cursor: makeDrillCursor(999, 0),
    expectedLedger: 999,
    expectedProblem: "cursor-before-floor",
    rationale: "one ledger below floor must be recognized as stale",
  },
  {
    name: "exact latest ledger (tip boundary)",
    cursor: makeDrillCursor(2000, 0),
    expectedLedger: 2000,
    expectedProblem: null,
    rationale: "exact tip is valid and accepted",
  },
  {
    name: "latest ledger plus one (off-by-one above tip)",
    cursor: makeDrillCursor(2001, 0),
    expectedLedger: 2001,
    expectedProblem: "cursor-after-tip",
    rationale: "one ledger above tip is impossible on-chain and rejected before RPC call",
  },
  {
    name: "valid cursor with maximum 32-bit index boundary",
    cursor: makeDrillCursor(1500, 4294967295),
    expectedLedger: 1500,
    expectedProblem: null,
    rationale: "maximum allowed 32-bit index within ledger is accepted",
  },
];

for (const c of BOUNDARY_CASES) {
  test(`table: ${c.name}`, () => {
    const ledger = eventCursorLedger(c.cursor);
    assert.equal(
      ledger,
      c.expectedLedger,
      `eventCursorLedger(${c.cursor}) should equal ${c.expectedLedger} (${c.rationale})`,
    );

    const problem = resumeCursorProblem(c.cursor, WINDOW);
    assert.equal(
      problem,
      c.expectedProblem,
      `resumeCursorProblem(${c.cursor}, WINDOW) should equal ${c.expectedProblem} (${c.rationale})`,
    );
  });
}

// ── Table-driven suite: Malformed & Unreadable Cursors ───────────────────────

const MALFORMED_CASES = [
  {
    name: "empty string",
    cursor: "",
    rationale: "empty string cannot be parsed; treated as opaque",
  },
  {
    name: "non-numeric string",
    cursor: "not-a-cursor",
    rationale: "opaque token forwarded to RPC to preserve forward compatibility",
  },
  {
    name: "bare number with no index separator",
    cursor: "4294967296",
    rationale: "missing dash delimiter is rejected by TOID regex",
  },
  {
    name: "delimiter with missing TOID part",
    cursor: "-1",
    rationale: "missing TOID segment yields null",
  },
  {
    name: "delimiter with missing index part",
    cursor: "100-",
    rationale: "missing index segment yields null",
  },
  {
    name: "delimiter with extra trailing parts",
    cursor: "100-1-extra",
    rationale: "more than two segments rejected by regex",
  },
  {
    name: "non-decimal characters in TOID",
    cursor: "0x1A-0",
    rationale: "hexadecimal notation is not allowed",
  },
  {
    name: "oversized TOID exceeding MAX_UINT64",
    cursor: "18446744073709551616-0",
    rationale: "TOID values exceeding 2^64 - 1 are rejected",
  },
  {
    name: "oversized index exceeding MAX_UINT32",
    cursor: "4294967296-4294967296",
    rationale: "index values exceeding 2^32 - 1 are rejected",
  },
  {
    name: "oversized string length guard",
    cursor: `${"9".repeat(25)}-0`,
    rationale: "toidText longer than 20 characters is rejected",
  },
];

for (const c of MALFORMED_CASES) {
  test(`table: malformed cursor — ${c.name}`, () => {
    const ledger = eventCursorLedger(c.cursor);
    assert.equal(
      ledger,
      null,
      `eventCursorLedger("${c.cursor}") must be null for malformed tokens`,
    );

    // Unreadable cursors must return null, NOT "cursor-before-floor" or "cursor-after-tip".
    // Opacity matters: only provably out-of-bounds cursors are classified as problems.
    const problem = resumeCursorProblem(c.cursor, WINDOW);
    assert.equal(
      problem,
      null,
      `resumeCursorProblem("${c.cursor}") must be null for unreadable cursors (${c.rationale})`,
    );
  });
}

// ── Existing Fixture Integration ─────────────────────────────────────────────

test("fixture integration: cursor-valid.json decodes and classifies correctly", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-valid.json"), "utf8");
  const data = JSON.parse(raw);
  const cursor = data.targets.market.cursor;

  const ledger = eventCursorLedger(cursor);
  assert.equal(ledger, 4255261, "cursor-valid.json should decode to ledger 4255261");

  // Inside a window containing 4255261
  const insideWindow = { oldestLedger: 4200000, latestLedger: 4300000 };
  assert.equal(resumeCursorProblem(cursor, insideWindow), null);

  // Stale relative to a floor ahead of 4255261
  const advancedWindow = { oldestLedger: 4260000, latestLedger: 4300000 };
  assert.equal(resumeCursorProblem(cursor, advancedWindow), "cursor-before-floor");

  // Ahead of tip
  const pastWindow = { oldestLedger: 4000000, latestLedger: 4200000 };
  assert.equal(resumeCursorProblem(cursor, pastWindow), "cursor-after-tip");
});

test("fixture integration: cursor-stale.json decodes and classifies as stale", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-stale.json"), "utf8");
  const data = JSON.parse(raw);
  const cursor = data.targets.market.cursor;

  const ledger = eventCursorLedger(cursor);
  assert.equal(ledger, 4250000, "cursor-stale.json should decode to ledger 4250000");

  // When floor has moved past 4250000
  const currentWindow = { oldestLedger: 4250001, latestLedger: 4300000 };
  assert.equal(resumeCursorProblem(cursor, currentWindow), "cursor-before-floor");

  // If window still retained 4250000
  const wideWindow = { oldestLedger: 4200000, latestLedger: 4300000 };
  assert.equal(resumeCursorProblem(cursor, wideWindow), null);
});

test("fixture integration: cursor-corrupt.txt string content yields unreadable null", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-corrupt.txt"), "utf8");
  // Non-JSON raw file content passed directly as a cursor token
  assert.equal(eventCursorLedger(raw), null);
  assert.equal(resumeCursorProblem(raw, WINDOW), null);
});
