/**
 * tsx-dist-hooks.mjs  —  off-thread ESM resolve hook
 *
 * Registered via module.register() from tsx-dist-loader.mjs.
 * Runs in the same off-thread hook chain as tsx, so our rewrite
 * executes before tsx's resolver tries to find the file on disk.
 *
 * Mapping rule:
 *   ../dist/<rest>.js  →  <rootDir>/src/<rest>.ts
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

let ROOT;

/** Called once by Node when the hooks worker thread starts. */
export function initialize(data) {
  ROOT = data.root;
}

/**
 * Rewrite a resolved file:// URL that points into dist/ to the
 * corresponding src/*.ts path.  Returns the rewritten URL or null.
 */
function rewriteResolved(resolvedURL) {
  if (!resolvedURL || !resolvedURL.startsWith("file://")) return null;

  const fsPath = fileURLToPath(resolvedURL);
  const normalized = fsPath.replace(/\\/g, "/");

  // Only rewrite paths that live under <ROOT>/dist/
  const distPrefix = ROOT.replace(/\\/g, "/") + "/dist/";
  if (!normalized.startsWith(distPrefix)) return null;

  const rel = normalized.slice(distPrefix.length).replace(/\.js$/, "");
  const tsPath = path.join(ROOT, "src", rel + ".ts");

  if (!fs.existsSync(tsPath)) return null;
  return pathToFileURL(tsPath).href;
}

/**
 * Node.js off-thread resolve hook.
 * We let the default resolver (or tsx) resolve the specifier first,
 * then check if the result points into dist/ and rewrite it.
 *
 * Strategy: try to rewrite the specifier *before* passing to next,
 * so tsx sees src/*.ts instead of dist/*.js.
 */
export async function resolve(specifier, context, nextResolve) {
  // Fast path: only consider relative specifiers containing "dist"
  if (specifier.includes("/dist/") || specifier.includes("\\dist\\")) {
    // Resolve relative to the parent URL to get an absolute file URL
    try {
      const absolute = new URL(specifier, context.parentURL);
      const rewritten = rewriteResolved(absolute.href);
      if (rewritten) {
        return nextResolve(rewritten, { ...context, parentURL: undefined });
      }
    } catch {
      // fall through to default resolution
    }
  }

  return nextResolve(specifier, context);
}
