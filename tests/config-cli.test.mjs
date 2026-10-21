import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DIST_CLI = fileURLToPath(new URL("../dist/config-cli.js", import.meta.url));

const canaryAuth = ["123456789:", "CANARY_AUTH_VALUE_NEVER_LEAK"].join("");
const canaryChat = "-1001234567890";
const VALID_MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-config-cli-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runCli({ args = [], env = {}, cwd } = {}) {
  try {
    const result = await execFileP(
      process.execPath,
      [DIST_CLI, ...args],
      {
        cwd,
        env: { PATH: process.env.PATH, ...env },
        timeout: 30_000,
      },
    );
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const FAKE_VALID_ENV = {
  MARKET_CONTRACT_ID: VALID_MARKET_ID,
  SQUAD_CONTRACT_ID: VALID_SQUAD_ID,
  BOT_TOKEN: canaryAuth,
  TELEGRAM_CHAT_ID: canaryChat,
  POLL_INTERVAL_MS: "45000",
};

test("prints key, source, and value with secrets redacted in text mode", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout, stderr } = await runCli({
      cwd: dir,
      env: FAKE_VALID_ENV,
    });

    assert.equal(code, 0, `cli should exit 0, got ${code}; stderr: ${stderr}`);
    assert.match(stdout, /Key\s+Source\s+Value/);

    // Verify secrets are redacted
    assert.match(stdout, /BOT_TOKEN\s+env\s+\[REDACTED\]/);
    assert.match(stdout, /TELEGRAM_CHAT_ID\s+env\s+\[REDACTED\]/);
    assert.equal(stdout.includes(canaryAuth), false, "bot token must never be printed");
    assert.equal(stdout.includes(canaryChat), false, "chat id must never be printed");

    // Verify non-secrets are visible
    assert.match(stdout, /MARKET_CONTRACT_ID\s+env\s+CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI/);
    assert.match(stdout, /POLL_INTERVAL_MS\s+env\s+45000/);

    // Verify default sources
    assert.match(stdout, /STELLAR_EXPLORER_BASE_URL\s+default/);
    assert.match(stdout, /MAX_NOTIFICATIONS_PER_CYCLE\s+default\s+20/);
  });
});

test("supports --json and redacts secrets in JSON output", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout, stderr } = await runCli({
      args: ["--json"],
      cwd: dir,
      env: FAKE_VALID_ENV,
    });

    assert.equal(code, 0, `cli should exit 0, got ${code}; stderr: ${stderr}`);

    const report = JSON.parse(stdout);
    assert.ok(Array.isArray(report.entries), "report must have entries array");
    assert.ok(Array.isArray(report.warnings), "report must have warnings array");

    const tokenEntry = report.entries.find((e) => e.key === "BOT_TOKEN");
    assert.ok(tokenEntry, "BOT_TOKEN must be in entries");
    assert.equal(tokenEntry.source, "env");
    assert.equal(tokenEntry.value, "[REDACTED]");
    assert.equal(tokenEntry.secret, true);

    const chatEntry = report.entries.find((e) => e.key === "TELEGRAM_CHAT_ID");
    assert.ok(chatEntry, "TELEGRAM_CHAT_ID must be in entries");
    assert.equal(chatEntry.source, "env");
    assert.equal(chatEntry.value, "[REDACTED]");

    const marketEntry = report.entries.find((e) => e.key === "MARKET_CONTRACT_ID");
    assert.ok(marketEntry, "MARKET_CONTRACT_ID must be in entries");
    assert.equal(marketEntry.source, "env");
    assert.equal(marketEntry.value, VALID_MARKET_ID);
    assert.equal(marketEntry.secret, false);

    const pollEntry = report.entries.find((e) => e.key === "POLL_INTERVAL_MS");
    assert.ok(pollEntry);
    assert.equal(pollEntry.source, "env");
    assert.equal(pollEntry.value, "45000");

    const defaultEntry = report.entries.find((e) => e.key === "MAX_NOTIFICATIONS_PER_CYCLE");
    assert.ok(defaultEntry);
    assert.equal(defaultEntry.source, "default");
    assert.equal(defaultEntry.value, "20");

    // Canaries must not leak anywhere in the JSON output
    assert.equal(stdout.includes(canaryAuth), false);
    assert.equal(stdout.includes(canaryChat), false);
  });
});

test("warns about unknown/unused environment keys with known prefixes", async () => {
  await withTempDir(async (dir) => {
    const typoVal = ["sec", "ret123"].join("");
    const { code, stdout, stderr } = await runCli({
      args: ["--json"],
      cwd: dir,
      env: {
        ...FAKE_VALID_ENV,
        TELEGRAM_TYPO_TOKEN: typoVal,
        STELLAR_UNKNOWN_SETTING: "something",
        UNRELATED_VARIABLE: "should-not-warn",
      },
    });

    assert.equal(code, 0);
    const report = JSON.parse(stdout);

    const typoWarning = report.warnings.find((w) => w.includes("TELEGRAM_TYPO_TOKEN"));
    assert.ok(typoWarning, "must warn about TELEGRAM_TYPO_TOKEN");

    const stellarWarning = report.warnings.find((w) => w.includes("STELLAR_UNKNOWN_SETTING"));
    assert.ok(stellarWarning, "must warn about STELLAR_UNKNOWN_SETTING");

    const unrelatedWarning = report.warnings.find((w) => w.includes("UNRELATED_VARIABLE"));
    assert.equal(unrelatedWarning, undefined, "unrelated env key must not be warned about");

    // Secret value of unused key must never be printed
    assert.equal(stdout.includes(typoVal), false);
    assert.equal(stderr.includes(typoVal), false);
  });
});

test("exits non-zero and prints validation message when config fails to load", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout, stderr } = await runCli({
      cwd: dir,
      env: {}, // Missing all required configuration
    });

    assert.notEqual(code, 0, "must exit non-zero when config is invalid");
    const combinedOutput = `${stdout}\n${stderr}`;
    assert.match(combinedOutput, /Invalid configuration/i);
    assert.match(combinedOutput, /MARKET_CONTRACT_ID is required/i);
    assert.match(combinedOutput, /BOT_TOKEN is required/i);
  });
});

test("reports profile defaults as 'profile' source", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout } = await runCli({
      args: ["--json"],
      cwd: dir,
      env: {
        MIMIR_PROFILE: "mock",
        HEALTH_PORT: "0",
      },
    });

    assert.equal(code, 0);
    const report = JSON.parse(stdout);

    const tokenEntry = report.entries.find((e) => e.key === "BOT_TOKEN");
    assert.equal(tokenEntry.source, "profile");
    assert.equal(tokenEntry.value, "[REDACTED]");

    const marketEntry = report.entries.find((e) => e.key === "MARKET_CONTRACT_ID");
    assert.equal(marketEntry.source, "profile");

    const profileEntry = report.entries.find((e) => e.key === "MIMIR_PROFILE");
    assert.equal(profileEntry.source, "env");
    assert.equal(profileEntry.value, "mock");
  });
});

test("reports values supplied by .env file as '.env' source", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, ".env"),
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${canaryAuth}`,
        `TELEGRAM_CHAT_ID=${canaryChat}`,
        `POLL_INTERVAL_MS=50000`,
      ].join("\n"),
    );

    const { code, stdout } = await runCli({
      args: ["--json"],
      cwd: dir,
      env: {},
    });

    assert.equal(code, 0);
    const report = JSON.parse(stdout);

    const tokenEntry = report.entries.find((e) => e.key === "BOT_TOKEN");
    assert.equal(tokenEntry.source, ".env");
    assert.equal(tokenEntry.value, "[REDACTED]");

    const pollEntry = report.entries.find((e) => e.key === "POLL_INTERVAL_MS");
    assert.equal(pollEntry.source, ".env");
    assert.equal(pollEntry.value, "50000");

    assert.equal(stdout.includes(canaryAuth), false);
    assert.equal(stdout.includes(canaryChat), false);
  });
});
