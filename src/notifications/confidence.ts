/**
 * Visual confidence indicator for claim resolution events.
 *
 * Renders a compact, 10-step progress bar and percentage for oracle
 * confidence values, clamped to 0–100%. Out-of-range values are clamped for
 * the bar and percentage display, with a `(raw: N)` suffix appended so buggy
 * or unexpected contract values remain visible. Non-integer and NaN inputs
 * are handled safely.
 *
 * Bar characters:
 * - Filled: █ (U+2588)
 * - Empty: ░ (U+2591)
 * Neither character is reserved in Telegram MarkdownV2 (`_*[]()~`>#+-=|{}.!\`).
 */

export const CONFIDENCE_BAR_STEPS = 10;
export const CONFIDENCE_BAR_FILLED = "█";
export const CONFIDENCE_BAR_EMPTY = "░";

/**
 * Format a resolution confidence value as a 10-step bar plus percentage.
 *
 * Examples:
 * - 0   -> `░░░░░░░░░░ 0%`
 * - 50  -> `█████░░░░░ 50%`
 * - 100 -> `██████████ 100%`
 * - -5  -> `░░░░░░░░░░ 0% (raw: -5)`
 * - 250 -> `██████████ 100% (raw: 250)`
 * - NaN -> `░░░░░░░░░░ 0% (raw: NaN)`
 *
 * @param value Raw confidence value (number or unknown)
 * @returns Formatted confidence indicator string
 */
export function confidenceIndicator(value: number | unknown): string {
  const numeric = typeof value === "number" ? value : Number(value);

  if (Number.isNaN(numeric)) {
    const emptyBar = CONFIDENCE_BAR_EMPTY.repeat(CONFIDENCE_BAR_STEPS);
    return `${emptyBar} 0% (raw: NaN)`;
  }

  const isOutOfRange = numeric < 0 || numeric > 100;
  const clamped = Math.min(100, Math.max(0, numeric));

  // Determine number of filled steps out of 10.
  // Math.round(clamped / 10) maps 0-100 to 0-10 steps.
  const filledSteps = Math.min(
    CONFIDENCE_BAR_STEPS,
    Math.max(0, Math.round(clamped / 10)),
  );
  const emptySteps = CONFIDENCE_BAR_STEPS - filledSteps;

  const bar =
    CONFIDENCE_BAR_FILLED.repeat(filledSteps) +
    CONFIDENCE_BAR_EMPTY.repeat(emptySteps);

  const pct = Number.isInteger(clamped)
    ? String(clamped)
    : String(Math.round(clamped * 100) / 100);

  const base = `${bar} ${pct}%`;

  if (isOutOfRange) {
    return `${base} (raw: ${numeric})`;
  }

  return base;
}
