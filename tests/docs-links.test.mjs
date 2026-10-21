import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Remove fenced code blocks and inline code spans so Markdown syntax
 * examples (e.g. `[text](url)`) are not parsed as real links.
 */
export function stripCode(markdown) {
  return markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/^~~~[\s\S]*?^~~~/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/``[\s\S]*?``/g, "")
    .replace(/`[^`\r\n]*`/g, "");
}

/**
 * Extracts raw Markdown links from content.
 */
export function extractLinks(markdown) {
  const cleaned = stripCode(markdown);
  const links = [];

  // Match inline links [text](dest) and images ![alt](dest)
  const inlineRegex = /(?:!?\[[^\]]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let match;
  while ((match = inlineRegex.exec(cleaned)) !== null) {
    links.push(match[1]);
  }

  // Match reference links [id]: dest
  const refRegex = /^\s*\[[^\]]+\]:\s*([^\s]+)/gm;
  while ((match = refRegex.exec(cleaned)) !== null) {
    links.push(match[1]);
  }

  return links;
}

/**
 * Returns the relative file target, ignoring anchors and absolute/external URLs.
 * Returns null if the link is external or purely an anchor.
 */
export function parseRelativeTarget(rawLink) {
  let target = rawLink.trim();

  // Strip enclosing angle brackets if present: <path>
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }

  // Ignore absolute URLs (http:, https:, mailto:, ftp:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    return null;
  }

  // Ignore protocol-relative URLs
  if (target.startsWith("//")) {
    return null;
  }

  // Ignore in-page anchor links
  if (target.startsWith("#")) {
    return null;
  }

  // Strip anchors (#section)
  const hashIndex = target.indexOf("#");
  if (hashIndex !== -1) {
    target = target.slice(0, hashIndex);
  }

  // Strip query parameters (?param=value)
  const queryIndex = target.indexOf("?");
  if (queryIndex !== -1) {
    target = target.slice(0, queryIndex);
  }

  target = target.trim();
  if (!target) {
    return null;
  }

  return target;
}

/**
 * Resolves target relative to source file (or repo root for root-relative paths).
 */
export function resolveTarget(sourceFile, target, root = repoRoot) {
  if (target.startsWith("/")) {
    return path.resolve(root, target.slice(1));
  }
  return path.resolve(path.dirname(sourceFile), target);
}

/**
 * Discover docs/*.md, README.md, and CHANGELOG.md.
 */
export function getTargetMarkdownFiles(root = repoRoot) {
  const files = [];

  const readme = path.join(root, "README.md");
  if (fs.existsSync(readme)) files.push(readme);

  const changelog = path.join(root, "CHANGELOG.md");
  if (fs.existsSync(changelog)) files.push(changelog);

  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir)) {
    const entries = fs.readdirSync(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(docsDir, entry.name));
      }
    }
  }

  return files;
}

test("stripCode removes code blocks and inline spans", () => {
  const input = [
    "Here is [valid](valid.md).",
    "```md",
    "[ignored in fenced](fenced.md)",
    "```",
    "Inline code `[ignored inline](inline.md)` is stripped.",
    "Reference [ref](ref.md) stays.",
  ].join("\n");

  const links = extractLinks(input);
  assert.deepStrictEqual(links, ["valid.md", "ref.md"]);
});

test("parseRelativeTarget correctly filters absolute URLs and anchors", () => {
  assert.strictEqual(parseRelativeTarget("https://stellar.org"), null);
  assert.strictEqual(parseRelativeTarget("http://127.0.0.1:8787"), null);
  assert.strictEqual(parseRelativeTarget("mailto:dev@mimir.test"), null);
  assert.strictEqual(parseRelativeTarget("//cdn.example.com/asset.js"), null);
  assert.strictEqual(parseRelativeTarget("#section-heading"), null);
  assert.strictEqual(parseRelativeTarget("  #anchor  "), null);

  assert.strictEqual(parseRelativeTarget("alerts.md#rpc-failures"), "alerts.md");
  assert.strictEqual(parseRelativeTarget("./state-files.md"), "./state-files.md");
  assert.strictEqual(parseRelativeTarget("../src/index.ts#L42"), "../src/index.ts");
  assert.strictEqual(parseRelativeTarget("<doc.md>"), "doc.md");
  assert.strictEqual(parseRelativeTarget("page.md?version=1#sec"), "page.md");
});

test("relative Markdown links in docs/*.md, README.md, and CHANGELOG.md resolve to existing files", async (t) => {
  const files = getTargetMarkdownFiles();
  assert.ok(files.length > 0, "No markdown files found to check");

  const allBrokenLinks = [];

  for (const filePath of files) {
    const relFile = path.relative(repoRoot, filePath).replace(/\\/g, "/");
    const content = fs.readFileSync(filePath, "utf8");
    const rawLinks = extractLinks(content);

    const brokenInFile = [];

    for (const rawLink of rawLinks) {
      const target = parseRelativeTarget(rawLink);
      if (target === null) {
        continue;
      }

      const resolved = resolveTarget(filePath, target);
      if (!fs.existsSync(resolved)) {
        const failure = {
          file: relFile,
          link: rawLink,
          target,
          resolved: path.relative(repoRoot, resolved).replace(/\\/g, "/"),
        };
        brokenInFile.push(failure);
        allBrokenLinks.push(failure);
      }
    }

    await t.test(`links in ${relFile} resolve`, () => {
      if (brokenInFile.length > 0) {
        const details = brokenInFile
          .map((b) => `  file: ${b.file}\n  link: ${b.link}\n  target: ${b.target}`)
          .join("\n\n");
        assert.fail(`Found broken relative links in ${relFile}:\n${details}`);
      }
    });
  }

  if (allBrokenLinks.length > 0) {
    const summary = allBrokenLinks
      .map((b) => `  file: ${b.file}\n  link: ${b.link}\n  target: ${b.target}`)
      .join("\n\n");
    assert.fail(`Total broken links found (${allBrokenLinks.length}):\n${summary}`);
  }
});
