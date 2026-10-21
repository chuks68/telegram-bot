/**
 * Decode statistics tracking.
 *
 * Records the outcome of event decoding for metrics and monitoring.
 * This is a lightweight implementation that can be extended with actual
 * metrics collection if needed.
 */

export function recordDecodeOutcome(
  _source: string,
  _eventName: string,
  _outcome: string,
): void {
  // Stub implementation - metrics collection can be added here
  // For now, this is a no-op to allow decode.ts to compile
  // without requiring a full metrics infrastructure.
}
