/**
 * Maximum number of code points allowed in a normalised category.
 */
export const MAX_CATEGORY_LENGTH = 128;

/**
 * Control characters that are stripped during normalisation.
 * Covers C0-C1 controls, format characters and zero-width characters.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;

/**
 * Normalise a free-form category string coming from on-chain data so that
 * configured category filters can be compared robustly.
 *
 * Rules (applied in order):
 *  1. Unicode NFKC normalisation (folds full-width and compatibility variants).
 *  2. Strip control characters (C0/C1, format and zero-width characters).
 *  3. Trim leading and trailing whitespace.
 *  4. Collapse inner whitespace into a single space.
 *  5. Lowercase.
 *  6. Bound the length to MAX_CATEGORY_LENGTH code points.
 *
 * @param raw category string (or any value) to normalise
 * @returns the normalised category string, or "" for null/undefined
 */
export function normalizeCategory(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "";
  }

  let value = typeof raw === "string" ? raw : String(raw);

  // 1. Unicode NFKC normalisation.
  value = value.normalize("NFKC");

  // 2. Strip control characters.
  value = value.replace(CONTROL_CHARS, "");

  // 3. Trim.
  value = value.trim();

  // 4. Collapse inner whitespace.
  value = value.replace(/\s+/g, " ");

  // 5. Lowercase.
  value = value.toLowerCase();

  // 6. Bound length (by code points to avoid splitting surrogate pairs).
  const codePoints = Array.from(value);
  if (codePoints.length > MAX_CATEGORY_LENGTH) {
    value = codePoints.slice(0, MAX_CATEGORY_LENGTH).join("");
  }

  return value;
}
