/**
 * Text sanitization for user-generated strings in notifications.
 *
 * Removes bidirectional (bidi) override/embedding controls, zero-width joiners
 * outside emoji sequences, and C0/C1 control characters (except newline) to prevent
 * visual spoofing and formatting distortion in Telegram messages.
 */

import { Logger } from "../logger.js";

/**
 * Unicode Bidirectional Control characters:
 * - U+202A: LEFT-TO-RIGHT EMBEDDING (LRE)
 * - U+202B: RIGHT-TO-LEFT EMBEDDING (RLE)
 * - U+202C: POP DIRECTIONAL FORMATTING (PDF)
 * - U+202D: LEFT-TO-RIGHT OVERRIDE (LRO)
 * - U+202E: RIGHT-TO-LEFT OVERRIDE (RLO)
 * - U+2066: LEFT-TO-RIGHT ISOLATE (LRI)
 * - U+2067: RIGHT-TO-LEFT ISOLATE (RLI)
 * - U+2068: FIRST STRONG ISOLATE (FSI)
 * - U+2069: POP DIRECTIONAL ISOLATE (PDI)
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/**
 * C0 controls (\u0000-\u001F, \u007F) and C1 controls (\u0080-\u009F), except newline (\n, \u000A).
 * Note: \r (\u000D), \t (\u0009), etc., are removed as non-newline C0 controls.
 */
const CONTROLS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu;

/**
 * Match a valid emoji sequence containing ZWJ (U+200D).
 * Handles:
 * - Emoji characters or sequences using Extended_Pictographic
 * - Optional skin tone / presentation selectors / variation selectors (e.g. \uFE0F)
 * - Linked with \u200D to additional Extended_Pictographic sequences
 */
const EMOJI_ZWJ_SEQUENCE = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}]?))+/gu;

/**
 * Remove lone or non-emoji zero-width joiners (ZWJ, U+200D) while preserving valid
 * emoji sequences (such as family, professions, flags, etc.).
 */
function sanitizeZwj(text: string): { result: string; removed: number } {
  if (!text.includes("\u200D")) {
    return { result: text, removed: 0 };
  }

  // Preserve emoji ZWJ sequences by replacing them with placeholders, removing
  // all remaining ZWJ characters, and then restoring the preserved sequences.
  const preservedSequences: string[] = [];
  const placeholderPrefix = "\uE000__ZWJ_EMOJI_";
  const placeholderSuffix = "__\uE001";

  const tokenized = text.replace(EMOJI_ZWJ_SEQUENCE, (match) => {
    const idx = preservedSequences.length;
    preservedSequences.push(match);
    return `${placeholderPrefix}${idx}${placeholderSuffix}`;
  });

  let removed = 0;
  const stripped = tokenized.replace(/\u200D/gu, () => {
    removed++;
    return "";
  });

  const restored = stripped.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, "g"),
    (_match, idStr) => {
      const id = parseInt(idStr, 10);
      return preservedSequences[id] ?? "";
    },
  );

  return { result: restored, removed };
}

/**
 * Sanitize untrusted or user-supplied text before clipping and notification formatting.
 *
 * Removes:
 * - Bidirectional override/embedding/isolate controls: U+202A-U+202E, U+2066-U+2069
 * - Zero-width joiners (U+200D) that do not belong to emoji sequences
 * - C0 and C1 control characters except newline (\n)
 *
 * Legitimate RTL text (Arabic, Hebrew) and valid emoji sequences are preserved.
 *
 * Counts stripped characters and emits a debug log when characters are removed.
 *
 * @param text The input string to sanitize.
 * @returns The sanitized string.
 */
export function sanitizeUserText(text: string): string {
  if (!text) {
    return text;
  }

  let strippedCount = 0;

  // 1. Remove bidi controls
  const withoutBidi = text.replace(BIDI_CONTROLS, () => {
    strippedCount++;
    return "";
  });

  // 2. Remove C0/C1 control characters except \n
  const withoutControls = withoutBidi.replace(CONTROLS_EXCEPT_NEWLINE, () => {
    strippedCount++;
    return "";
  });

  // 3. Remove zero-width joiners outside emoji sequences
  const { result: sanitized, removed: zwjRemoved } = sanitizeZwj(withoutControls);
  strippedCount += zwjRemoved;

  if (strippedCount > 0) {
    Logger.debug("sanitize", `Stripped ${strippedCount} disallowed characters from user text`, {
      action: "sanitize_user_text",
      strippedCount,
    });
  }

  return sanitized;
}
