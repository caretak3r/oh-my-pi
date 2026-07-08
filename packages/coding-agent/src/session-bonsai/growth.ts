/** Duration, in ms, for a newly-spawned branch to fully unfurl. */
export const UNFURL_DURATION_MS = 1000;

/**
 * Growth fraction in `[0, 1]` for a branch spawned at `spawnAtMs`, evaluated
 * at `elapsedMs` (both readings from the same relative clock). Monotonic
 * non-decreasing in `elapsedMs`. Pure.
 */
export function unfurlGrowth(spawnAtMs: number, elapsedMs: number): number {
	const t = (elapsedMs - spawnAtMs) / UNFURL_DURATION_MS;
	return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Ordered glyph ramp for a branch still unfurling (`growth < 1`): bud -> shoot -> almost-there. The caller swaps in the final leaf glyph once `growth >= 1`. */
const BUD_GLYPHS = [".", "o", "0"] as const;

/** Map a growth fraction to a bud glyph. Pure, monotonic non-decreasing along the ramp. */
export function budGlyph(growth: number): string {
	const clamped = growth <= 0 ? 0 : growth >= 1 ? 1 : growth;
	const index = Math.min(BUD_GLYPHS.length - 1, Math.floor(clamped * BUD_GLYPHS.length));
	return BUD_GLYPHS[index];
}

const SHIMMER_PERIOD_MS = 1400;
const SHIMMER_BLIP_MS = 220;

/** Whether the active leaf's tip is mid-shimmer-blip at `elapsedMs`. Pure periodic pulse, `full` tier only. */
export function isShimmering(elapsedMs: number): boolean {
	return elapsedMs % SHIMMER_PERIOD_MS < SHIMMER_BLIP_MS;
}
