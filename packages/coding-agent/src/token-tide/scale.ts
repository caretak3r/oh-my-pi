import type { ThemeColor } from "../modes/theme/theme";

/** Coarse throughput bucket the bead's cool-to-hot palette keys off. */
export type RateBucket = "idle" | "low" | "medium" | "high" | "burst";

/** Ascending tok/s ceilings for the non-idle buckets. Any rate above the last ceiling is `burst`. */
const BUCKET_CEILINGS: ReadonlyArray<{ bucket: Exclude<RateBucket, "idle">; max: number }> = [
	{ bucket: "low", max: 20 },
	{ bucket: "medium", max: 60 },
	{ bucket: "high", max: 120 },
];

/** Classify a tok/s rate into a {@link RateBucket}. Pure, monotonic in `tokensPerSecond`. */
export function rateBucket(tokensPerSecond: number): RateBucket {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "idle";
	for (const { bucket, max } of BUCKET_CEILINGS) {
		if (tokensPerSecond <= max) return bucket;
	}
	return "burst";
}

/**
 * Bucket -> theme color, warming from resting dim through cool teal/cyan to
 * hot amber as throughput climbs. Chosen from the existing {@link ThemeColor}
 * set rather than inventing raw ANSI colors, matching the tool-constellation
 * precedent.
 */
export const BUCKET_THEME_COLOR: Readonly<Record<RateBucket, ThemeColor>> = {
	idle: "dim",
	low: "syntaxType", // cool teal
	medium: "syntaxVariable", // cyan
	high: "syntaxFunction", // amber
	burst: "warning", // hot amber/red
};

/** Reference ceiling for amplitude normalization; rates at or above this clamp to `1`. */
export const MAX_REFERENCE_RATE = 160;

/** Normalize a tok/s rate to a `[0, 1]` amplitude. Pure, monotonic non-decreasing in `tokensPerSecond`. */
export function normalizeAmplitude(tokensPerSecond: number): number {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return 0;
	return Math.min(1, tokensPerSecond / MAX_REFERENCE_RATE);
}

const RESTING_PULSE_PERIOD_MS = 2600;
const RESTING_PULSE_AMPLITUDE = 0.08;

/**
 * Faint idle breathing amplitude in `[0, RESTING_PULSE_AMPLITUDE]`, a pure
 * function of `elapsedMs` alone — the "between turns" resting pulse laid
 * under an otherwise-flat waveform. Deterministic given the injected clock
 * phase, so it stays snapshot-testable.
 */
export function restingPulse(elapsedMs: number): number {
	const phase = ((elapsedMs % RESTING_PULSE_PERIOD_MS) + RESTING_PULSE_PERIOD_MS) % RESTING_PULSE_PERIOD_MS;
	const fraction = phase / RESTING_PULSE_PERIOD_MS;
	return RESTING_PULSE_AMPLITUDE * (0.5 - 0.5 * Math.cos(fraction * Math.PI * 2));
}

/** Vertical block ramp from empty to full, dimmest to loudest. */
export const WAVE_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Map an amplitude (`0..1`) to a glyph on the {@link WAVE_GLYPHS} ramp. Monotonic in `amplitude`. */
export function waveGlyph(amplitude: number): string {
	const clamped = amplitude <= 0 ? 0 : amplitude >= 1 ? 1 : amplitude;
	const index = Math.min(WAVE_GLYPHS.length - 1, Math.floor(clamped * WAVE_GLYPHS.length));
	return WAVE_GLYPHS[index] ?? WAVE_GLYPHS[0];
}
