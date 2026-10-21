import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { appendAuditFile, auditEntry } from "../dist/audit.js";
import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { createPoller } from "../dist/poller.js";
import { writeStatusFile } from "../dist/status.js";

/**
 * Filesystem fault injection for state-file writers.
 *
 * `mock.method` cannot redefine the non-configurable `fs/promises` exports that
 * the dist modules bind at import time, and live bindings cannot be swapped.
 * Instead we inject real disk faults with read-only directories (POSIX chmod).
 * On Windows chmod read-only directories are not enforced, so those cases are
 * skipped with a reason.
 *
 * For every writer we assert:
 *  - the error is logged with redaction (no secret leaks through),
 *  - the previous file content is intact,
 *  - the process keeps running (no throw, poller survives).
 */

const isWindows = process.platform === "win32";
const BOT_TOKEN = "123456789:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

function faultTest(name, fn) {
  const full = isWindows
    ? `${name} (skipped on Windows: chmod read-only directories are not enforced)`
    : name;
  return test(full, { skip: isWindows }, async () => {
    await withReadOnlyDir(fn);
  });
}

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: BOT_TOKEN,
    chatIds: ["-1001234567890"],
    pollIntervalMs: 5_000,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 20,
    ...overrides,
  };
}

/** Minimal RPC server: healthy, returns an empty page with no cursor. */
function emptyServer() {
  return {
    getHealth: async () => ({
      status: "ok",
      latestLedger: 4226733,
      oldestLedger: 4105773,
    }),
    getEvents: async () => ({
      events: [],
      cursor: null,
      latestLedger: 4226733,
      oldestLedger: 4105773,
    }),
  };
}

/** Capture console.error output; restore in a finally. */
function captureErrors() {
  const errors = [];
  const restore = mock.method(
    console,
    "error",
    (...args) => errors.push(args.join(" ")),
  );
  return { errors, restore };
}

async function withReadOnlyDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-fs-"));
  await chmod(dir, 0o555);
  try {
    return await run(dir);
  } finally {
    await chmod(dir, 0o777).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Status file ──────────────────────────────────────────────────────────────

faultTest(
  "writeStatusFile degrades on EACCES: logs redacted, keeps previous content, returns false",
  async (dir) => {
    const file = path.join(dir, "status.json");
    const previous = JSON.stringify({ cycles: 1, generatedAt: "2026-01-01T00:00:00.000Z" }) + "\n";
    await writeFile(file, previous, "utf8");

    const { errors, restore } = captureErrors();
    try {
      const ok = await writeStatusFile(file, {
        schemaVersion: 1,
        generatedAt: "2026-01-02T00:00:00.000Z",
        cycles: 2,
      });
      assert.equal(ok, false, "writeStatusFile must not throw on an unwritable file");
      assert.ok(
        errors.some((e) => e.includes("could not write")),
        "expected a write failure log",
      );
      assert.ok(
        !errors.some((e) => e.includes(BOT_TOKEN)),
        "bot token must not leak into the status write error log",
      );
      assert.equal(
        await readFile(file, "utf8"),
        previous,
        "previous status file content must be intact",
      );
    } finally {
      restore();
    }
  },
);

// ── Dead-letter file ─────────────────────────────────────────────────────────

faultTest(
  "dead-letter queue degrades on EACCES: logs redacted, keeps previous content, stays in memory",
  async (dir) => {
    const file = path.join(dir, "dead-letter.json");
    const previous = JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [],
    });
    await writeFile(file, previous, "utf8");

    const { errors, restore } = captureErrors();
    try {
      const queue = createDeadLetterQueue({
        filePath: file,
        maxEntries: 5,
        maxAttempts: 3,
        secrets: [BOT_TOKEN],
        now: () => 1_700_000_000_000,
      });
      await queue.load();
      assert.equal(queue.stats().depth, 0);

      const entry = await queue.enqueue({
        source: "market",
        ledger: 1,
        eventName: "claim_cancelled",
        text: "parked message",
        error: new Error(`boom ${BOT_TOKEN}`),
      });
      assert.equal(entry.ledger, 1, "entry must be retained in memory");
      assert.equal(queue.stats().depth, 1, "in-memory depth must reflect the enqueue");

      assert.ok(
        errors.some((e) => e.includes("could not persist queue")),
        "expected a persist failure log",
      );
      assert.ok(
        !errors.some((e) => e.includes(BOT_TOKEN)),
        "bot token must not leak from the persist error log",
      );
      assert.equal(
        await readFile(file, "utf8"),
        previous,
        "previous dead-letter file content must be intact",
      );
    } finally {
      restore();
    }
  },
);

// ── Audit file ───────────────────────────────────────────────────────────────

faultTest(
  "audit append degrades on EACCES: logs redacted via the poller, keeps previous content",
  async (dir) => {
    const file = path.join(dir, "audit.jsonl");
    const previous = '{"v":1,"t":1700000000000,"kind":"boot"}\n';
    await writeFile(file, previous, "utf8");
    // appendAuditFile appends to an existing file, so the file itself must be
    // read-only to force EACCES (a read-only directory only blocks new files).
    await chmod(file, 0o444);

    const { errors, restore } = captureErrors();
    try {
      // appendAuditFile itself throws: it does not catch persistence errors.
      await assert.rejects(
        appendAuditFile(file, [auditEntry("boot")]),
        (err) => err.code === "EACCES",
        "appendAuditFile must surface the EACCES error",
      );
      assert.equal(
        await readFile(file, "utf8"),
        previous,
        "previous audit file content must be intact after a failed append",
      );

      // Through the poller the failure is caught, logged redacted, and the
      // poller keeps running.
      const poller = createPoller({
        config: { ...baseConfig(), auditFile: file, persistAudit: true },
        server: emptyServer(),
        send: async () => undefined,
      });
      poller.audit.record(auditEntry("send_failed", { detail: `token ${BOT_TOKEN}` }));
      await poller.flushAuditFile();

      assert.ok(
        errors.some((e) => e.includes("could not append audit log")),
        "expected an audit append failure log",
      );
      assert.ok(
        !errors.some((e) => e.includes(BOT_TOKEN)),
        "bot token must not leak from the audit error log",
      );
      assert.equal(
        await readFile(file, "utf8"),
        previous,
        "audit file content must be intact",
      );
    } finally {
      restore();
      await chmod(file, 0o777).catch(() => {});
    }
  },
);

// ── Cursor file ──────────────────────────────────────────────────────────────

faultTest(
  "cursor save degrades on EACCES: logs redacted, keeps previous content, poller keeps running",
  async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const previous = JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      targets: { market: { cursor: "100-0", lastEventLedger: 99 } },
    });
    await writeFile(cursorFile, previous, "utf8");
    await chmod(dir, 0o555);

    const { errors, restore } = captureErrors();
    try {
      const poller = createPoller({
        config: { ...baseConfig(), cursorFile },
        server: emptyServer(),
        send: async () => undefined,
      });

      // runCycle always reaches saveCursors("cycle") in its finally block, so an
      // unwritable cursor directory surfaces there without crashing the cycle.
      await poller.runCycle();

      assert.ok(
        errors.some((e) => e.includes("could not persist cursor")),
        "expected a cursor persist failure log",
      );
      assert.ok(
        !errors.some((e) => e.includes(BOT_TOKEN)),
        "bot token must not leak from the cursor persist error log",
      );
      assert.equal(
        await readFile(cursorFile, "utf8"),
        previous,
        "previous cursor file content must be intact",
      );
    } finally {
      restore();
      await chmod(dir, 0o777).catch(() => {});
    }
  },
);
