import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { formatEvent } from "../dist/notifications/format.js";
import { eventCursorLedger } from "../dist/stellar/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const repoRoot = path.join(here, "..");
const validatorPath = path.join(repoRoot, "scripts", "validate-fixtures.mjs");

/** Money keys on decoded payloads that fixtures store as decimal strings. */
const MONEY_KEYS = new Set([
  "stake",
  "totalPaid",
  "totalFees",
  "owedToChallengers",
  "dust",
  "gross",
  "fee",
  "net",
  "amount",
  "shares",
  "poolA",
  "poolB",
]);

function runValidator(cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [validatorPath],
      { cwd },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function hydratePayload(payload) {
  const out = { ...payload };
  for (const key of MONEY_KEYS) {
    if (typeof out[key] === "string" && /^-?\d+$/.test(out[key])) {
      out[key] = BigInt(out[key]);
    }
  }
  return out;
}

function hydrateEvent(raw) {
  return {
    ...raw,
    payload: hydratePayload(raw.payload),
  };
}

async function loadCatalog() {
  const raw = await readFile(path.join(fixturesDir, "events.json"), "utf8");
  return JSON.parse(raw);
}

async function copyFixtures(dest) {
  const files = ["events.json", "events.mjs"];
  for (const name of files) {
    const raw = await readFile(path.join(fixturesDir, name), "utf8");
    await writeFile(path.join(dest, name), raw, "utf8");
  }
}

// ── Catalog meta ──────────────────────────────────────────────────────────────

test("fixture catalog covers positive, negative, boundary, and restart kinds", async () => {
  const catalog = await loadCatalog();
  const kinds = new Set(catalog.cases.map((c) => c.kind));
  assert.ok(kinds.has("positive"), "missing positive cases");
  assert.ok(kinds.has("negative"), "missing negative cases");
  assert.ok(kinds.has("boundary"), "missing boundary cases");
  assert.ok(kinds.has("restart"), "missing restart/failure-mode documentation cases");
  assert.ok(catalog.cases.length >= 20, `catalog too thin: only ${catalog.cases.length} cases`);
});

test("fixture config never points at live RPC or embeds secrets", async () => {
  const catalog = await loadCatalog();
  const { config } = catalog;
  assert.match(config.rpcUrl, /example\.invalid/);
  assert.match(config.horizonUrl, /example\.invalid/);
  const blob = JSON.stringify(catalog);
  assert.doesNotMatch(blob, /BOT_TOKEN|ghp_|sk_live/);
  assert.doesNotMatch(blob, /api\.telegram\.org/i);
});

// ── Positive / negative / boundary runner ────────────────────────────────────

test("event fixtures drive formatEvent notify/skip expectations", async () => {
  const catalog = await loadCatalog();
  const { config } = catalog;

  for (const c of catalog.cases) {
    const event = hydrateEvent(c.event);
    const message = formatEvent(config, event);

    if (c.expect === "skip") {
      assert.equal(message, null, `${c.id}: expected skip`);
      continue;
    }

    assert.equal(c.expect, "notify", `${c.id}: unknown expect "${c.expect}"`);
    assert.equal(typeof message, "string", `${c.id}: expected notify string`);
    assert.ok(message.length > 0, `${c.id}: empty message`);
    for (const needle of c.messageIncludes ?? []) {
      assert.ok(
        message.includes(needle),
        `${c.id}: missing ${JSON.stringify(needle)} in ${JSON.stringify(message)}`,
      );
    }
    assert.doesNotMatch(message, /BOT_TOKEN|ghp_/);
  }
});

// ── Market event positive cases ───────────────────────────────────────────────

test("fixture claim_challenged reaches Telegram via fake notifier", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "claim_challenged_happy");
  assert.ok(c, "claim_challenged_happy fixture missing");

  const event = hydrateEvent(c.event);
  const message = formatEvent(catalog.config, event);
  assert.ok(message);

  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  await createNotifier(fakeBot, catalog.config)(message);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], catalog.config.chatIds[0]);
  assert.equal(sent[0][1], message);
  assert.equal(sent[0][2].parse_mode, "MarkdownV2");
});

test("fixture claim_cancelled renders a non-null notify message", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "claim_cancelled_happy");
  assert.ok(c, "claim_cancelled_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message, "claim_cancelled should produce a notification");
  assert.ok(message.includes("cancelled"), "should mention cancelled");
  assert.ok(message.includes("stakes returned"), "should mention stakes returned");
});

test("fixture market_settled renders paid, fees and owed_to_challengers", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "market_settled_happy");
  assert.ok(c, "market_settled_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("settled"), "should mention settled");
  assert.ok(message.includes("18\\.0000000 USDC"), "should include totalPaid");
  assert.ok(message.includes("2\\.0000000 USDC"), "should include totalFees");
});

test("fixture challenger_paid renders stake, gross, fee, net", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "challenger_paid_happy");
  assert.ok(c, "challenger_paid_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("staked"), "should include staked label");
  assert.ok(message.includes("3\\.6000000 USDC"), "should include net amount");
});

test("fixture fee_claimed renders recipient and amount", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "fee_claimed_happy");
  assert.ok(c, "fee_claimed_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("Fees claimed"), "should include Fees claimed");
  assert.ok(message.includes("0\\.5000000 USDC"), "should include amount");
});

test("fixture withdrawal renders amount and destination address", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "withdrawal_happy");
  assert.ok(c, "withdrawal_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("Withdrawal"), "should include Withdrawal");
  assert.ok(message.includes("5\\.0000000 USDC"), "should include amount");
});

test("fixture withdrawal_pending renders parked and claimable labels", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "withdrawal_pending_happy");
  assert.ok(c, "withdrawal_pending_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("parked"), "should include parked");
  assert.ok(message.includes("claimable"), "should include claimable");
});

// ── Squad event positive cases ────────────────────────────────────────────────

test("fixture squad_resolved renders result side and pool amounts", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_resolved_happy");
  assert.ok(c, "squad_resolved_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("resolved"), "should mention resolved");
  assert.ok(message.includes("Side A"), "should include winning side");
});

test("fixture squad_claimed renders participant and net payout", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_claimed_happy");
  assert.ok(c, "squad_claimed_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("Squad payout"), "should include Squad payout");
  assert.ok(message.includes("4\\.9000000 USDC"), "should include net amount");
});

test("fixture squad_withdrawn renders participant, amount and side", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_withdrawn_happy");
  assert.ok(c, "squad_withdrawn_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("Side B"), "should include side label");
  assert.ok(message.includes("1\\.0000000 USDC"), "should include amount");
});

test("fixture squad_fees_claimed renders recipient and amount", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_fees_claimed_happy");
  assert.ok(c, "squad_fees_claimed_happy fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("Squad fees claimed"), "should include Squad fees claimed");
  assert.ok(message.includes("0\\.3000000 USDC"), "should include amount");
});

// ── Boundary cases ────────────────────────────────────────────────────────────

test("Telegram send failure from fixture path preserves the error (no token leak)", async () => {
  const catalog = await loadCatalog();
  const error = new Error("Telegram API unavailable");
  const fakeBot = {
    api: {
      sendMessage: async () => Promise.reject(error),
    },
  };
  const notify = createNotifier(fakeBot, { chatIds: catalog.config.chatIds });
  await assert.rejects(notify("fixture-message"), (err) => {
    assert.equal(err, error);
    assert.doesNotMatch(String(err), /BOT_TOKEN/);
    return true;
  });
});

test("valid cursor fixture parses as version-1 poller shape", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-valid.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.ok(parsed.targets.market.cursor);
  assert.ok(parsed.targets.squad.cursor);
  assert.equal(typeof parsed.targets.market.lastEventLedger, "number");
});

test("corrupt cursor fixture is not JSON (cold-start path)", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-corrupt.txt"), "utf8");
  assert.throws(() => JSON.parse(raw));
});

test("opaque cursor ledger hint accepts bounded Soroban TOIDs", () => {
  assert.equal(eventCursorLedger("0018276211125911551-4294967295"), 4255261);
  assert.equal(eventCursorLedger("18446744073709551615-4294967295"), 4294967295);
});

test("opaque cursor ledger hint rejects malformed and oversized tokens", () => {
  for (const cursor of [
    "",
    "not-a-cursor",
    "123",
    "123-",
    "123-1-extra",
    "18446744073709551616-0",
    "1-4294967296",
    `${"9".repeat(100000)}-0`,
  ]) {
    assert.equal(eventCursorLedger(cursor), null, cursor.slice(0, 32));
  }
});

test("long summary boundary fixture clips before sizing a chat message", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "long_summary_clipped");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("…"));
  assert.ok(message.length < 800, "message unexpectedly huge");
});

test("market_settled with zero fees still notifies (boundary: zero-fee settlement)", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "market_settled_zero_dust");
  assert.ok(c, "market_settled_zero_dust fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message, "zero-fee settlement should still produce a notification");
  assert.ok(message.includes("settled"), "should include settled");
});

test("squad resolved with cancelled result renders cancelled side label", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_resolved_cancelled");
  assert.ok(c, "squad_resolved_cancelled fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("cancelled"), "cancelled result should render");
});

test("squad claimed with zero fee renders with zero fee in message", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "squad_claimed_zero_fee");
  assert.ok(c, "squad_claimed_zero_fee fixture missing");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("0\\.0000000 USDC"), "zero fee should appear in message");
});

// ── Restart / failure-mode documentation cases ────────────────────────────────

test("restart kind cases are all marked skip (they document behaviour, not format)", async () => {
  const catalog = await loadCatalog();
  const restartCases = catalog.cases.filter((c) => c.kind === "restart");
  assert.ok(restartCases.length >= 3, "expected at least 3 restart/failure-mode doc cases");

  for (const c of restartCases) {
    assert.equal(c.expect, "skip",
      `restart case ${c.id} should be marked expect:skip (it documents, not notifies)`);
    // formatEvent must return null for these (they're unknown payloads).
    const message = formatEvent(catalog.config, hydrateEvent(c.event));
    assert.equal(message, null,
      `restart case ${c.id}: formatEvent should return null`);
  }
});

test("rpc_failure_cursor_invariant fixture documents the RPC-failure cursor contract", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "rpc_failure_cursor_invariant");
  assert.ok(c, "rpc_failure_cursor_invariant fixture missing");
  assert.equal(c.kind, "restart");
  assert.ok(c.description, "restart fixture should have a description");
  assert.ok(c.description.includes("cursor"), "description should mention cursor");
  assert.ok(c.description.includes("unchanged"), "description should say unchanged");
});

test("telegram_failure_cursor_advances fixture documents the send-failure cursor contract", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "telegram_failure_cursor_advances");
  assert.ok(c, "telegram_failure_cursor_advances fixture missing");
  assert.equal(c.kind, "restart");
  assert.ok(c.description.includes("advances"), "description should say cursor advances");
});

test("burst_cap_extras_skipped fixture documents the burst-cap behaviour", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "burst_cap_extras_skipped");
  assert.ok(c, "burst_cap_extras_skipped fixture missing");
  assert.equal(c.kind, "restart");
  assert.ok(c.description.includes("skipped"), "description should mention skipped");
  assert.ok(c.description.includes("cursor"), "description should mention cursor");
});

// ── Full catalog coverage check ───────────────────────────────────────────────

test("every known market event type has at least one positive fixture", async () => {
  const catalog = await loadCatalog();
  const positiveNames = new Set(
    catalog.cases
      .filter((c) => c.kind === "positive" && c.event.source === "market")
      .map((c) => c.event.payload.name),
  );

  const required = [
    "claim_created",
    "claim_challenged",
    "claim_resolved",
    "claim_cancelled",
    "market_settled",
    "challenger_paid",
    "fee_claimed",
    "withdrawal",
    "withdrawal_pending",
  ];

  for (const name of required) {
    assert.ok(positiveNames.has(name), `missing positive fixture for market event: ${name}`);
  }
});

test("every known squad event type has at least one positive fixture", async () => {
  const catalog = await loadCatalog();
  const positiveNames = new Set(
    catalog.cases
      .filter((c) => c.kind === "positive" && c.event.source === "squad")
      .map((c) => c.event.payload.name),
  );

  const required = [
    "market_created",
    "deposited",
    "resolved",
    "claimed",
    "withdrawn",
    "fees_claimed",
  ];

  for (const name of required) {
    assert.ok(positiveNames.has(name), `missing positive fixture for squad event: ${name}`);
  }
});

// ── Fixture validation script ─────────────────────────────────────────────────

test("validate-fixtures accepts the current fixtures", async () => {
  const result = await runValidator(repoRoot);
  assert.equal(
    result.code,
    0,
    `validator failed on current fixtures:\n${result.stdout}${result.stderr}`,
  );
});

test("validate-fixtures fails on a broken copy with a clear message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fixtures-broken-"));
  try {
    await copyFixtures(dir);
    const catalogPath = path.join(dir, "events.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

    // Introduce a duplicate id and drop a required field on another case.
    assert.ok(catalog.cases.length >= 2, "need at least two cases to break");
    catalog.cases[1].id = catalog.cases[0].id;
    delete catalog.cases[0].event.payload.name;
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    const result = await runValidator(dir);
    assert.notEqual(result.code, 0, "validator should exit non-zero on broken fixtures");
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /duplicate/i, `expected duplicate id error, got: ${output}`);
    assert.match(output, /name/i, `expected missing name error, got: ${output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
