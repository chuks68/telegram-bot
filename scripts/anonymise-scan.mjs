#!/usr/bin/env node
/**
 * scripts/anonymise-scan.mjs
 *
 * Reads `npm run scan -- --json` output from stdin (or a file passed as argument)
 * and anonymises account addresses and transaction hashes into deterministic fakes
 * derived from a salt.
 *
 * - Keeps contract ids, event names, ledgers, and amounts intact.
 * - Uses valid-looking StrKey addresses (Stellar Ed25519 public keys starting with G)
 *   so decoders and formatters accept them.
 * - Generates deterministic 64-character hex strings for transaction hashes.
 * - Identical input and salt produce identical output.
 *
 * Usage:
 *   npm run scan -- --json | node scripts/anonymise-scan.mjs --salt "my-salt"
 *   node scripts/anonymise-scan.mjs input-scan.json --salt "my-salt" > anonymised.json
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";

export const DEFAULT_SALT = "mimir-deterministic-salt-v1";

/**
 * Anonymiser state mapping original values to deterministic fakes.
 */
export class ScanAnonymiser {
  /**
   * @param {string} [salt]
   */
  constructor(salt = DEFAULT_SALT) {
    this.salt = salt || DEFAULT_SALT;
    /** @type {Map<string, string>} */
    this.addressMap = new Map();
    /** @type {Map<string, string>} */
    this.txHashMap = new Map();
  }

  /**
   * Anonymise a Stellar account address (G... / M... strkey).
   * Generates a valid Ed25519 public key StrKey.
   *
   * @param {string} address
   * @returns {string}
   */
  anonymiseAddress(address) {
    if (this.addressMap.has(address)) {
      return this.addressMap.get(address);
    }
    const rawBytes = createHmac("sha256", this.salt)
      .update(`account:${address}`)
      .digest();
    const fakeKey = StrKey.encodeEd25519PublicKey(rawBytes);
    this.addressMap.set(address, fakeKey);
    return fakeKey;
  }

  /**
   * Anonymise a 32-byte hex transaction hash (64 hex characters).
   *
   * @param {string} txHash
   * @returns {string}
   */
  anonymiseTxHash(txHash) {
    if (this.txHashMap.has(txHash)) {
      return this.txHashMap.get(txHash);
    }
    const fakeHash = createHmac("sha256", this.salt)
      .update(`tx:${txHash.toLowerCase()}`)
      .digest("hex");
    this.txHashMap.set(txHash, fakeHash);
    return fakeHash;
  }

  /**
   * Check if a string is a Stellar account address (starts with G, length 56, or M, length 69).
   * Does NOT match contract IDs (which start with C).
   *
   * @param {unknown} val
   * @returns {val is string}
   */
  isAccountAddress(val) {
    if (typeof val !== "string") return false;
    // Stellar Ed25519 public keys start with G, Med25519 with M.
    // Length for G is 56, M is 69.
    if (/^G[A-Z2-7]{55}$/.test(val) || /^M[A-Z2-7]{68}$/.test(val)) {
      return true;
    }
    return false;
  }

  /**
   * Check if a string is a transaction hash (64 hex characters).
   *
   * @param {unknown} val
   * @returns {val is string}
   */
  isTxHash(val) {
    if (typeof val !== "string") return false;
    return /^[0-9a-fA-F]{64}$/.test(val);
  }

  /**
   * Anonymise a single decoded event.
   *
   * @param {Record<string, unknown>} event
   * @returns {Record<string, unknown>}
   */
  anonymiseEvent(event) {
    if (!event || typeof event !== "object") return event;

    const out = { ...event };

    // Anonymise event-level txHash
    if (typeof out.txHash === "string" && out.txHash) {
      if (this.isTxHash(out.txHash)) {
        out.txHash = this.anonymiseTxHash(out.txHash);
      }
    }

    // Anonymise payload
    if (out.payload && typeof out.payload === "object" && !Array.isArray(out.payload)) {
      out.payload = this.anonymisePayload(/** @type {Record<string, unknown>} */ (out.payload));
    }

    // Recompute human summary if present
    if (typeof out.summary === "string") {
      out.summary = this.anonymiseSummary(out.summary);
    }

    return out;
  }

  /**
   * Anonymise addresses and hashes inside a decoded event payload.
   *
   * @param {Record<string, unknown>} payload
   * @returns {Record<string, unknown>}
   */
  anonymisePayload(payload) {
    const out = { ...payload };

    for (const [key, val] of Object.entries(out)) {
      if (typeof val === "string") {
        if (this.isAccountAddress(val)) {
          out[key] = this.anonymiseAddress(val);
        } else if (this.isTxHash(val)) {
          out[key] = this.anonymiseTxHash(val);
        }
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        // e.g. details dictionary in admin payloads
        const nested = { ...val };
        for (const [nKey, nVal] of Object.entries(nested)) {
          if (typeof nVal === "string") {
            if (this.isAccountAddress(nVal)) {
              nested[nKey] = this.anonymiseAddress(nVal);
            } else if (this.isTxHash(nVal)) {
              nested[nKey] = this.anonymiseTxHash(nVal);
            }
          }
        }
        out[key] = nested;
      }
    }

    return out;
  }

  /**
   * Replace any known account addresses or shortened addresses in the summary text.
   *
   * @param {string} summary
   * @returns {string}
   */
  anonymiseSummary(summary) {
    let result = summary;
    for (const [orig, fake] of this.addressMap.entries()) {
      if (result.includes(orig)) {
        result = result.replaceAll(orig, fake);
      }
      // Check for shortAddress format: GAAAA...ZZZZ (5 chars + ellipsis + 4 chars)
      const shortOrig = `${orig.slice(0, 5)}…${orig.slice(-4)}`;
      const shortFake = `${fake.slice(0, 5)}…${fake.slice(-4)}`;
      if (result.includes(shortOrig)) {
        result = result.replaceAll(shortOrig, shortFake);
      }
    }
    for (const [orig, fake] of this.txHashMap.entries()) {
      if (result.includes(orig)) {
        result = result.replaceAll(orig, fake);
      }
    }
    return result;
  }

  /**
   * Anonymise an entire scan JSON report or raw scan object.
   *
   * @param {Record<string, unknown>} report
   * @returns {Record<string, unknown>}
   */
  anonymiseReport(report) {
    if (!report || typeof report !== "object") return report;

    const out = { ...report };

    // ScanJsonReport format: { format, network, rpcUrl, ledgers, targets: [ ... ] }
    if (Array.isArray(out.targets)) {
      out.targets = out.targets.map((target) => {
        if (!target || typeof target !== "object") return target;
        const targetCopy = { ...target };
        if (Array.isArray(targetCopy.events)) {
          targetCopy.events = targetCopy.events.map((ev) => this.anonymiseEvent(ev));
        }
        return targetCopy;
      });
    }

    // Direct target or single scan object with events array: { events: [ ... ] }
    if (Array.isArray(out.events)) {
      out.events = out.events.map((ev) => this.anonymiseEvent(ev));
    }

    // Fixture file format: { config, cases: [ { event, ... } ] }
    if (Array.isArray(out.cases)) {
      out.cases = out.cases.map((c) => {
        if (!c || typeof c !== "object") return c;
        const cCopy = { ...c };
        if (cCopy.event && typeof cCopy.event === "object") {
          cCopy.event = this.anonymiseEvent(cCopy.event);
        }
        return cCopy;
      });
    }

    return out;
  }
}

/**
 * Anonymise scan JSON object or string.
 *
 * @param {string | Record<string, unknown>} input
 * @param {string} [salt]
 * @returns {Record<string, unknown>}
 */
export function anonymiseScan(input, salt = DEFAULT_SALT) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const anonymiser = new ScanAnonymiser(salt);
  return anonymiser.anonymiseReport(parsed);
}

// ── CLI Execution ────────────────────────────────────────────────────────────

function parseCliArgs() {
  const args = process.argv.slice(2);
  let salt = DEFAULT_SALT;
  let file = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  node scripts/anonymise-scan.mjs [options] [file]

Options:
  --salt <string>   Salt used to derive deterministic fake addresses and hashes
  --help, -h        Show this help message

Examples:
  npm run scan -- --json | node scripts/anonymise-scan.mjs --salt "my-salt"
  node scripts/anonymise-scan.mjs scan-output.json --salt "my-salt"
`);
      process.exit(0);
    } else if (arg === "--salt") {
      salt = args[++i] || DEFAULT_SALT;
    } else if (arg.startsWith("--salt=")) {
      salt = arg.slice(7) || DEFAULT_SALT;
    } else if (!arg.startsWith("-") && !file) {
      file = arg;
    }
  }

  return { salt, file };
}

async function runCli() {
  const { salt, file } = parseCliArgs();

  let inputData = "";
  if (file) {
    inputData = readFileSync(file, "utf8");
  } else {
    // Read from standard input
    if (process.stdin.isTTY) {
      console.error("[anonymise-scan] Reading JSON from stdin... (pass a file path or pipe JSON)");
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    inputData = Buffer.concat(chunks).toString("utf8");
  }

  if (!inputData.trim()) {
    console.error("[anonymise-scan] Error: empty input");
    process.exit(1);
  }

  try {
    const report = JSON.parse(inputData);
    const anonymised = anonymiseScan(report, salt);
    process.stdout.write(JSON.stringify(anonymised, null, 2) + "\n");
  } catch (err) {
    console.error(`[anonymise-scan] Error parsing or anonymising JSON: ${err.message}`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url.endsWith(invokedPath.replace(/\\/g, "/"))) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
