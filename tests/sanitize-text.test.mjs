import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeUserText } from "../dist/notifications/sanitize.js";
import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";
import { Logger } from "../dist/logger.js";

const CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
};

test("sanitizeUserText: removes bidi override and embedding controls (U+202A-U+202E, U+2066-U+2069)", () => {
  // U+202E is RIGHT-TO-LEFT OVERRIDE (RLO)
  // Payload attempting to reverse text or spoof addresses/amounts
  const spoofPayload = "Legit Title \u202E txen modnar";
  const sanitized = sanitizeUserText(spoofPayload);
  assert.equal(sanitized, "Legit Title  txen modnar");
  assert.equal(/[\u202A-\u202E\u2066-\u2069]/.test(sanitized), false);

  // All bidi controls:
  const allBidiControls = [
    "\u202A", // LRE
    "\u202B", // RLE
    "\u202C", // PDF
    "\u202D", // LRO
    "\u202E", // RLO
    "\u2066", // LRI
    "\u2067", // RLI
    "\u2068", // FSI
    "\u2069", // PDI
  ];

  for (const ch of allBidiControls) {
    const input = `before${ch}after`;
    assert.equal(sanitizeUserText(input), "beforeafter", `Should strip bidi control ${ch.charCodeAt(0).toString(16)}`);
  }
});

test("sanitizeUserText: preserves legitimate multilingual RTL text (Arabic, Hebrew)", () => {
  // Arabic: هل ستفوز الأرجنتين بكأس العالم؟
  const arabicText = "هل ستفوز الأرجنتين بكأس العالم؟";
  assert.equal(sanitizeUserText(arabicText), arabicText);

  // Hebrew: מי ינצח בבחירות הקרובות?
  const hebrewText = "מי ינצח בבחירות הקרובות?";
  assert.equal(sanitizeUserText(hebrewText), hebrewText);

  // Mixed English and Arabic
  const mixedText = "Market: هل سيحدث هذا؟ (Resolution in 2026)";
  assert.equal(sanitizeUserText(mixedText), mixedText);
});

test("sanitizeUserText: preserves emoji sequences with ZWJ and removes lone ZWJ", () => {
  // Valid emoji sequence with ZWJ: Family: man, woman, girl, boy (👨‍👩‍👧‍👦)
  const familyEmoji = "👨‍👩‍👧‍👦";
  assert.equal(sanitizeUserText(familyEmoji), familyEmoji);

  // Woman technologist: 👩‍💻
  const technologist = "👩‍💻";
  assert.equal(sanitizeUserText(technologist), technologist);

  // Lone ZWJ in normal text should be stripped
  const loneZwj = "Spoofed\u200DText";
  assert.equal(sanitizeUserText(loneZwj), "SpoofedText");

  // Multiple lone ZWJs
  const multipleLoneZwj = "A\u200DB\u200DC";
  assert.equal(sanitizeUserText(multipleLoneZwj), "ABC");

  // Mixed valid emoji sequence and lone ZWJ
  const mixedEmojiZwj = "Hello 👩‍💻 and lone\u200Djoiner";
  assert.equal(sanitizeUserText(mixedEmojiZwj), "Hello 👩‍💻 and lonejoiner");
});

test("sanitizeUserText: strips C0 and C1 control characters except newline", () => {
  // \r, \0, \x07 (bell), \x1B (escape), \x7F (DEL), \x85 (NEL)
  const textWithControls = "Line 1\r\nLine 2\x00\x07\x1B\x7F\x85End";
  const sanitized = sanitizeUserText(textWithControls);
  assert.equal(sanitized, "Line 1\nLine 2End");

  // Preserves simple \n
  const multiline = "Line A\nLine B\nLine C";
  assert.equal(sanitizeUserText(multiline), multiline);
});

test("sanitizeUserText: logs debug count when stripping characters", () => {
  const logged = [];
  const origDebug = Logger.debug;
  Logger.debug = (component, message, fields) => {
    logged.push({ component, message, fields });
  };

  try {
    const payload = "Hello\u202E\u202D\u0000World\u200D!";
    const res = sanitizeUserText(payload);
    assert.equal(res, "HelloWorld!");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].component, "sanitize");
    assert.equal(logged[0].fields?.strippedCount, 4);
    assert.match(logged[0].message, /Stripped 4 disallowed characters/);
  } finally {
    Logger.debug = origDebug;
  }
});

test("formatEvent: sanitizes bidi spoofing in claim_created category and market_created question", () => {
  // Spoofing attempt in claim category: try to reorder surrounding creator address
  const spoofCategory = "crypto\u202E 000.001 edis";
  const claimEvent = {
    source: "market",
    contractId: "market",
    ledger: 100,
    txHash: "a".repeat(64),
    at: 0,
    eventId: "100-0",
    payload: {
      name: "claim_created",
      claimId: 42,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      category: spoofCategory,
    },
  };

  const mdMessage = formatEvent(CONFIG, claimEvent);
  assert.ok(mdMessage !== null);
  assert.equal(mdMessage.includes("\u202E"), false);
  assert.ok(mdMessage.includes("crypto 000\\.001 edis"));

  const plainMessage = formatPlainTextEvent(CONFIG, claimEvent);
  assert.ok(plainMessage !== null);
  assert.equal(plainMessage.includes("\u202E"), false);
  assert.ok(plainMessage.includes("crypto 000.001 edis"));

  // Spoofing attempt in squad question
  const spoofQuestion = "Will Stellar hit 100M? \u202ERLO-attack";
  const squadEvent = {
    source: "squad",
    contractId: "squad",
    ledger: 101,
    txHash: "b".repeat(64),
    at: 0,
    eventId: "101-0",
    payload: {
      name: "market_created",
      marketId: 5,
      captain: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      feeBps: 100,
      deadline: 1770000000,
      question: spoofQuestion,
    },
  };

  const mdSquad = formatEvent(CONFIG, squadEvent);
  assert.ok(mdSquad !== null);
  assert.equal(mdSquad.includes("\u202E"), false);
  assert.ok(mdSquad.includes("Will Stellar hit 100M? RLO\\-attack"));

  const plainSquad = formatPlainTextEvent(CONFIG, squadEvent);
  assert.ok(plainSquad !== null);
  assert.equal(plainSquad.includes("\u202E"), false);
  assert.ok(plainSquad.includes("Will Stellar hit 100M? RLO-attack"));
});

test("formatEvent: sanitizes bidi spoofing in claim_resolved summary", () => {
  const spoofSummary = "Resolved in favor of YES\u202E (actually NO)";
  const resolvedEvent = {
    source: "market",
    contractId: "market",
    ledger: 102,
    txHash: "c".repeat(64),
    at: 0,
    eventId: "102-0",
    payload: {
      name: "claim_resolved",
      claimId: 10,
      winnerSide: 1,
      confidence: 90,
      evidenceHash: "aa",
      summary: spoofSummary,
    },
  };

  const mdResolved = formatEvent(CONFIG, resolvedEvent);
  assert.ok(mdResolved !== null);
  assert.equal(mdResolved.includes("\u202E"), false);
  assert.ok(mdResolved.includes("Resolved in favor of YES \\(actually NO\\)"));

  const plainResolved = formatPlainTextEvent(CONFIG, resolvedEvent);
  assert.ok(plainResolved !== null);
  assert.equal(plainResolved.includes("\u202E"), false);
  assert.ok(plainResolved.includes("Resolved in favor of YES (actually NO)"));
});
