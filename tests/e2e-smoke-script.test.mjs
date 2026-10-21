import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runSmoke } from "../scripts/e2e-smoke.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scriptPath = path.join(root, "scripts", "e2e-smoke.mjs");

test("e2e-smoke script: runs successfully CLI with reduced cycle count", async () => {
  const { stdout } = await execFileAsync("node", [scriptPath, "--cycles", "1", "--interval", "20"], {
    cwd: root,
    timeout: 30_000,
  });

  assert.match(stdout, /\[e2e-smoke\] PASSED/);
  assert.match(stdout, /1 cycles, 9 notifications sent, 0 failed, 1 skipped/);
});

test("e2e-smoke module: runSmoke returns ok with reduced cycle count", async () => {
  const result = await runSmoke({ cycles: 1, intervalMs: 20, timeoutMs: 20_000 });
  assert.equal(result.ok, true);
  assert.equal(result.mismatches.length, 0);
  assert.ok(result.cycles >= 1);
  assert.equal(result.notificationsSent, 9);
  assert.equal(result.notificationsFailed, 0);
  assert.equal(result.eventsSkipped, 1);
  assert.equal(result.sentMessages.length, 9);
});
