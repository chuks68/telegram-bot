import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../dist/bot.js";
import {
  DEFAULT_DOCS_PATH,
  checkCommandDocs,
  formatCommandDocs,
  isAllowlistGated,
  isOperatorOnly,
  writeCommandDocs,
} from "../scripts/gen-command-docs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scriptPath = path.join(root, "scripts", "gen-command-docs.mjs");

test("gen-command-docs.mjs --check succeeds on committed docs/commands.md", () => {
  const stdout = execFileSync(process.execPath, [scriptPath, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(stdout, /is up to date/);
});

test("formatCommandDocs generates deterministic output", () => {
  const output1 = formatCommandDocs();
  const output2 = formatCommandDocs();
  assert.equal(output1, output2, "Generated output must be identical across runs");
});

test("generated docs match content of committed docs/commands.md", () => {
  const committed = readFileSync(DEFAULT_DOCS_PATH, "utf8").replace(/\r\n/g, "\n");
  const generated = formatCommandDocs();
  assert.equal(committed, generated, "Committed docs/commands.md must match generated content");
});

test("every command in COMMANDS appears in the generated table with expected metadata", () => {
  const generated = formatCommandDocs();
  const lines = generated.split("\n");

  // Check header
  const headerIdx = lines.findIndex((l) =>
    l.includes("| Command | Description | Operator-only | Allowlist-gated |"),
  );
  assert.ok(headerIdx !== -1, "Header row must match expected columns");

  for (const item of COMMANDS) {
    const cmdPattern = new RegExp(`\\|\\s*\`/${item.command}\`\\s*\\|`);
    const line = lines.find((l) => cmdPattern.test(l));
    assert.ok(line, `Command /${item.command} must appear in the markdown table`);

    // Verify operatorOnly column
    const expectedOperator = item.operatorOnly ? "Yes" : "No";
    // Verify allowlistGated column
    const expectedGated = isAllowlistGated(item) ? "Yes" : "No";

    const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
    // parts: [0: Command, 1: Description, 2: Operator-only, 3: Allowlist-gated]
    assert.equal(parts[0], `\`/${item.command}\``);
    assert.equal(parts[1], item.description);
    assert.equal(parts[2], expectedOperator);
    assert.equal(parts[3], expectedGated);
  }
});

test("operator-only commands are exactly audit, pause, and resume", () => {
  const operatorCommands = COMMANDS.filter(isOperatorOnly).map((c) => c.command);
  assert.deepEqual(operatorCommands.sort(), ["audit", "pause", "resume"].sort());
});

test("allowlist-gated commands are exactly status, contracts, health, and preview", () => {
  const gatedCommands = COMMANDS.filter(isAllowlistGated).map((c) => c.command);
  assert.deepEqual(gatedCommands.sort(), ["contracts", "health", "preview", "status"].sort());
});

test("--check exits non-zero when the target file does not exist", () => {
  const missingPath = path.join(root, "docs", "nonexistent-commands-doc.md");
  assert.throws(
    () => {
      execFileSync(process.execPath, [scriptPath, "--check", `--output=${missingPath}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    (err) => {
      assert.notEqual(err.status, 0);
      return true;
    },
  );
});

test("--check exits non-zero when the target file is stale", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "command-docs-test-"));
  const tempFile = path.join(tempDir, "commands.md");
  try {
    writeFileSync(tempFile, "# Stale Content\n", "utf8");
    assert.throws(
      () => {
        execFileSync(process.execPath, [scriptPath, "--check", `--output=${tempFile}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      (err) => {
        assert.notEqual(err.status, 0);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeCommandDocs correctly writes expected content to custom path", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "command-docs-test-"));
  const tempFile = path.join(tempDir, "commands.md");
  try {
    writeCommandDocs(tempFile);
    const content = readFileSync(tempFile, "utf8");
    assert.equal(content, formatCommandDocs());

    // checkCommandDocs on this file should now succeed
    const checkResult = checkCommandDocs(tempFile);
    assert.equal(checkResult.ok, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
