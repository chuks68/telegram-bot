#!/usr/bin/env node
/**
 * Pre-commit secret scanning hook (issue #604).
 *
 * Scans only staged files and their staged contents for secrets before
 * committing. Exits 0 when clean, non-zero (1) when secret findings are detected.
 *
 * Uses exported functions from scripts/scan-secrets.mjs to ensure pattern
 * parity and redaction guarantees.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatReport, isScannable, scanText } from "./scan-secrets.mjs";

const execFileP = promisify(execFile);

/**
 * List files currently staged in the git index.
 * Uses `git diff --cached --name-only -z` for null-delimited safety.
 */
export async function getStagedFiles(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileP("git", ["diff", "--cached", "--name-only", "-z"], { cwd });
    if (!stdout) return [];
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read the staged contents of a file directly from the git index (`git show :<path>`).
 */
export async function getStagedContent(relPath, cwd = process.cwd()) {
  try {
    // Normalise path separators to POSIX for git blob specifier
    const gitPath = relPath.replace(/\\/g, "/");
    const { stdout } = await execFileP("git", ["show", `:${gitPath}`], {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // File might be deleted or unreadable in the index
    return null;
  }
}

/**
 * Scan all staged files and return findings and count of scanned files.
 */
export async function scanStaged(cwd = process.cwd()) {
  const staged = await getStagedFiles(cwd);
  const scannable = staged.filter((file) => isScannable(file));
  const findings = [];

  for (const relPath of scannable) {
    const text = await getStagedContent(relPath, cwd);
    if (text === null) continue;
    findings.push(...scanText(relPath, text));
  }

  return { findings, scanned: scannable.length };
}

export async function main(cwd = process.cwd()) {
  const { findings, scanned } = await scanStaged(cwd);

  if (findings.length > 0) {
    console.error(formatReport(findings));
    return 1;
  }

  if (scanned > 0) {
    console.log(`pre-commit secret scan ok — ${scanned} staged file(s) scanned, 0 findings`);
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked && (invoked.endsWith("pre-commit.mjs") || invoked.endsWith("pre-commit"))) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(`pre-commit secret scan error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
