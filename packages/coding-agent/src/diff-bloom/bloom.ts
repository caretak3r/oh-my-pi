/**
 * Pure math for Diff Bloom: a single flower that blooms green (added lines)
 * and red (removed lines) each time an `edit` tool call lands a real diff,
 * then wipes clear. Every function is a deterministic function of its
 * numeric inputs — no wall-clock reads — so frames are byte-stable given an
 * injected clock.
 */

/** How long the bloom takes to reach full intensity from a fresh trigger. */
export const BLOOM_GROW_MS = 400;

/** Total lifetime of one bloom: grows in, then wipes clear by this point. */
export const BLOOM_DURATION_MS = 1400;

/** Line-count ceiling a single edit's added/removed magnitude is normalized against — a fixed reference, not an adaptive/rolling max (same normalization convention as Memory Crystals' `MAX_REFERENCE_TOKENS`). */
export const MAX_REFERENCE_LINES = 40;

/** `elapsedMs` since the bloom was triggered, as a `[0, 1]` fraction of `durationMs`. Clamped. Pure. */
export function bloomProgress(elapsedMs: number, durationMs: number): number {
	if (durationMs <= 0) return 1;
	if (elapsedMs <= 0) return 0;
	if (elapsedMs >= durationMs) return 1;
	return elapsedMs / durationMs;
}

/**
 * Overall bloom brightness (`[0, 1]`) at `elapsedMs` since trigger: eases up
 * to full intensity by {@link BLOOM_GROW_MS} (a flower opening, `sqrt`
 * ease-out like Reflection Ripple's wavefront), then wipes linearly back to
 * `0` by {@link BLOOM_DURATION_MS} (the row clearing). Pure.
 */
export function bloomIntensity(elapsedMs: number): number {
	const growFraction = BLOOM_DURATION_MS <= 0 ? 1 : Math.min(1, BLOOM_GROW_MS / BLOOM_DURATION_MS);
	const progress = bloomProgress(elapsedMs, BLOOM_DURATION_MS);
	if (progress <= growFraction) {
		if (growFraction <= 0) return 1;
		return Math.sqrt(progress / growFraction);
	}
	const wipeSpan = 1 - growFraction;
	if (wipeSpan <= 0) return 0;
	const wipeProgress = (progress - growFraction) / wipeSpan;
	return 1 - wipeProgress;
}

/** Normalize a line count against {@link MAX_REFERENCE_LINES} into a `[0, 1]` fill fraction. Pure. */
export function lineFraction(lines: number): number {
	if (lines <= 0) return 0;
	return Math.min(1, lines / MAX_REFERENCE_LINES);
}

/** Ordered glyph ramp, dimmest/just-opening to brightest/full-bloom. */
const BLOOM_GLYPHS = [" ", "·", "▪", "▫", "█"] as const;

/** Map a `[0, 1]` intensity to a glyph on the {@link BLOOM_GLYPHS} ramp. Monotonic. Pure. */
export function bloomGlyph(intensity: number): string {
	const clamped = intensity <= 0 ? 0 : intensity >= 1 ? 1 : intensity;
	const index = Math.min(BLOOM_GLYPHS.length - 1, Math.floor(clamped * BLOOM_GLYPHS.length));
	return BLOOM_GLYPHS[index] ?? BLOOM_GLYPHS[0];
}

/** How many of `segmentWidth` cells should render filled for `lines` at the given bloom `intensity`. Pure. */
export function filledCellCount(lines: number, segmentWidth: number, intensity: number): number {
	if (segmentWidth <= 0) return 0;
	return Math.round(segmentWidth * lineFraction(lines) * Math.max(0, Math.min(1, intensity)));
}
