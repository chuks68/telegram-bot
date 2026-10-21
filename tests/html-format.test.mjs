import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, escapeHtmlAttr, formatEventHtml, formatFallbackEventHtml } from "../dist/notifications/html.js";
import { formatUsdc } from "../dist/stellar/decode.js";

const VALID_TX = "0123456789abcdef".repeat(4);

function testnetConfig(overrides = {}) {
  return {
    chatIds: ["-1001234567890"],
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

/**
 * Validates that an HTML string only uses allowed Telegram tags:
 * <b>, <i>, <code>, and <a>.
 * Also asserts that all opened tags are properly balanced and closed.
 */
function assertBalancedAndAllowedTags(html) {
  assert.ok(typeof html === "string" && html.length > 0, "HTML must be non-empty string");

  // Regex to match HTML tags
  const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*)?>/g;
  const allowedTags = new Set(["b", "i", "code", "a"]);
  const stack = [];

  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    assert.ok(
      allowedTags.has(tagName),
      `Tag <${tagName}> is not in allowed set (<b>, <i>, <code>, <a>). Found: ${fullTag}`,
    );

    const isClosing = fullTag.startsWith("</");
    const isSelfClosing = fullTag.endsWith("/>");

    if (isSelfClosing) {
      continue;
    }

    if (isClosing) {
      assert.ok(stack.length > 0, `Unmatched closing tag: ${fullTag} in:\n${html}`);
      const expected = stack.pop();
      assert.equal(
        tagName,
        expected,
        `Mismatched closing tag: expected </${expected}>, got ${fullTag} in:\n${html}`,
      );
    } else {
      // Opening tag. If it's <a>, verify href attribute is present and valid
      if (tagName === "a") {
        assert.match(
          fullTag,
          /^<a\s+href="[^"]*"\s*>$/,
          `<a> tag has malformed attributes: ${fullTag}`,
        );
      }
      stack.push(tagName);
    }
  }

  assert.equal(
    stack.length,
    0,
    `Unclosed tags remaining on stack: ${stack.join(", ")} in:\n${html}`,
  );
}

// ── Basic Escaping Tests ───────────────────────────────────────────────────

test("escapeHtml escapes &, <, >, \", and '", () => {
  assert.equal(
    escapeHtml(`& < > " ' <script>alert("xss")</script>`),
    `&amp; &lt; &gt; &quot; &#39; &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;`,
  );
  assert.equal(escapeHtml("plain text 123"), "plain text 123");
});

test("escapeHtmlAttr escapes attribute values correctly", () => {
  assert.equal(
    escapeHtmlAttr(`https://example.com/test?a=1&b=2" onclick="alert(1)`),
    `https://example.com/test?a=1&amp;b=2&quot; onclick=&quot;alert(1)`,
  );
});

// ── Hostile Title & Input Escaping ─────────────────────────────────────────

const hostileInputs = [
  `<script>alert(1)</script>`,
  `<b>bold attempt</b> <a href="http://evil.com">click</a>`,
  `" onmouseover="alert('xss')" foo='bar'`,
  `& < > " ' &amp; &lt; &gt;`,
  `"><img src=x onerror=alert(1)>`,
  `<b><i><code>unclosed tags galore`,
];

// ── Iterating every event type ─────────────────────────────────────────────

const sampleEvents = [
  // ── mimir-market ─────────────────────────────────────────────────────────
  {
    type: "claim_created",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 100,
      txHash: VALID_TX,
      at: 0,
      eventId: "100-0",
      payload: {
        name: "claim_created",
        claimId: 42,
        category: "crypto & DeFi",
        creator: "GABCD1234567890",
      },
    },
  },
  {
    type: "claim_challenged",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 101,
      txHash: VALID_TX,
      at: 0,
      eventId: "101-0",
      payload: {
        name: "claim_challenged",
        claimId: 42,
        challenger: "GCHALLENGER",
        stake: 20_000_000n,
      },
    },
  },
  {
    type: "claim_resolved (with summary)",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 102,
      txHash: VALID_TX,
      at: 0,
      eventId: "102-0",
      payload: {
        name: "claim_resolved",
        claimId: 42,
        winnerSide: 1,
        confidence: 85,
        summary: "Creator provided strong evidence & signatures.",
      },
    },
  },
  {
    type: "claim_resolved (without summary)",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 103,
      txHash: VALID_TX,
      at: 0,
      eventId: "103-0",
      payload: {
        name: "claim_resolved",
        claimId: 42,
        winnerSide: 2,
        confidence: 90,
        summary: null,
      },
    },
  },
  {
    type: "claim_cancelled",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 104,
      txHash: VALID_TX,
      at: 0,
      eventId: "104-0",
      payload: {
        name: "claim_cancelled",
        claimId: 42,
      },
    },
  },
  {
    type: "market_settled",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 105,
      txHash: VALID_TX,
      at: 0,
      eventId: "105-0",
      payload: {
        name: "market_settled",
        claimId: 42,
        totalPaid: 50_000_000n,
        totalFees: 1_000_000n,
        owedToChallengers: 49_000_000n,
      },
    },
  },
  {
    type: "challenger_paid",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 106,
      txHash: VALID_TX,
      at: 0,
      eventId: "106-0",
      payload: {
        name: "challenger_paid",
        claimId: 42,
        challenger: "GCHALLENGER",
        stake: 20_000_000n,
        net: 28_000_000n,
        gross: 30_000_000n,
        fee: 2_000_000n,
      },
    },
  },
  {
    type: "fee_claimed",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 107,
      txHash: VALID_TX,
      at: 0,
      eventId: "107-0",
      payload: {
        name: "fee_claimed",
        amount: 5_000_000n,
        recipient: "GRECIPIENT",
      },
    },
  },
  {
    type: "withdrawal",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 108,
      txHash: VALID_TX,
      at: 0,
      eventId: "108-0",
      payload: {
        name: "withdrawal",
        amount: 15_000_000n,
        to: "GWITHDRAWAL",
      },
    },
  },
  {
    type: "withdrawal_pending",
    event: {
      source: "market",
      contractId: "CBABCD",
      ledger: 109,
      txHash: VALID_TX,
      at: 0,
      eventId: "109-0",
      payload: {
        name: "withdrawal_pending",
        amount: 15_000_000n,
        to: "GWITHDRAWAL",
      },
    },
  },

  // ── mimir-squad ──────────────────────────────────────────────────────────
  {
    type: "market_created",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 200,
      txHash: VALID_TX,
      at: 0,
      eventId: "200-0",
      payload: {
        name: "market_created",
        marketId: 10,
        question: "Will Stellar exceed 100M operations in 2026?",
        captain: "GCAPTAIN",
        feeBps: 50,
        deadline: 1800000000,
      },
    },
  },
  {
    type: "deposited",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 201,
      txHash: VALID_TX,
      at: 0,
      eventId: "201-0",
      payload: {
        name: "deposited",
        marketId: 10,
        amount: 100_000_000n,
        side: 1,
        participant: "GPARTICIPANT",
      },
    },
  },
  {
    type: "withdrawn",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 202,
      txHash: VALID_TX,
      at: 0,
      eventId: "202-0",
      payload: {
        name: "withdrawn",
        marketId: 10,
        amount: 30_000_000n,
        side: 1,
        participant: "GPARTICIPANT",
      },
    },
  },
  {
    type: "resolved",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 203,
      txHash: VALID_TX,
      at: 0,
      eventId: "203-0",
      payload: {
        name: "resolved",
        marketId: 10,
        result: 1,
        poolA: 200_000_000n,
        poolB: 150_000_000n,
      },
    },
  },
  {
    type: "claimed",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 204,
      txHash: VALID_TX,
      at: 0,
      eventId: "204-0",
      payload: {
        name: "claimed",
        marketId: 10,
        participant: "GPARTICIPANT",
        net: 95_000_000n,
        gross: 100_000_000n,
        fee: 5_000_000n,
      },
    },
  },
  {
    type: "fees_claimed",
    event: {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 205,
      txHash: VALID_TX,
      at: 0,
      eventId: "205-0",
      payload: {
        name: "fees_claimed",
        amount: 12_000_000n,
        recipient: "GCAPTAIN",
      },
    },
  },
];

for (const { type, event } of sampleEvents) {
  test(`formatEventHtml balances tags and formats event: ${type}`, () => {
    const config = testnetConfig();
    const html = formatEventHtml(config, event);
    assert.ok(html !== null, `Expected event ${type} to format successfully`);
    assertBalancedAndAllowedTags(html);

    // Verify explorer URL is attribute-escaped inside <a href="...">
    assert.ok(html.includes(`<a href="https://stellar.expert/explorer/testnet/tx/${VALID_TX}">tx</a>`));
  });

  test(`formatEventHtml without txHash renders balanced tags without link: ${type}`, () => {
    const config = testnetConfig();
    const eventWithoutTx = { ...event, txHash: "" };
    const html = formatEventHtml(config, eventWithoutTx);
    assert.ok(html !== null);
    assertBalancedAndAllowedTags(html);
    assert.ok(!html.includes("<a"));
    assert.ok(html.includes(`<i>ledger ${event.ledger}</i>`));
  });
}

test("formatEventHtml with channelPreviewMode includes balanced prefix", () => {
  const config = testnetConfig({ channelPreviewMode: true });
  const html = formatEventHtml(config, sampleEvents[0].event);
  assert.ok(html !== null);
  assertBalancedAndAllowedTags(html);
  assert.ok(html.includes("🧪 <b>[PREVIEW MODE]</b>"));
});

test("formatEventHtml escapes hostile titles and user content for every hostile input", () => {
  const config = testnetConfig();

  for (const hostile of hostileInputs) {
    // 1. claim_created with hostile category and creator
    const claimCreated = {
      source: "market",
      contractId: "CBABCD",
      ledger: 50,
      txHash: VALID_TX,
      payload: {
        name: "claim_created",
        claimId: hostile,
        category: hostile,
        creator: hostile,
      },
    };
    const html1 = formatEventHtml(config, claimCreated);
    assertBalancedAndAllowedTags(html1);
    assert.ok(!html1.includes("<script>"));
    assert.ok(html1.includes(escapeHtml(hostile)));

    // 2. claim_resolved with hostile summary
    const claimResolved = {
      source: "market",
      contractId: "CBABCD",
      ledger: 51,
      txHash: VALID_TX,
      payload: {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 1,
        confidence: 50,
        summary: hostile,
      },
    };
    const html2 = formatEventHtml(config, claimResolved);
    assertBalancedAndAllowedTags(html2);
    assert.ok(!html2.includes("<script>"));

    // 3. squad market_created with hostile question and captain
    const marketCreated = {
      source: "squad",
      contractId: "CBSQUAD",
      ledger: 52,
      txHash: VALID_TX,
      payload: {
        name: "market_created",
        marketId: 2,
        question: hostile,
        captain: hostile,
        feeBps: 10,
        deadline: 1800000000,
      },
    };
    const html3 = formatEventHtml(config, marketCreated);
    assertBalancedAndAllowedTags(html3);
    assert.ok(!html3.includes("<script>"));
    assert.ok(html3.includes(escapeHtml(hostile)));
  }
});

test("formatFallbackEventHtml renders balanced HTML and safely escapes reason", () => {
  const config = testnetConfig();
  const event = {
    source: "market",
    contractId: "CBABCD",
    ledger: 999,
    txHash: VALID_TX,
    payload: { name: "unknown" },
  };
  const html = formatFallbackEventHtml(config, event, `<hostile & reason>`);
  assertBalancedAndAllowedTags(html);
  assert.ok(html.includes("&lt;hostile &amp; reason&gt;"));
  assert.ok(html.includes("⚠️ <b>Event Notification Fallback</b>"));
});

test("unnotifiable admin and unknown events return null in formatEventHtml", () => {
  const config = testnetConfig();
  const adminEventNames = [
    "oracle_changed",
    "ownership_transferred",
    "agent_attributed",
    "fee_accrued",
    "fee_policy_set",
    "fee_policy_changed",
    "fee_policy_updated",
    "fee_policy_removed",
    "admin",
    "unknown",
  ];

  for (const name of adminEventNames) {
    const event = {
      source: "market",
      contractId: "C123",
      ledger: 100,
      payload: { name },
    };
    assert.equal(formatEventHtml(config, event), null, `Event ${name} should return null`);
  }
});

test("formatEventHtml honors notificationCategories filter", () => {
  const config = testnetConfig({ notificationCategories: ["crypto", "tech"] });
  const allowedEvent = {
    source: "market",
    contractId: "CBABCD",
    ledger: 100,
    payload: { name: "claim_created", claimId: 1, category: "Crypto", creator: "G123" },
  };
  const deniedEvent = {
    source: "market",
    contractId: "CBABCD",
    ledger: 100,
    payload: { name: "claim_created", claimId: 2, category: "Sports", creator: "G123" },
  };

  assert.ok(formatEventHtml(config, allowedEvent) !== null);
  assert.equal(formatEventHtml(config, deniedEvent), null);
});
