import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

/**
 * Draining-ring fill glyphs from empty (index 0) to full (last index). As the
 * backoff window elapses the ring walks high -> low, so a full `●` at the start
 * of the wait drains to an empty `○` when the delay is up.
 */
export const RING_GLYPHS = ["○", "◔", "◑", "◕", "●"] as const;

/**
 * Fraction of the backoff window still remaining, clamped to `[0, 1]`. A pure
 * function of elapsed-vs-total so the ring is fully deterministic from the frame
 * clock: `1` at the instant the wait begins, `0` once `delayMs` has passed. A
 * non-positive `delayMs` (or elapsed past the end) reads as `0` remaining.
 */
export function ringRemaining(elapsedMs: number, delayMs: number): number {
	if (!(delayMs > 0)) return 0;
	const remaining = 1 - elapsedMs / delayMs;
	if (remaining <= 0) return 0;
	if (remaining >= 1) return 1;
	return remaining;
}

/** Whole seconds left in the backoff, rounded up and never negative. */
export function secondsRemaining(elapsedMs: number, delayMs: number): number {
	const left = delayMs - elapsedMs;
	if (left <= 0) return 0;
	return Math.ceil(left / 1000);
}

/** Map a remaining fraction (`0..1`) to a draining-ring glyph. Monotonic in `remaining`. */
export function ringGlyph(remaining: number): string {
	const clamped = remaining <= 0 ? 0 : remaining >= 1 ? 1 : remaining;
	const index = Math.round(clamped * (RING_GLYPHS.length - 1));
	return RING_GLYPHS[index] ?? RING_GLYPHS[0];
}

/**
 * Condense a raw provider error into a short, single-line reason token suitable
 * for the compact ring line. Prefers a bare HTTP status code (`429`, `503`, …)
 * when the message carries one; otherwise the sanitized, truncated first line.
 * Returns `""` for an empty/undefined message so callers can omit the segment.
 */
export function shortReason(errorMessage: string | undefined, max = 32): string {
	if (!errorMessage) return "";
	const firstLine = replaceTabs(errorMessage).split("\n", 1)[0]?.trim() ?? "";
	if (firstLine === "") return "";
	const status = firstLine.match(/\b([45]\d{2})\b/);
	if (status) return status[1];
	return truncateToWidth(firstLine, Math.max(1, max));
}
