/**
 * Pure math for Goal Horizon: a sunrise-gradient bar tracking token
 * consumption against an active `/goal`'s optional budget, with a synthetic
 * milestone flare at 25/50/75/100% crossed. Every function is deterministic
 * given its numeric inputs — no wall-clock reads — so frames stay
 * byte-stable given an injected clock.
 */

/** Width, in columns, of the horizon bar. */
export const HORIZON_BAR_WIDTH = 20;

/**
 * Synthetic milestone fractions "milestones flare" is scoped against.
 * `Goal`/`GoalModeState` (`goals/state.ts`) have no milestone concept at
 * all — these are wholly invented by this feature, not read off any real
 * field (documented in `WAVE2_PROGRESS.md`).
 */
export const MILESTONE_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;

/** How long a milestone flare takes to decay back to the bar's resting state. */
export const FLARE_DECAY_MS = 900;

/**
 * Consumption fraction in `[0, 1]`, or `undefined` when the active goal has
 * no `tokenBudget` set (an unbounded goal — `Goal.tokenBudget` is optional,
 * `goals/state.ts`) and therefore has no numeric target to fill toward.
 * Pure.
 */
export function goalFraction(tokensUsed: number, tokenBudget: number | undefined): number | undefined {
	if (tokenBudget === undefined || !Number.isFinite(tokenBudget) || tokenBudget <= 0) return undefined;
	if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return 0;
	return Math.max(0, Math.min(1, tokensUsed / tokenBudget));
}

/** How many of {@link MILESTONE_FRACTIONS} `fraction` has reached or passed. Pure, monotonic non-decreasing in `fraction`. */
export function milestonesCrossed(fraction: number): number {
	let count = 0;
	for (const threshold of MILESTONE_FRACTIONS) {
		if (fraction >= threshold) count += 1;
	}
	return count;
}

/** The largest {@link MILESTONE_FRACTIONS} entry at or below `fraction`, or `undefined` if none crossed yet. Pure. */
export function nearestCrossedMilestone(fraction: number): number | undefined {
	let nearest: number | undefined;
	for (const threshold of MILESTONE_FRACTIONS) {
		if (fraction >= threshold) nearest = threshold;
	}
	return nearest;
}

/** Flare amplitude in `[0, 1]` at `msSinceFlare` after a milestone crossed with `peakIntensity` — linear decay to `0` by {@link FLARE_DECAY_MS}, flat `0` for a non-positive `peakIntensity`. Pure. */
export function flareIntensity(peakIntensity: number, msSinceFlare: number): number {
	const clampedPeak = peakIntensity <= 0 ? 0 : peakIntensity >= 1 ? 1 : peakIntensity;
	if (clampedPeak === 0) return 0;
	const elapsed = msSinceFlare <= 0 ? 0 : msSinceFlare;
	const t = elapsed >= FLARE_DECAY_MS ? 1 : elapsed / FLARE_DECAY_MS;
	return clampedPeak * (1 - t);
}

/** Coarse position bucket the sunrise gradient keys off — dim pre-dawn at the bar's start, warming to a hot zenith at its end. */
export type HorizonBucket = "predawn" | "dawn" | "morning" | "noon" | "zenith";

const BUCKET_CEILINGS: ReadonlyArray<{ bucket: Exclude<HorizonBucket, "predawn">; max: number }> = [
	{ bucket: "dawn", max: 0.25 },
	{ bucket: "morning", max: 0.5 },
	{ bucket: "noon", max: 0.75 },
];

/** Classify a `[0, 1]` bar position (or overall fraction) into a {@link HorizonBucket}. Pure, monotonic in `positionFraction`. */
export function horizonBucket(positionFraction: number): HorizonBucket {
	if (!Number.isFinite(positionFraction) || positionFraction <= 0) return "predawn";
	for (const { bucket, max } of BUCKET_CEILINGS) {
		if (positionFraction <= max) return bucket;
	}
	return "zenith";
}

/** Which of `width` columns (`0`-indexed) a milestone at `milestoneFraction` lands on. Pure. */
export function milestoneColumn(milestoneFraction: number, width: number): number {
	if (width <= 0) return 0;
	return Math.min(width - 1, Math.max(0, Math.round(milestoneFraction * width) - 1));
}

/** Ordered glyph ramp for the milestone flare overlay, dimmest/just-triggered fading to brightest/fresh. */
const FLARE_GLYPHS = [" ", "·", "✦", "✷", "☀"] as const;

/** Map a `[0, 1]` flare intensity to a glyph on the {@link FLARE_GLYPHS} ramp. Monotonic. Pure. */
export function flareGlyph(intensity: number): string {
	const clamped = intensity <= 0 ? 0 : intensity >= 1 ? 1 : intensity;
	const index = Math.min(FLARE_GLYPHS.length - 1, Math.floor(clamped * FLARE_GLYPHS.length));
	return FLARE_GLYPHS[index] ?? FLARE_GLYPHS[0];
}

/** Filled-cell count for a `width`-column bar at `fraction`. Pure, monotonic non-decreasing in `fraction`. */
export function filledColumnCount(fraction: number, width: number): number {
	if (width <= 0) return 0;
	const clamped = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
	return Math.round(clamped * width);
}

const INDETERMINATE_PULSE_PERIOD_MS = 2400;

/**
 * Faint pulse amplitude in `[0, 1]` for the indeterminate (no-`tokenBudget`)
 * rendering — a pure function of `elapsedMs` alone, oscillating smoothly so
 * an unbounded goal still reads as "alive" without any fill target to
 * animate toward. Pure, periodic in `elapsedMs`.
 */
export function indeterminatePulse(elapsedMs: number): number {
	const phase =
		((elapsedMs % INDETERMINATE_PULSE_PERIOD_MS) + INDETERMINATE_PULSE_PERIOD_MS) % INDETERMINATE_PULSE_PERIOD_MS;
	const fraction = phase / INDETERMINATE_PULSE_PERIOD_MS;
	return 0.5 - 0.5 * Math.cos(fraction * Math.PI * 2);
}
