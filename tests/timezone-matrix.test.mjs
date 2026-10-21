import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const TIMEZONES = [
  "Pacific/Kiritimati",
  "America/St_Johns",
  "Asia/Kathmandu",
];

const TARGET_TEST_FILES = [
  "tests/format.test.mjs",
  "tests/chain-clock.test.mjs",
  "tests/cursor-window.test.mjs",
];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runTestUnderTimezone(tz, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", file], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        TZ: tz,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn node for TZ=${tz} on ${file}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const failureDetails = stderr || stdout;
        const msg = `Test run failed under time zone ${tz} for ${file} (exit code ${code}${signal ? `, signal ${signal}` : ""}):\n${failureDetails}`;
        console.error(`[timezone-matrix] Error: ${msg}`);
        reject(new Error(msg));
      }
    });
  });
}

test("timezone-matrix: formatters and time-sensitive tests pass under various time zones", async (t) => {
  for (const tz of TIMEZONES) {
    await t.test(`TZ=${tz}`, async () => {
      for (const file of TARGET_TEST_FILES) {
        try {
          await runTestUnderTimezone(tz, file);
        } catch (err) {
          console.error(`Failed for time zone: ${tz}`);
          throw err;
        }
      }
    });
  }
});
