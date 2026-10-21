import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { startRepl, render, scan, sampleConfig } from "../dist/dev/repl.js";
import { MOCK_MARKET_CONTRACT_ID } from "../dist/stellar/mock-constants.js";

const REPL_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/dev/repl.js");

function runReplPiped(inputCommands, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPL_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        NODE_NO_WARNINGS: "1",
        ...env,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.write(inputCommands.join("\n") + "\n.exit\n");
    child.stdin.end();
  });
}

// ── Acceptance Criteria: Starts Without .env or Network Access ──────────────

test("dev-repl: starts without .env or network credentials in empty environment", async () => {
  const { exitCode, stdout } = await runReplPiped(["help()"], {
    // Strip any possible Telegram or Stellar env vars
    BOT_TOKEN: undefined,
    TELEGRAM_CHAT_ID: undefined,
    STELLAR_RPC_URL: undefined,
  });

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("mimir>"));
  assert.ok(stdout.includes("Mimir Developer REPL"));
  assert.ok(stdout.includes("render(name, overrides?)"));
  assert.ok(stdout.includes("scan(n?)"));
});

// ── Piped Input: render Helper ──────────────────────────────────────────────

test("dev-repl: render helper formats market claim_created event from mock scenario", async () => {
  const { exitCode, stdout } = await runReplPiped(['render("claim_created")']);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("mimir>"));
  assert.ok(stdout.includes("New claim"));
  assert.ok(stdout.includes("#7"));
  assert.ok(stdout.includes("crypto"));
});

test("dev-repl: render helper formats squad market_created event from mock scenario", async () => {
  const { exitCode, stdout } = await runReplPiped(['render("market_created")']);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("New squad market"));
  assert.ok(stdout.includes("#5"));
  assert.ok(stdout.includes("Will Mimir settle its first claim on"));
});

test("dev-repl: render helper applies field overrides correctly", async () => {
  const { exitCode, stdout } = await runReplPiped([
    'render("claim_created", { claimId: 42, category: "sports" })',
  ]);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("#42"));
  assert.ok(stdout.includes("Category: ⚽ sports"));
});

test("dev-repl: render helper formats fixture events not present in default scenario", async () => {
  const { exitCode, stdout } = await runReplPiped([
    'render("claim_cancelled")',
    'render("withdrawal")',
  ]);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("cancelled"));
  assert.ok(stdout.includes("Withdrawal"));
});

// ── Piped Input: scan Helper ────────────────────────────────────────────────

test("dev-repl: scan helper decodes and logs events from in-process mock scenario", async () => {
  const { exitCode, stdout } = await runReplPiped(["scan(3)"]);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("[ledger 990] market: claim_created #7"));
  assert.ok(stdout.includes("[ledger 992] market: claim_challenged #7"));
  assert.ok(stdout.includes("[ledger 993] market: oracle_changed"));
});

test("dev-repl: scan helper defaults to full mock scenario when n is omitted", async () => {
  const { exitCode, stdout } = await runReplPiped(["scan().length"]);

  assert.equal(exitCode, 0);
  // Default mock scenario contains 10 events
  assert.ok(stdout.includes("10"));
});

// ── Preloaded Context Exploration ───────────────────────────────────────────

test("dev-repl: preloaded with decode, format, and mock constants", async () => {
  const { exitCode, stdout } = await runReplPiped([
    "formatUsdc(25000000n)",
    "MOCK_MARKET_CONTRACT_ID",
    "typeof claimCreatedEvent",
    "config.network",
  ]);

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("2.5000000"));
  assert.ok(stdout.includes(MOCK_MARKET_CONTRACT_ID));
  assert.ok(stdout.includes("function"));
  assert.ok(stdout.includes("testnet"));
});

// ── In-Process API Verification ─────────────────────────────────────────────

test("dev-repl: in-process startRepl populates context and executes commands", async () => {
  let outputBuffer = "";

  const inputStream = new Readable({
    read() {
      this.push('formatUsdc(10000000n)\n');
      this.push('scan(1)\n');
      this.push(null);
    },
  });

  const outputStream = new Writable({
    write(chunk, encoding, callback) {
      outputBuffer += chunk.toString("utf8");
      callback();
    },
  });

  const server = startRepl({
    input: inputStream,
    output: outputStream,
    terminal: false,
    useColors: false,
  });

  // Verify server context bindings
  assert.ok(server.context.decode);
  assert.equal(typeof server.context.decodeEvent, "function");
  assert.equal(typeof server.context.formatUsdc, "function");
  assert.ok(server.context.format);
  assert.equal(typeof server.context.formatEvent, "function");
  assert.ok(server.context.mockConstants);
  assert.equal(server.context.MOCK_MARKET_CONTRACT_ID, MOCK_MARKET_CONTRACT_ID);
  assert.ok(server.context.config);
  assert.equal(server.context.sampleConfig.marketContractId, MOCK_MARKET_CONTRACT_ID);
  assert.ok(server.context.fixtures);
  assert.equal(typeof server.context.claimCreatedEvent, "function");
  assert.equal(typeof server.context.render, "function");
  assert.equal(typeof server.context.scan, "function");

  // Wait for stream to finish
  await new Promise((resolve) => inputStream.on("end", resolve));

  assert.ok(outputBuffer.includes("1.0000000"));
});

test("dev-repl: in-process render and scan functions work directly", () => {
  const claimCreatedOutput = render("claim_created", { claimId: 101 });
  assert.ok(claimCreatedOutput.includes("#101"));

  const squadMarketOutput = render("market_created");
  assert.ok(squadMarketOutput.includes("#5"));

  const scanned = scan(2);
  assert.equal(scanned.length, 2);
  assert.equal(scanned[0].payload.name, "claim_created");
  assert.equal(scanned[1].payload.name, "claim_challenged");
});
