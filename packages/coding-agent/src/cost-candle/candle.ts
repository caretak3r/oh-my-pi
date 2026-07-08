/**
 * Cumulative session cost (USD) at which the candle reads fully melted (wax
 * bar empty). A "you've spent enough to notice" reference point, not a real
 * budget — mirrors Token Tide's `MAX_REFERENCE_RATE` normalization pattern.
 */
export const WAX_REFERENCE_COST_USD = 2;

/**
 * Single-message cost (USD) at which a turn produces a full-intensity flame
 * gutter. Costs at or above this clamp to the maximum gutter.
 */
export const GUTTER_REFERENCE_COST_USD = 0.05;

/** How long a gutter's disturbance takes to decay back to the calm baseline flicker. */
export const GUTTER_DECAY_MS = 1500;

/** Remaining wax fraction in `[0, 1]`: `1` is a fresh candle, `0` is fully melted. Pure, monotonic non-increasing in `totalCostUsd`. */
export function waxRemaining(totalCostUsd: number): number {
	if (!Number.isFinite(totalCostUsd) || totalCostUsd <= 0) return 1;
	return Math.max(0, 1 - totalCostUsd / WAX_REFERENCE_COST_USD);
}

/** Gutter intensity in `[0, 1]` a single message's cost produces, before any time decay. Pure, monotonic non-decreasing in `messageCostUsd`. */
export function gutterIntensity(messageCostUsd: number): number {
	if (!Number.isFinite(messageCostUsd) || messageCostUsd <= 0) return 0;
	return Math.min(1, messageCostUsd / GUTTER_REFERENCE_COST_USD);
}

/**
 * Gutter amplitude in `[0, 1]` at `msSinceTurn` after a message landed with
 * `peakIntensity` — linear decay to `0` by {@link GUTTER_DECAY_MS}, flat `0`
 * thereafter (and flat `0` for a non-positive `peakIntensity`, so "no turn
 * yet" and "long-decayed turn" both read as calm). Pure.
 */
export function gutterEnvelope(peakIntensity: number, msSinceTurn: number): number {
	const clampedPeak = peakIntensity <= 0 ? 0 : peakIntensity >= 1 ? 1 : peakIntensity;
	if (clampedPeak === 0) return 0;
	const elapsed = msSinceTurn <= 0 ? 0 : msSinceTurn;
	const t = elapsed >= GUTTER_DECAY_MS ? 1 : elapsed / GUTTER_DECAY_MS;
	return clampedPeak * (1 - t);
}

const FLAME_BASE_BRIGHTNESS = 0.65;
/** Flicker swing at rest (no gutter): small, so a cheap/idle candle "barely flickers" per the bead. */
const BASELINE_SWING = 0.15;
const FLICKER_PERIOD_MS = 700;

/**
 * Flame brightness in `[0, 1]` at `elapsedMs`, oscillating around
 * {@link FLAME_BASE_BRIGHTNESS} with a swing that widens from
 * {@link BASELINE_SWING} (calm) up to a full-width swing as `gutterAmplitude`
 * (see {@link gutterEnvelope}) rises toward `1` — an expensive turn's gutter
 * reads as a wider, wilder flicker, not just a one-shot brightness jump, and
 * settles back to the calm baseline as the gutter decays. Pure, periodic in
 * `elapsedMs`.
 */
export function flameBrightness(elapsedMs: number, gutterAmplitude: number): number {
	const clampedGutter = gutterAmplitude <= 0 ? 0 : gutterAmplitude >= 1 ? 1 : gutterAmplitude;
	const swing = BASELINE_SWING + clampedGutter * (1 - BASELINE_SWING);
	const phase = ((elapsedMs % FLICKER_PERIOD_MS) + FLICKER_PERIOD_MS) % FLICKER_PERIOD_MS;
	const wave = Math.sin((phase / FLICKER_PERIOD_MS) * Math.PI * 2);
	const brightness = FLAME_BASE_BRIGHTNESS + wave * swing;
	return brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
}

/** Ordered flame glyph ramp, dimmest/calmest to brightest/wildest. */
const FLAME_GLYPHS = ["˚", "∴", "▲", "♦"] as const;

/** Map a flame brightness (`0..1`) to a glyph on the {@link FLAME_GLYPHS} ramp. Monotonic. Pure. */
export function flameGlyph(brightness: number): string {
	const clamped = brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
	const index = Math.min(FLAME_GLYPHS.length - 1, Math.floor(clamped * FLAME_GLYPHS.length));
	return FLAME_GLYPHS[index];
}

const WAX_FULL_GLYPH = "█";
const WAX_EMPTY_GLYPH = "▁";

/** Render a `width`-column wax bar: filled from the left in proportion to `remaining` (see {@link waxRemaining}), the rest drawn as burnt/empty. Pure, monotonic non-decreasing filled-count in `remaining`. */
export function waxBar(remaining: number, width: number): string {
	if (width <= 0) return "";
	const clamped = remaining <= 0 ? 0 : remaining >= 1 ? 1 : remaining;
	const filled = Math.round(clamped * width);
	return WAX_FULL_GLYPH.repeat(filled) + WAX_EMPTY_GLYPH.repeat(width - filled);
}

/** Format a USD amount to two decimal places, e.g. `$0.42`. Pure. */
export function formatUsd(amountUsd: number): string {
	const safe = Number.isFinite(amountUsd) ? amountUsd : 0;
	return `$${safe.toFixed(2)}`;
}
