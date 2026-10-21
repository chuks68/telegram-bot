/**
 * Tests for src/dlq-cli.ts.
 *
 * Covers the dead-letter inspection CLI (`list`, `show <id>`, and
 * `purge [--older-than <dur>] [--yes]`) using isolated temporary files for each
 * subcommand. Verifies chat id redaction (`redactChatId`), dry-run safety when
 * `--yes` is omitted, atomic persistence when `--yes` is passed, and exit code
 * 2 on unknown subcommands or bad arguments.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import {
  listDeadLetters,
  parseDurationMs,
  purgeDeadLetters,
  runDlqCli,
  showDeadLetter,
  USAGE,
} from "../dist/dlq-cli.js";
import { redactChatId } from "../dist/status.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("dist/dlq-cli.js");

const RAW_CHAT_ID = "-1001234567890";
const REDACTED_CHAT_ID = redactChatId(RAW_CHAT_ID);
const RAW_CHANNEL = "@mimir_alerts";
const REDACTED_CHANNEL = redactChatId(RAW_CHANNEL);
const BOT_TOKEN = "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

async function withTempDlq(run, seedEntries = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-cli-"));
  const filePath = path.join(directory, "dead-letter.json");
  let clock = 1_700_000_000_000;

  try {
    if (seedEntries.length > 0) {
      const queue = createDeadLetterQueue({
        filePath,
        maxEntries: 50,
        maxAttempts: 10,
        now: () => clock,
      });
      await queue.load();
      for (const item of seedEntries) {
        if (typeof item.at === "number") clock = item.at;
        await queue.enqueue({
          source: item.source ?? "market",
          ledger: item.ledger,
          eventName: item.eventName ?? "claim_created",
          text: item.text ?? `Notification @ ledger ${item.ledger}`,
          error: item.error ?? `Telegram 429 for chat ${RAW_CHAT_ID}`,
        });
      }
    }
    return await run({ directory, filePath, baseClock: 1_700_000_000_000 });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

// ── list subcommand ───────────────────────────────────────────────────────────

test("list returns parked entries and redacts chat ids in output", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["list", "--file", filePath, "--chat-id", RAW_CHAT_ID],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      assert.equal(io.stderr.length, 0);
      const output = io.stdout.join("\n");
      assert.match(output, /2 entry\(s\)/);
      assert.match(output, /claim_created/);
      assert.match(output, /market_resolved/);
      assert.equal(output.includes(RAW_CHAT_ID), false, "raw numeric chat id must not leak");
      assert.equal(output.includes(REDACTED_CHAT_ID), true, "redacted chat id must appear");

      const entries = await listDeadLetters({ filePath, chatId: RAW_CHAT_ID });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].chatId, REDACTED_CHAT_ID);
      assert.equal(entries[0].lastError?.includes(RAW_CHAT_ID), false);
      assert.equal(entries[0].lastError?.includes(REDACTED_CHAT_ID), true);
    },
    [
      { ledger: 101, eventName: "claim_created", text: "Claim #1 created" },
      { ledger: 102, eventName: "market_resolved", source: "squad", text: "Squad resolved" },
    ],
  );
});

test("list on a missing file succeeds with 0 entries", async () => {
  await withTempDlq(async ({ filePath }) => {
    const io = captureIo();
    const { exitCode } = await runDlqCli({
      argv: ["list", "--file", filePath, "--chat-id", RAW_CHANNEL],
      stdout: io.out,
      stderr: io.err,
    });

    assert.equal(exitCode, 0);
    const output = io.stdout.join("\n");
    assert.match(output, /0 entries/);
    assert.equal(output.includes(RAW_CHANNEL), false);
    assert.equal(output.includes(REDACTED_CHANNEL), true);
  });
});

test("list --json outputs structured JSON with redacted chat ids", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["list", "--file", filePath, "--chat-id", RAW_CHAT_ID, "--json"],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      const rawJson = io.stdout.join("\n");
      assert.equal(rawJson.includes(RAW_CHAT_ID), false);
      const parsed = JSON.parse(rawJson);
      assert.equal(parsed.depth, 1);
      assert.equal(parsed.chatId, REDACTED_CHAT_ID);
      assert.equal(parsed.entries[0].chatId, REDACTED_CHAT_ID);
      assert.equal(parsed.entries[0].ledger, 55);
    },
    [{ ledger: 55, text: `Hello ${RAW_CHAT_ID}` }],
  );
});

// ── show subcommand ───────────────────────────────────────────────────────────

test("show <id> prints entry details with redacted chat id and scrubbed secrets", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const entries = await listDeadLetters({ filePath, chatId: RAW_CHAT_ID });
      assert.equal(entries.length, 1);
      const targetId = entries[0].id;

      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["show", targetId, "--file", filePath, "--chat-id", RAW_CHAT_ID],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      const output = io.stdout.join("\n");
      assert.ok(output.includes(targetId));
      assert.ok(output.includes("claim_challenged"));
      assert.ok(output.includes("Detailed MarkdownV2 body"));
      assert.equal(output.includes(RAW_CHAT_ID), false);
      assert.equal(output.includes(REDACTED_CHAT_ID), true);
      assert.equal(output.includes(BOT_TOKEN), false);

      const shown = await showDeadLetter({ filePath, id: targetId, chatId: RAW_CHAT_ID });
      assert.equal(shown.id, targetId);
      assert.equal(shown.chatId, REDACTED_CHAT_ID);
    },
    [
      {
        ledger: 77,
        eventName: "claim_challenged",
        text: `Detailed MarkdownV2 body for chat ${RAW_CHAT_ID}`,
        error: `send to chat ${RAW_CHAT_ID} failed via bot${BOT_TOKEN}`,
      },
    ],
  );
});

test("show returns exit code 1 when the entry id does not exist", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["show", "market:999:missing:00000000", "--file", filePath],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 1);
      assert.match(io.stderr.join("\n"), /not found/);
    },
    [{ ledger: 10 }],
  );
});

test("show without an <id> prints usage and exits 2", async () => {
  await withTempDlq(async ({ filePath }) => {
    const io = captureIo();
    const { exitCode } = await runDlqCli({
      argv: ["show", "--file", filePath],
      stdout: io.out,
      stderr: io.err,
    });

    assert.equal(exitCode, 2);
    assert.ok(io.stderr.join("\n").includes(USAGE));
  });
});

// ── purge subcommand ──────────────────────────────────────────────────────────

test("purge without --yes performs a dry run and leaves the file untouched", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const beforeRaw = await readFile(filePath, "utf8");
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["purge", "--file", filePath, "--chat-id", RAW_CHAT_ID],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      const output = io.stdout.join("\n");
      assert.match(output, /dry-run/i);
      assert.match(output, /would purge 2 entry\(s\), 0 remaining/);
      assert.equal(output.includes(RAW_CHAT_ID), false);
      assert.equal(output.includes(REDACTED_CHAT_ID), true);

      const afterRaw = await readFile(filePath, "utf8");
      assert.equal(afterRaw, beforeRaw, "dry-run must not modify the queue file");
    },
    [{ ledger: 1 }, { ledger: 2 }],
  );
});

test("purge --yes atomically removes all entries and leaves no .tmp file", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["purge", "--yes", "--file", filePath, "--chat-id", RAW_CHAT_ID],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      assert.match(io.stdout.join("\n"), /purged 2 entry\(s\), 0 remaining/);
      await assert.rejects(() => stat(`${filePath}.tmp`));

      const persisted = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.entries, []);
    },
    [{ ledger: 1 }, { ledger: 2 }],
  );
});

test("purge --older-than <dur> filters by age in dry-run and --yes modes", async () => {
  const t0 = 1_700_000_000_000;
  const hourMs = 3_600_000;

  await withTempDlq(
    async ({ filePath }) => {
      const now = () => t0 + 3 * hourMs;
      const beforeRaw = await readFile(filePath, "utf8");

      // Dry-run with --older-than 90m: only the two oldest entries (3h and 2h old) match.
      const dryIo = captureIo();
      const dryRes = await runDlqCli({
        argv: ["purge", "--older-than", "90m", "--file", filePath],
        now,
        stdout: dryIo.out,
        stderr: dryIo.err,
      });
      assert.equal(dryRes.exitCode, 0);
      assert.match(dryIo.stdout.join("\n"), /dry-run: would purge 2 entry\(s\), 1 remaining/);
      assert.equal(await readFile(filePath, "utf8"), beforeRaw);

      // Commit purge with --yes.
      const commitIo = captureIo();
      const commitRes = await runDlqCli({
        argv: ["purge", "--older-than", "90m", "--yes", "--file", filePath],
        now,
        stdout: commitIo.out,
        stderr: commitIo.err,
      });
      assert.equal(commitRes.exitCode, 0);
      assert.match(commitIo.stdout.join("\n"), /purged 2 entry\(s\), 1 remaining/);

      const remaining = await listDeadLetters({ filePath });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].ledger, 30);

      // Direct API verification.
      const apiRes = await purgeDeadLetters({
        filePath,
        olderThan: "30m",
        yes: false,
        now,
      });
      assert.equal(apiRes.dryRun, true);
      assert.equal(apiRes.purged, 1);
      assert.equal(apiRes.remaining, 0);
    },
    [
      { ledger: 10, at: t0 },               // 3h old
      { ledger: 20, at: t0 + hourMs },      // 2h old
      { ledger: 30, at: t0 + 2 * hourMs },  // 1h old
    ],
  );
});

// ── Usage / unknown subcommands / invalid flags ───────────────────────────────

test("unknown subcommands and invalid flags print usage and exit 2", async () => {
  await withTempDlq(async ({ filePath }) => {
    for (const badArgv of [
      [],
      ["unknown"],
      ["resend"],
      ["list", "--unknown-flag"],
      ["list", "--yes"],
      ["list", "--older-than", "10m"],
      ["purge", "--older-than", "not-a-duration"],
      ["purge", "--older-than"],
      ["show", "id-1", "extra-arg"],
    ]) {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: [...badArgv, "--file", filePath],
        stdout: io.out,
        stderr: io.err,
      });
      assert.equal(exitCode, 2, `expected exitCode 2 for argv=${JSON.stringify(badArgv)}`);
      assert.ok(
        io.stderr.join("\n").includes("usage:"),
        `expected usage in stderr for argv=${JSON.stringify(badArgv)}`,
      );
    }
  });
});

test("subprocess execution exits with code 2 on unknown subcommand", async () => {
  await assert.rejects(
    async () => {
      await execFileAsync(process.execPath, [CLI_PATH, "not-a-command"]);
    },
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /usage:/);
      return true;
    },
  );
});

test("parseDurationMs supports ms, s, m, h, d, w and compound durations", () => {
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("15m"), 900_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("1d"), 86_400_000);
  assert.equal(parseDurationMs("1w"), 7 * 86_400_000);
  assert.equal(parseDurationMs("1h30m"), 5_400_000);
  assert.throws(() => parseDurationMs(""), /requires a duration/);
  assert.throws(() => parseDurationMs("abc"), /invalid --older-than/);
});
