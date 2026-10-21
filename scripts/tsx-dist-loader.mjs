/**
 * tsx-dist-loader.mjs  —  preload script for `test:fast`
 *
 * Usage:  node --import ./scripts/tsx-dist-loader.mjs --test ...
 *
 * 1. Imports tsx/esm to register tsx's TypeScript hooks.
 * 2. Registers our own resolve hook (tsx-dist-hooks.mjs) via
 *    module.register() so it sits in the SAME off-thread hook chain
 *    as tsx.  Hooks registered later wrap earlier ones, so our
 *    resolve runs first and can rewrite dist/*.js → src/*.ts before
 *    tsx's resolver ever sees the specifier.
 */

import { register } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Step 1 — let tsx register its hooks first.
await import("tsx/esm");

// Step 2 — register our dist→src rewrite hook ON TOP of tsx.
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

register("./tsx-dist-hooks.mjs", import.meta.url, {
  data: { root: ROOT },
});
