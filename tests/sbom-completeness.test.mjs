/**
 * SBOM completeness: `generateSbom()` walks `node_modules`, so the document it
 * emits silently loses packages whenever an install goes missing or drifts from
 * the lockfile. These tests pin the contract that matters to a supply-chain
 * audit: every runtime dependency declared in `package.json` must appear in the
 * SBOM at exactly the version `package-lock.json` pins, and dev dependencies
 * must be treated consistently — either excluded from the SBOM or listed at
 * their locked version, never drifted. Failure messages name the offending
 * package so a regression points straight at it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateSbom } from "../dist/sbom.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

const sbom = generateSbom(root);

/** Every version the SBOM reports for a package name. */
const sbomVersions = new Map();
for (const entry of sbom.packages) {
  if (!sbomVersions.has(entry.name)) sbomVersions.set(entry.name, new Set());
  sbomVersions.get(entry.name).add(entry.versionInfo);
}

/** The top-level version `package-lock.json` pins for a direct dependency. */
function lockedVersion(name) {
  return lock.packages?.[`node_modules/${name}`]?.version;
}

/** Every version the lockfile pins for a name, hoisted or nested. */
function allLockedVersions(name) {
  const suffix = `/node_modules/${name}`;
  const versions = new Set();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === `node_modules/${name}` || key.endsWith(suffix)) {
      if (entry.version) versions.add(entry.version);
    }
  }
  return versions;
}

test("package.json declares runtime dependencies", () => {
  assert.ok(
    Object.keys(pkg.dependencies ?? {}).length > 0,
    "package.json must declare runtime dependencies; an empty list would make the SBOM checks vacuous",
  );
});

test("SBOM lists every runtime dependency at the lockfile version", () => {
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const expected = lockedVersion(name);
    assert.ok(expected, `package-lock.json has no entry for runtime dependency "${name}"`);
    assert.equal(
      lock.packages[`node_modules/${name}`].dev,
      undefined,
      `package-lock.json marks runtime dependency "${name}" as dev-only; it would be dropped from a production install`,
    );

    const versions = sbomVersions.get(name);
    assert.ok(versions, `SBOM is missing runtime dependency "${name}"`);
    assert.ok(
      versions.has(expected),
      `SBOM lists runtime dependency "${name}" at ${[...versions].join(", ")} but package-lock.json pins ${expected}`,
    );
  }
});

test("SBOM treats dev dependencies consistently with the lockfile", () => {
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    const expected = lockedVersion(name);
    assert.ok(expected, `package-lock.json has no entry for dev dependency "${name}"`);

    // The SBOM format carries no dev marker, so a dev dependency must be
    // either excluded entirely (production install) or present at exactly the
    // version the lockfile pins. A present-but-drifted version is the failure.
    const versions = sbomVersions.get(name);
    if (!versions) continue;
    assert.ok(
      versions.has(expected),
      `SBOM lists dev dependency "${name}" at ${[...versions].join(", ")} but package-lock.json pins ${expected}`,
    );
  }
});

test("every SBOM package version is pinned by the lockfile", () => {
  for (const [name, versions] of sbomVersions) {
    const pinned = allLockedVersions(name);
    for (const version of versions) {
      assert.ok(
        pinned.has(version),
        `SBOM lists "${name}" at ${version}, which package-lock.json does not pin`,
      );
    }
  }
});
