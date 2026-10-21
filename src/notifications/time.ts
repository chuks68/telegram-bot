/**
 * Relative time formatting for squad market deadlines.
 *
 * Formats a Unix epoch timestamp (in seconds) relative to a reference time
 * (in milliseconds, defaulting to Date.now()), displaying human-readable durations
 * such as:
 *   - "in 3d 4h"
 *   - "in 12m"
 *   - "ended 2h ago"
 *   - "ended" (when deadline has arrived or elapsed is 0)
 *
 * Duration breakdown rules:
 *   - >= 1 day: days + hours (if hours > 0, e.g. "3d 4h", else "3d")
 *   - >= 1 hour: hours + minutes (if minutes > 0, e.g. "2h 15m", else "2h")
 *   - >= 1 minute: minutes (e.g. "12m")
 *   - < 1 minute: seconds (e.g. "45s")
 */

/**
 * Format a positive duration in seconds into a compact string representation.
 */
export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const d = Math.floor(total / 86400);
  const remD = total % 86400;
  const h = Math.floor(remD / 3600);
  const remH = remD % 3600;
  const m = Math.floor(remH / 60);
  const s = remH % 60;

  if (d > 0) {
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (h > 0) {
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${s}s`;
}

/**
 * Produce a human-readable relative duration string for a target timestamp.
 *
 * @param targetSec Target timestamp in Unix seconds
 * @param nowMs Current timestamp in Unix milliseconds (defaults to Date.now())
 * @returns e.g. "in 3d 4h", "in 12m", "ended 2h ago", or "ended"
 */
export function formatRelative(targetSec: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(targetSec)) {
    return "";
  }
  const targetMs = targetSec * 1000;
  const diffSec = Math.round((targetMs - nowMs) / 1000);

  if (diffSec < 0) {
    const elapsed = Math.abs(diffSec);
    return `ended ${formatDuration(elapsed)} ago`;
  }
  if (diffSec === 0) {
    return "ended";
  }
  return `in ${formatDuration(diffSec)}`;
}

/**
 * Format a squad market deadline combining relative context and absolute UTC ISO string.
 *
 * Output: e.g. "in 3d 4h (2026-10-22T13:53:50.000Z)"
 */
export function formatDeadline(targetSec: number, nowMs?: number): string {
  const rel = formatRelative(targetSec, nowMs);
  let iso: string;
  try {
    iso = new Date(targetSec * 1000).toISOString();
  } catch {
    iso = "unknown";
  }
  return rel ? `${rel} (${iso})` : iso;
}
