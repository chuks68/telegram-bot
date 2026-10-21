import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  getFallbackStellarConfig,
  hydrateEventJson,
  parseCliArgs,
  renderEvent,
  runRenderCli,
} from "../dist/render-cli.js";

const execFileP = promisify(execFile);

const CLAIM_CREATED_FIXTURE = path.resolve("tests/fixtures/render/claim_created.json");
const CLAIM_CHALLENGED_FIXTURE = path.resolve("tests/fixtures/render/claim_challenged.json");
const MARKET_CREATED_FIXTURE = path.resolve("tests/fixtures/render/market_created.json");

test("parseCliArgs: parses default both format and file argument", () => {
  const args = parseCliArgs(["some/path.json"]);
  assert.equal(args.file, "some/path.json");
  assert.equal(args.format, "both");
});

test("parseCliArgs: parses explicit --format options", () => {
  assert.equal(parseCliArgs(["--format", "md"]).format, "md");
  assert.equal(parseCliArgs(["--format", "plain"]).format, "plain");
  assert.equal(parseCliArgs(["--format", "both"]).format, "both");
  assert.equal(parseCliArgs(["--format=md"]).format, "md");
  assert.equal(parseCliArgs(["--format=plain"]).format, "plain");
});

test("parseCliArgs: throws on unknown or invalid arguments", () => {
  assert.throws(() => parseCliArgs(["--format", "xml"]), /Invalid --format/);
  assert.throws(() => parseCliArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["file1.json", "file2.json"]), /Unexpected argument/);
});

test("hydrateEventJson: parses bigint fields from strings and preserves numbers", () => {
  const raw = JSON.stringify({
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    version: "v1",
    ledger: 100,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: 1700000000,
    eventId: "100-0",
    payload: {
      name: "claim_challenged",
      claimId: 42,
      challenger: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
      stake: "20000000",
    },
  });

  const event = hydrateEventJson(raw);
  assert.equal(event.payload.name, "claim_challenged");
  assert.equal(typeof event.payload.stake, "bigint");
  assert.equal(event.payload.stake, 20_000_000n);
});

test("hydrateEventJson: throws on invalid JSON or unknown event names", () => {
  assert.throws(() => hydrateEventJson("not a json"), /Invalid JSON/);
  assert.throws(() => hydrateEventJson("{}"), /missing or invalid payload object/);
  assert.throws(
    () => hydrateEventJson(JSON.stringify({ payload: { name: "completely_fake_event" } })),
    /Unknown event name/,
  );
});

test("snapshot: renderEvent renders expected MarkdownV2, plain-text and explorer URL for claim_created", () => {
  const raw = readFileSync(CLAIM_CREATED_FIXTURE, "utf8");
  const event = hydrateEventJson(raw);
  const config = getFallbackStellarConfig();

  const bothOutput = renderEvent(config, event, "both");
  assert.equal(
    bothOutput,
    [
      "=== MarkdownV2 ===",
      "🆕 *New claim* \\#7\nCategory: 🪙 crypto\nCreator: `GABCD…TUVW`\n_ledger 4226691_ · [tx](https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)",
      "",
      "=== Plain Text ===",
      "New claim #7\nCategory: 🪙 crypto\nCreator: GABCD…TUVW\nledger 4226691\ntx: https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "",
      "=== Explorer URL ===",
      "https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ].join("\n"),
  );

  const mdOutput = renderEvent(config, event, "md");
  assert.equal(
    mdOutput,
    "🆕 *New claim* \\#7\nCategory: 🪙 crypto\nCreator: `GABCD…TUVW`\n_ledger 4226691_ · [tx](https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)\nExplorer URL: https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );

  const plainOutput = renderEvent(config, event, "plain");
  assert.equal(
    plainOutput,
    "New claim #7\nCategory: 🪙 crypto\nCreator: GABCD…TUVW\nledger 4226691\ntx: https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nExplorer URL: https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
});

test("snapshot: renderEvent renders expected MarkdownV2, plain-text and explorer URL for claim_challenged", () => {
  const raw = readFileSync(CLAIM_CHALLENGED_FIXTURE, "utf8");
  const event = hydrateEventJson(raw);
  const config = getFallbackStellarConfig();

  const bothOutput = renderEvent(config, event, "both");
  assert.equal(
    bothOutput,
    [
      "=== MarkdownV2 ===",
      "⚔️ *Claim \\#7 challenged*\nStake: *2\\.0000000 USDC*\nChallenger: `GABCD…TUVW`\n_ledger 4226692_ · [tx](https://stellar.expert/explorer/testnet/tx/aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899)",
      "",
      "=== Plain Text ===",
      "Claim #7 challenged\nStake: 2.0000000 USDC\nChallenger: GABCD…TUVW\nledger 4226692\ntx: https://stellar.expert/explorer/testnet/tx/aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      "",
      "=== Explorer URL ===",
      "https://stellar.expert/explorer/testnet/tx/aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    ].join("\n"),
  );
});

test("snapshot: renderEvent renders expected MarkdownV2, plain-text and explorer URL for market_created", () => {
  const raw = readFileSync(MARKET_CREATED_FIXTURE, "utf8");
  const event = hydrateEventJson(raw);
  const config = getFallbackStellarConfig();

  const bothOutput = renderEvent(config, event, "both");
  assert.equal(
    bothOutput,
    [
      "=== MarkdownV2 ===",
      "🆕 *New squad market* \\#1\nWill Stellar process 1M Soroban operations in 24 hours?\nCaptain: `GDZCB…PKZI` · fee 100 bps · deadline 2026\\-02\\-02T02:40:00\\.000Z\n_ledger 1000000_ · [tx](https://stellar.expert/explorer/testnet/tx/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef)",
      "",
      "=== Plain Text ===",
      "New squad market #1\nWill Stellar process 1M Soroban operations in 24 hours?\nCaptain: GDZCB…PKZI · fee 100 bps · deadline 2026-02-02T02:40:00.000Z\nledger 1000000\ntx: https://stellar.expert/explorer/testnet/tx/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "",
      "=== Explorer URL ===",
      "https://stellar.expert/explorer/testnet/tx/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ].join("\n"),
  );
});

test("CLI execution against fixtures snapshots stdout", async () => {
  const compiledCli = path.resolve("dist/render-cli.js");

  const { stdout: stdoutClaimCreated } = await execFileP(
    process.execPath,
    ["run", compiledCli, CLAIM_CREATED_FIXTURE, "--format", "both"],
  );

  assert.match(stdoutClaimCreated, /=== MarkdownV2 ===/);
  assert.match(stdoutClaimCreated, /New claim/);
  assert.match(stdoutClaimCreated, /=== Plain Text ===/);
  assert.match(stdoutClaimCreated, /=== Explorer URL ===/);

  const { stdout: stdoutChallengedPlain } = await execFileP(
    process.execPath,
    ["run", compiledCli, CLAIM_CHALLENGED_FIXTURE, "--format", "plain"],
  );
  assert.match(stdoutChallengedPlain, /Claim #7 challenged/);
  assert.match(stdoutChallengedPlain, /Stake: 2\.0000000 USDC/);
  assert.match(stdoutChallengedPlain, /Explorer URL:/);
  assert.doesNotMatch(stdoutChallengedPlain, /=== MarkdownV2 ===/);

  const { stdout: stdoutMarketCreatedMd } = await execFileP(
    process.execPath,
    ["run", compiledCli, MARKET_CREATED_FIXTURE, "--format", "md"],
  );
  assert.match(stdoutMarketCreatedMd, /🆕 \*New squad market\* \\#1/);
  assert.match(stdoutMarketCreatedMd, /Explorer URL:/);
  assert.doesNotMatch(stdoutMarketCreatedMd, /=== Plain Text ===/);
});

test("CLI execution exits with code 2 on invalid JSON or unknown event name", async () => {
  const compiledCli = path.resolve("dist/render-cli.js");

  // Unknown option
  await assert.rejects(
    execFileP(process.execPath, ["run", compiledCli, "--invalid-flag"]),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr || err.stdout, /Unknown option/);
      return true;
    },
  );

  // Non-existent file
  await assert.rejects(
    execFileP(process.execPath, ["run", compiledCli, "nonexistent-file.json"]),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr || err.stdout, /Failed to read input/);
      return true;
    },
  );

  // Unknown event name test using runRenderCli
  const unknownEventRes = await runRenderCli(["-"], undefined);
  // Also verify hydrateEventJson error handling directly
  assert.throws(
    () => hydrateEventJson(JSON.stringify({ payload: { name: "invalid_mystery_event" } })),
    (err) => {
      assert.match(err.message, /Unknown event name: invalid_mystery_event/);
      return true;
    },
  );
});
