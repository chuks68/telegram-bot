/**
 * Operator-facing formatting for decoded admin events.
 *
 * Plain-text formatting for operator notifications and audit logging.
 * Admin events (oracle changes, ownership transfers, fee policy updates, etc.)
 * are skipped for public Telegram chats, but operators still need concise,
 * sanitized, and length-bounded representations of what changed.
 */

import { redactText } from "../redact.js";
import { shortAddress, type AdminAuditRecord } from "../stellar/decode.js";

/** Hard upper bound for formatted admin record text. */
export const MAX_ADMIN_FORMAT_LENGTH = 1000;

/** Max characters for an individual field key or value. */
export const MAX_ADMIN_FIELD_LENGTH = 120;

/** Stellar strkey regex pattern: G for account, C for contract. */
const STELLAR_ADDRESS_REGEX = /^[GC][A-Z2-7]{55}$/;

/**
 * Checks whether a given string is a valid Stellar public address or contract ID.
 */
function isStellarAddress(val: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(val);
}

/**
 * Bounds and sanitises a single value for operator-facing output.
 * - Redacts secrets and credential-like strings.
 * - Truncates excessively long values.
 * - Shortens Stellar addresses (G... and C...) using shortAddress.
 */
export function sanitizeField(value: unknown, maxLen = MAX_ADMIN_FIELD_LENGTH): string {
  if (value === null || value === undefined) {
    return "";
  }

  let str = typeof value === "string" ? value : String(value);

  // Collapse consecutive whitespaces and trim
  str = str.replace(/\s+/g, " ").trim();

  // If it's a full Stellar public key or contract address, shorten it
  if (isStellarAddress(str)) {
    return shortAddress(str);
  }

  // Redact secrets and clamp
  const redacted = redactText(str, { maxLen });
  return redacted;
}

/**
 * Format an AdminAuditRecord into concise, operator-facing plain text.
 *
 * Includes:
 * - Event name / type
 * - Ledger number
 * - Transaction link or hash (omitted if missing)
 * - Changed fields (omits missing/undefined fields, never prints 'undefined')
 * - Bounded total output length
 *
 * @param record Decoded AdminAuditRecord or compatible admin event record
 * @returns Bounded, sanitized plain-text representation
 */
export function formatAdminRecord(
  record: AdminAuditRecord,
  maxLength = MAX_ADMIN_FORMAT_LENGTH,
): string {
  if (!record || typeof record !== "object") {
    return "";
  }

  const parts: string[] = [];

  // Event type
  const eventName = record.type ? sanitizeField(record.type) : "unknown_admin_event";
  parts.push(`[admin] ${eventName}`);

  // Ledger
  if (typeof record.ledger === "number" && !Number.isNaN(record.ledger)) {
    parts.push(`ledger ${record.ledger}`);
  }

  // Tx link or hash (prefer explorerUrl, fallback to transactionHash)
  if (record.explorerUrl && typeof record.explorerUrl === "string") {
    parts.push(`tx: ${sanitizeField(record.explorerUrl)}`);
  } else if (record.transactionHash && typeof record.transactionHash === "string") {
    parts.push(`tx: ${sanitizeField(record.transactionHash)}`);
  }

  // Changed fields / details
  const fields: string[] = [];

  // Admin field if present and not already captured
  if (record.admin !== undefined && record.admin !== null && record.admin !== "") {
    fields.push(`admin=${sanitizeField(record.admin)}`);
  }

  // Contract ID if present
  if (record.contractId !== undefined && record.contractId !== null && record.contractId !== "") {
    fields.push(`contract=${sanitizeField(record.contractId)}`);
  }

  // Specific detail fields
  if (record.details && typeof record.details === "object") {
    // Sort keys for deterministic output
    const keys = Object.keys(record.details).sort();
    for (const key of keys) {
      const val = record.details[key];
      // Skip undefined or null values; never print 'undefined'
      if (val === undefined || val === null) {
        continue;
      }
      const sanitizedKey = sanitizeField(key, 40);
      const sanitizedVal = sanitizeField(val);
      if (sanitizedKey.length > 0 && sanitizedVal.length > 0) {
        fields.push(`${sanitizedKey}=${sanitizedVal}`);
      }
    }
  }

  let result: string;
  if (fields.length > 0) {
    result = `${parts.join(" · ")} | ${fields.join(" ")}`;
  } else {
    result = parts.join(" · ");
  }

  if (result.length > maxLength) {
    return `${result.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  return result;
}
