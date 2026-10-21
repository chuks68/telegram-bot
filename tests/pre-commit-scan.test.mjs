import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRE_COMMIT_SCRIPT = path.resolve(__dirname, "../scripts/pre-commit.mjs");

// Deterministic lookalike token assembled at runtime so this test file contains no literal secret
const FAKE_BOT_TOKEN = ["123456789:AA", "x".repeat(33)].join("");

async function makeTempRepo() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-commit-test-"));
  await execFileP("git", ["init"], { cwd: tmpDir });
  await execFileP("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
  await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
  return tmpDir;
}

test("pre-commit script exits 0 when no files are staged", async () => {
  const repo = await makeTempRepo();
  try {
    const { stdout } = await execFileP("node", [PRE_COMMIT_SCRIPT], { cwd: repo });
    assert.equal(stdout.trim(), "");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("pre-commit script exits 0 when clean files are staged", async () => {
  const repo = await makeTempRepo();
  try {
    const file = path.join(repo, "clean.ts");
    await fs.writeFile(file, "export const meaning = 42;\n", "utf8");
    await execFileP("git", ["add", "clean.ts"], { cwd: repo });

    const { stdout } = await execFileP("node", [PRE_COMMIT_SCRIPT], { cwd: repo });
    assert.match(stdout, /pre-commit secret scan ok — 1 staged file\(s\) scanned, 0 findings/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("pre-commit script exits non-zero and prints only redacted preview when a fake token is staged", async () => {
  const repo = await makeTempRepo();
  try {
    const file = path.join(repo, "leaky.ts");
    await fs.writeFile(file, ["const ", "token", " = ", JSON.stringify(FAKE_BOT_TOKEN), ";\n"].join(""), "utf8");
    await execFileP("git", ["add", "leaky.ts"], { cwd: repo });

    let threw = false;
    try {
      await execFileP("node", [PRE_COMMIT_SCRIPT], { cwd: repo });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 1);
      const output = (err.stdout || "") + (err.stderr || "");
      // Redaction requirement: must print redacted preview, never the raw token
      assert.ok(output.includes("[REDACTED]"), "output must be redacted");
      assert.ok(output.includes("telegram-bot-token"), "output must report pattern");
      assert.ok(output.includes("leaky.ts:1"), "output must report file:line");
      assert.ok(!output.includes(FAKE_BOT_TOKEN), "output must never leak raw token");
    }
    assert.ok(threw, "pre-commit script must exit non-zero on secret findings");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("pre-commit script only scans staged contents, ignoring unstaged modifications", async () => {
  const repo = await makeTempRepo();
  try {
    const file = path.join(repo, "test.ts");
    // Stage clean content
    await fs.writeFile(file, "export const safe = true;\n", "utf8");
    await execFileP("git", ["add", "test.ts"], { cwd: repo });

    // Modify working tree with a token but DO NOT stage it
    await fs.writeFile(file, ["const ", "token", " = ", JSON.stringify(FAKE_BOT_TOKEN), ";\n"].join(""), "utf8");

    // Staged scan should pass because only index content is evaluated
    const { stdout } = await execFileP("node", [PRE_COMMIT_SCRIPT], { cwd: repo });
    assert.match(stdout, /pre-commit secret scan ok — 1 staged file\(s\) scanned, 0 findings/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("pre-commit script catches secrets when only added in staged changes", async () => {
  const repo = await makeTempRepo();
  try {
    const file = path.join(repo, "test.ts");
    // Stage secret
    await fs.writeFile(file, ["const ", "token", " = ", JSON.stringify(FAKE_BOT_TOKEN), ";\n"].join(""), "utf8");
    await execFileP("git", ["add", "test.ts"], { cwd: repo });

    // Working tree cleaned up, but index still has the token
    await fs.writeFile(file, "export const safe = true;\n", "utf8");

    let threw = false;
    try {
      await execFileP("node", [PRE_COMMIT_SCRIPT], { cwd: repo });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 1);
      const output = (err.stdout || "") + (err.stderr || "");
      assert.ok(output.includes("[REDACTED]"));
      assert.ok(!output.includes(FAKE_BOT_TOKEN));
    }
    assert.ok(threw, "pre-commit script must inspect staged index content");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
