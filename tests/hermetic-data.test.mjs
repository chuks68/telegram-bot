/**
 * Hermetic test data guard.
 *
 * Catches tests that reference the repo's real `data/` directory or default
 * cursor file paths directly, which would make test runs order-dependent or
 * pollute the repository.
 *
 * Persistence tests must use `tests/helpers/temp-data.mjs` (createTempDataDir /
 * withTempDataDir) to keep state in ephemeral directories.
 *
 * For justified cases (e.g. testing production default config resolution or
 * Docker volume mounts), an explicit opt-out comment is allowed:
 *   `// hermetic-data: allow` or `// hermetic: allow` or `// hermetic-opt-out`
 *
 * Also asserts that the repo's `data/` directory contains only `.gitkeep`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const TESTS_DIR = path.join(REPO_ROOT, "tests");

/** Regex matching string literals pointing to or inside `data/`. */
export const LITERAL_DATA_PATH_RE =
  /(?:(['"`])(?:\.{0,2}[/\\])?data[/\\][^\r\n'"`]*\1|\bpath\.(?:join|resolve)\s*\(\s*[^)]*['"`]\.{0,2}[/\\]?data['"`])/;

/** Regex matching direct assignment of default cursor file names. */
export const DEFAULT_CURSOR_ASSIGN_RE =
  /(?:cursorFile|cursorPath)\s*:\s*['"`](?:(?:\.{0,2}[/\\])?data[/\\])?cursor(?:\.mock)?\.json['"`]/;

/** Regex matching an explicit opt-out comment. */
export const OPT_OUT_RE =
  /(?:\/\/|\/\*)\s*(?:hermetic(?:-data)?[:\s_-]*(?:allow|ignore|opt[-_]?out)|opt[-_]?out[:\s_-]*hermetic)/i;

/**
 * Scans a source text line-by-line for literal paths into `data/` and default cursor file names.
 *
 * @param {string} source
 * @param {string} [filename="test.mjs"]
 * @returns {Array<{ file: string, line: number, text: string }>}
 */
export function scanSource(source, filename = "test.mjs") {
  const lines = source.split(/\r?\n/);
  const findings = [];

  // Check for a file-level opt-out declaration in the header (first 10 lines)
  const fileOptOut = lines.slice(0, 10).some((line) => OPT_OUT_RE.test(line));
  if (fileOptOut) return [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    // Check line-level opt-out on this line or immediately preceding line
    if (OPT_OUT_RE.test(line)) continue;
    if (idx > 0 && OPT_OUT_RE.test(lines[idx - 1])) continue;

    // Skip pure comment lines (block comments or single-line comments)
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }

    if (LITERAL_DATA_PATH_RE.test(line) || DEFAULT_CURSOR_ASSIGN_RE.test(line)) {
      findings.push({
        file: filename,
        line: idx + 1,
        text: trimmed,
      });
    }
  }

  return findings;
}

/**
 * Recursively discovers test `.mjs` files under a directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function findTestFiles(dir = TESTS_DIR) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.name.endsWith(".mjs") && path.resolve(full) !== path.resolve(__filename)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Asserts that the `data/` directory contains only `.gitkeep`.
 *
 * @param {string} [dataDirPath=DATA_DIR]
 */
export async function assertHermeticDataDir(dataDirPath = DATA_DIR) {
  const entries = await readdir(dataDirPath);
  assert.deepEqual(
    entries,
    [".gitkeep"],
    `data/ must contain only .gitkeep, but found: ${entries.join(", ")}`,
  );
}

// ── Unit Tests: Scanner & Opt-Outs ───────────────────────────────────────────

test("scanSource: flags literal paths into data/ (e.g. ./data/cursor.json, data/dead-letter.json)", () => {
  const src = [
    'const file = "./data/cursor.json";',
    'const queue = "data/dead-letter.json";',
    'const parent = "../data/cursor.json";',
  ].join("\n");
  const findings = scanSource(src, "sample.test.mjs");
  assert.equal(findings.length, 3);
  assert.equal(findings[0].line, 1);
  assert.equal(findings[1].line, 2);
  assert.equal(findings[2].line, 3);
});

test("scanSource: flags path.join with data directory", () => {
  const src = 'const cursor = path.join("data", "cursor.json");';
  const findings = scanSource(src, "sample.test.mjs");
  assert.equal(findings.length, 1);
});

test("scanSource: flags cursorFile assignments pointing to default cursor files", () => {
  const src = 'const config = { cursorFile: "./data/cursor.json" };';
  const findings = scanSource(src, "sample.test.mjs");
  assert.equal(findings.length, 1);
});

test("scanSource: passes clean source using ephemeral temp-data helper", () => {
  const clean = [
    'import { withTempDataDir } from "./helpers/temp-data.mjs";',
    "test('resumes', () =>",
    "  withTempDataDir(async (dir) => {",
    '    const cursorFile = dir.file("cursor.json");',
    "    const poller = createPoller({ config: makeConfig(cursorFile) });",
    "  }));",
  ].join("\n");
  const findings = scanSource(clean, "clean.test.mjs");
  assert.deepEqual(findings, []);
});

test("scanSource: does not flag documentation comments mentioning data/ directory", () => {
  const docs = [
    "/**",
    " * Nothing here touches the repo's data/ directory or live RPC.",
    " * Run against an ephemeral data directory.",
    " */",
    "// Tests never write to data/cursor.json",
  ].join("\n");
  const findings = scanSource(docs, "docs.test.mjs");
  assert.deepEqual(findings, []);
});

test("scanSource: does not flag temp paths containing /tmp/data/", () => {
  const tmp = 'cursorQuarantinePath("/tmp/data/cursor.json", at);';
  const findings = scanSource(tmp, "quarantine.test.mjs");
  assert.deepEqual(findings, []);
});

test("scanSource: respects same-line opt-out comments for justified cases", () => {
  const justified = [
    'assert.equal(config.cursorFile, path.resolve("./data/cursor.json")); // hermetic-data: allow',
    'assert.equal(config.cursorFile, path.resolve("./data/cursor.mock.json")); // hermetic: allow',
    'assert.equal(isScannable("data/cursor.json"), false); // hermetic-opt-out',
  ].join("\n");
  const findings = scanSource(justified, "justified.test.mjs");
  assert.deepEqual(findings, []);
});

test("scanSource: respects preceding-line opt-out comments", () => {
  const justified = [
    "// hermetic-data: allow (verifies production config default)",
    'assert.ok(configSrc.includes(\'cursorFile: "./data/cursor.json"\'));',
  ].join("\n");
  const findings = scanSource(justified, "justified.test.mjs");
  assert.deepEqual(findings, []);
});

test("scanSource: respects file-level opt-out comments", () => {
  const fileWithHeaderOptOut = [
    "/**",
    " * // hermetic-data: opt-out",
    " */",
    'const file = "./data/cursor.json";',
  ].join("\n");
  const findings = scanSource(fileWithHeaderOptOut, "opted-out.test.mjs");
  assert.deepEqual(findings, []);
});

// ── Integration Tests: Repo Scan & Directory Invariant ───────────────────────

test("tests/**/*.mjs: all test files are hermetic and do not reference the real data/ directory", () => {
  const testFiles = findTestFiles(TESTS_DIR);
  assert.ok(testFiles.length >= 100, `expected at least 100 test files, found ${testFiles.length}`);

  const violations = [];
  for (const filePath of testFiles) {
    const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
    const content = fs.readFileSync(filePath, "utf8");
    const findings = scanSource(content, rel);
    violations.push(...findings);
  }

  if (violations.length > 0) {
    const report = violations
      .map((v) => `  - ${v.file}:${v.line} -> ${v.text}`)
      .join("\n");
    assert.fail(
      `Found ${violations.length} non-hermetic reference(s) to repo data/ directory or default cursor paths:\n${report}\n\nUse createTempDataDir/withTempDataDir from tests/helpers/temp-data.mjs, or add '// hermetic-data: allow' if justified.`,
    );
  }
});

test("data/ directory contains only .gitkeep", async () => {
  await assertHermeticDataDir(DATA_DIR);
});

test.after(async () => {
  await assertHermeticDataDir(DATA_DIR);
});
