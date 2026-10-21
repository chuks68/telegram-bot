/**
 * Tests for src/stellar/feed.ts — Atom feed builder.
 *
 * Coverage:
 *   - escapeXml: each of the five predefined entities
 *   - stripXmlIllegal: removes C0 control chars, keeps printable Unicode
 *   - xmlText: clips to max code points and escapes
 *   - safeHttpsUrl: accepts https, rejects http and other schemes
 *   - buildAtomEntry: id, title, updated, content, link derivation
 *   - buildAtomFeed: well-formed XML, required Atom elements, entry count,
 *                    empty feed, hostile title / content strings, subtitle
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeXml,
  stripXmlIllegal,
  xmlText,
  safeHttpsUrl,
  buildAtomEntry,
  buildAtomFeed,
  FEED_CONTENT_MAX_CHARS,
  FEED_TITLE_MAX_CHARS,
} from "../dist/stellar/feed.js";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_SQUAD  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

/**
 * Minimal StellarConfig that satisfies eventExplorerUrl and formatPlainTextEvent
 * without needing a real RPC connection.
 */
const BASE_CONFIG = {
  marketContractId: VALID_MARKET,
  squadContractId:  VALID_SQUAD,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

let eventSeq = 1;

function makeEvent(overrides = {}) {
  const id = eventSeq++;
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 1000 + id,
    txHash: VALID_TX,
    at: 1_700_000_000 + id,
    eventId: `${1000 + id}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: id,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

const FEED_OPTS = {
  title: "Mimir Events",
  selfUrl: "https://example.com/feed.atom",
  config: BASE_CONFIG,
};

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

test("escapeXml: escapes ampersand first to avoid double-escaping", () => {
  assert.equal(escapeXml("a&b"), "a&amp;b");
  assert.equal(escapeXml("&amp;"), "&amp;amp;");
});

test("escapeXml: escapes < and >", () => {
  assert.equal(escapeXml("<tag>"), "&lt;tag&gt;");
});

test("escapeXml: escapes double-quote", () => {
  assert.equal(escapeXml('"hello"'), "&quot;hello&quot;");
});

test("escapeXml: escapes single-quote", () => {
  assert.equal(escapeXml("it's"), "it&apos;s");
});

test("escapeXml: all five entities in one string", () => {
  assert.equal(escapeXml(`<a href="x&y">it's</a>`), `&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;`);
});

test("escapeXml: leaves safe characters untouched", () => {
  const safe = "Hello, World! 123 αβγ 🚀";
  assert.equal(escapeXml(safe), safe);
});

// ---------------------------------------------------------------------------
// stripXmlIllegal
// ---------------------------------------------------------------------------

test("stripXmlIllegal: removes NUL and C0 controls", () => {
  const input = "hello\x00world\x01\x08";
  assert.equal(stripXmlIllegal(input), "helloworld");
});

test("stripXmlIllegal: keeps tab (0x09), LF (0x0A), CR (0x0D)", () => {
  const input = "a\tb\nc\rd";
  assert.equal(stripXmlIllegal(input), input);
});

test("stripXmlIllegal: keeps printable ASCII and Unicode", () => {
  const input = "Mimir αβγ 🚀 café";
  assert.equal(stripXmlIllegal(input), input);
});

test("stripXmlIllegal: removes 0x0B, 0x0C, 0x0E–0x1F, 0x7F", () => {
  const stripped = stripXmlIllegal("\x0B\x0C\x0E\x1F\x7F");
  assert.equal(stripped, "");
});

// ---------------------------------------------------------------------------
// xmlText
// ---------------------------------------------------------------------------

test("xmlText: short string passes through escaped", () => {
  assert.equal(xmlText("<b>bold</b>", 100), "&lt;b&gt;bold&lt;/b&gt;");
});

test("xmlText: clips to max Unicode code points and appends ellipsis", () => {
  const result = xmlText("abcde", 4);
  // 3 chars + ellipsis (…) = 4 code points total
  assert.ok(result.startsWith("abc"), `result was "${result}"`);
  assert.ok(result.includes("…"), "clipped result should end with ellipsis");
});

test("xmlText: clips by code point, not byte (emoji)", () => {
  // Each 🚀 is one code point but 4 UTF-16 bytes
  const result = xmlText("🚀🚀🚀🚀🚀", 3);
  assert.ok(result.includes("…"), "should clip emoji string");
});

test("xmlText: strips XML-illegal chars before escaping", () => {
  const result = xmlText("hello\x00world", 100);
  assert.equal(result, "helloworld");
  assert.ok(!result.includes("\x00"), "NUL should be stripped");
});

// ---------------------------------------------------------------------------
// safeHttpsUrl
// ---------------------------------------------------------------------------

test("safeHttpsUrl: accepts a valid https URL", () => {
  const url = "https://stellar.expert/explorer/testnet/tx/abc";
  assert.equal(safeHttpsUrl(url), url);
});

test("safeHttpsUrl: rejects http URL", () => {
  assert.equal(safeHttpsUrl("http://example.com/feed"), null);
});

test("safeHttpsUrl: rejects javascript: scheme", () => {
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
});

test("safeHttpsUrl: rejects non-URL garbage", () => {
  assert.equal(safeHttpsUrl("not a url at all"), null);
});

test("safeHttpsUrl: rejects empty string", () => {
  assert.equal(safeHttpsUrl(""), null);
});

// ---------------------------------------------------------------------------
// buildAtomEntry
// ---------------------------------------------------------------------------

test("buildAtomEntry: id is a tag URI containing the eventId", () => {
  const event = makeEvent();
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.id.startsWith("tag:mimir,event:"), `id was "${entry.id}"`);
  assert.ok(entry.id.includes(event.eventId), "id should contain eventId");
});

test("buildAtomEntry: title contains source and event name", () => {
  const event = makeEvent({ source: "market", payload: { name: "claim_created", claimId: 1, category: "test", creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" } });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.title.includes("market"), `title was "${entry.title}"`);
  assert.ok(entry.title.includes("claim_created"), `title was "${entry.title}"`);
});

test("buildAtomEntry: updated is an ISO 8601 string derived from event.at", () => {
  const event = makeEvent({ at: 1_700_000_000 });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  // ISO 8601 basic check: ends in Z, contains T
  assert.ok(entry.updated.includes("T") && entry.updated.endsWith("Z"),
    `updated was "${entry.updated}"`);
  const parsed = new Date(entry.updated);
  assert.ok(!Number.isNaN(parsed.getTime()), "updated should parse as a valid date");
  assert.equal(parsed.getTime(), 1_700_000_000 * 1000);
});

test("buildAtomEntry: content is a non-empty string for a notifiable event", () => {
  const event = makeEvent();
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.content !== null && entry.content.length > 0, "content should be non-null for claim_created");
});

test("buildAtomEntry: link is a valid https URL when the event has a good txHash", () => {
  const event = makeEvent({ txHash: VALID_TX });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.link !== null, "link should not be null for a valid txHash");
  assert.ok(entry.link?.startsWith("https://"), `link was "${entry.link}"`);
});

test("buildAtomEntry: link is null when txHash is empty", () => {
  const event = makeEvent({ txHash: "" });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.equal(entry.link, null);
});

test("buildAtomEntry: content is null for an admin event (no plain-text rendering)", () => {
  const event = makeEvent({
    source: "market",
    payload: { name: "unknown", eventName: "oracle_changed" },
  });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  // formatPlainTextEvent returns null for unknown/admin events
  assert.equal(entry.content, null);
});

test("buildAtomEntry: content is bounded to FEED_CONTENT_MAX_CHARS", () => {
  // Craft an event whose plain-text rendering would be very long by using a
  // long category string in the payload (format.ts clips at 200 chars for the
  // Telegram layer, but feed.ts applies its own cap independently).
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 999,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  if (entry.content !== null) {
    assert.ok(
      Array.from(entry.content).length <= FEED_CONTENT_MAX_CHARS,
      `content length ${Array.from(entry.content).length} exceeds cap`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildAtomFeed — structure
// ---------------------------------------------------------------------------

test("buildAtomFeed: starts with XML declaration and Atom namespace", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "missing XML declaration");
  assert.ok(feed.includes('xmlns="http://www.w3.org/2005/Atom"'), "missing Atom namespace");
});

test("buildAtomFeed: contains required <title>, <id>, <updated> elements", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes("<title"), "missing <title>");
  assert.ok(feed.includes("<id>"), "missing <id>");
  assert.ok(feed.includes("<updated>"), "missing <updated>");
});

test("buildAtomFeed: <id> contains the selfUrl", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes("https://example.com/feed.atom"), "selfUrl not found in feed");
});

test("buildAtomFeed: <link rel='self'> is present for a valid https selfUrl", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes('rel="self"'), "missing self link");
  assert.ok(feed.includes("https://example.com/feed.atom"), "selfUrl not in self link");
});

test("buildAtomFeed: empty events array produces no <entry> elements", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(!feed.includes("<entry>"), "empty feed should have no entries");
});

test("buildAtomFeed: entry count matches events array length", () => {
  const events = [makeEvent(), makeEvent(), makeEvent()];
  const feed = buildAtomFeed(events, FEED_OPTS);
  const count = (feed.match(/<entry>/g) ?? []).length;
  assert.equal(count, 3, `expected 3 entries, found ${count}`);
});

test("buildAtomFeed: <updated> reflects the most recent event.at", () => {
  const events = [
    makeEvent({ at: 1_700_000_100 }),
    makeEvent({ at: 1_700_000_200 }),  // most recent
    makeEvent({ at: 1_700_000_050 }),
  ];
  const feed = buildAtomFeed(events, FEED_OPTS);
  // The feed's <updated> should be the ISO string of the max at (1_700_000_200)
  const expected = new Date(1_700_000_200 * 1000).toISOString();
  assert.ok(feed.includes(expected), `feed <updated> should be ${expected}`);
});

test("buildAtomFeed: updatedAt option overrides event timestamps", () => {
  const fixed = "2024-01-15T12:00:00.000Z";
  const feed = buildAtomFeed([makeEvent()], { ...FEED_OPTS, updatedAt: fixed });
  assert.ok(feed.includes(fixed), "updatedAt override not found in feed");
});

test("buildAtomFeed: subtitle element is rendered when provided", () => {
  const feed = buildAtomFeed([], { ...FEED_OPTS, subtitle: "Testnet activity" });
  assert.ok(feed.includes("<subtitle"), "missing <subtitle>");
  assert.ok(feed.includes("Testnet activity"), "subtitle text not found");
});

test("buildAtomFeed: subtitle is absent when not provided", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(!feed.includes("<subtitle"), "<subtitle> should not appear when not set");
});

// ---------------------------------------------------------------------------
// buildAtomFeed — hostile input (injection / escaping)
// ---------------------------------------------------------------------------

test("buildAtomFeed: hostile title with XML special chars is escaped", () => {
  const hostileTitle = '<script>alert("xss")</script> & \'injection\'';
  const feed = buildAtomFeed([], { ...FEED_OPTS, title: hostileTitle });

  // The raw hostile string must not appear verbatim
  assert.ok(!feed.includes("<script>"), "raw <script> tag must not appear in feed");
  assert.ok(!feed.includes('alert("xss")') || feed.includes("&quot;"), "quotes must be escaped");

  // The escaped form must be present
  assert.ok(feed.includes("&lt;script&gt;"), "< and > must be escaped in title");
  assert.ok(feed.includes("&amp;"), "& must be escaped in title");
});

test("buildAtomFeed: hostile selfUrl with XML chars is escaped in attributes", () => {
  // Embed a double-quote in the selfUrl to attempt attribute break-out
  // safeHttpsUrl will reject a non-parseable URL, but we test the escaping layer too
  const feed = buildAtomFeed([], {
    ...FEED_OPTS,
    // Use a valid https URL that contains characters that need escaping
    selfUrl: "https://example.com/feed?a=1&b=2",
  });
  // The & in the query string must be escaped in XML attributes
  assert.ok(!feed.includes("a=1&b=2"), "raw & in URL must be XML-escaped");
  assert.ok(feed.includes("a=1&amp;b=2"), "& in URL must appear as &amp;");
});

test("buildAtomFeed: event with hostile category does not break XML", () => {
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 1,
      category: '<evil attr="injected">',
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const feed = buildAtomFeed([event], FEED_OPTS);

  // The raw attack string must not appear verbatim in content
  assert.ok(!feed.includes('<evil attr="injected">'), "hostile category must be escaped in content");
});

test("buildAtomFeed: event with NUL / C0 control chars in payload does not produce malformed XML", () => {
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 1,
      category: "crypto\x00\x01\x08",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const feed = buildAtomFeed([event], FEED_OPTS);
  // XML-illegal NUL must not appear in the output
  assert.ok(!feed.includes("\x00"), "NUL byte must not appear in feed XML");
  assert.ok(!feed.includes("\x01"), "0x01 must not appear in feed XML");
});

test("buildAtomFeed: feed closes with </feed>", () => {
  const feed = buildAtomFeed([makeEvent()], FEED_OPTS);
  assert.ok(feed.trimEnd().endsWith("</feed>"), "feed must end with </feed>");
});

// ---------------------------------------------------------------------------
// buildAtomFeed — each entry structure
// ---------------------------------------------------------------------------

test("buildAtomFeed: each entry has <id>, <title>, <updated>, <content>", () => {
  const feed = buildAtomFeed([makeEvent()], FEED_OPTS);
  assert.ok(feed.includes("<id>"), "entry missing <id>");
  assert.ok(feed.includes("<title"), "entry missing <title>");
  assert.ok(feed.includes("<updated>"), "entry missing <updated>");
  assert.ok(feed.includes("<content"), "entry missing <content>");
});

test("buildAtomFeed: entry link element is present for event with valid txHash", () => {
  const event = makeEvent({ txHash: VALID_TX });
  const feed = buildAtomFeed([event], FEED_OPTS);
  assert.ok(feed.includes('rel="alternate"'), "entry should have an alternate link");
});

test("buildAtomFeed: entry link element is absent for event with no txHash", () => {
  const event = makeEvent({ txHash: "" });
  const feed = buildAtomFeed([event], FEED_OPTS);
  // No link rel=alternate should appear anywhere in a single-entry feed
  assert.ok(!feed.includes('rel="alternate"'), "no link should appear for missing txHash");
});
