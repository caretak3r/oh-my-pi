import type { ThemeColor } from "../modes/theme/theme";

/**
 * Pure math for Prompt Charge: an RC-style "capacitor charging" curve maps
 * the editor's live typed-character count to a caret glow that builds as a
 * longer prompt is typed, and a decaying release curve maps elapsed time
 * since submit to a fading burst intensity. Every function is deterministic
 * given its inputs — no wall-clock reads — so frames stay byte-stable given
 * an injected clock.
 */

/**
 * Characters at which the charge curve reaches `1 - 1/e` (~63%) of full.
 * Tuned so a short prompt (a few words) barely glows and a genuinely long
 * one (a paragraph-plus) reads as fully charged, without a hard cutoff.
 */
export const CHARGE_TAU_CHARS = 140;

/** How long a release burst takes to fully decay back to idle, in ms. */
export const RELEASE_DURATION_MS = 500;

/** Number of cells the charge bar renders. */
export const BAR_CELLS = 10;

/**
 * Typed-character count -> charge fraction in `[0, 1)`. An asymptotic
 * "capacitor charging" curve (`1 - e^-chars/tau`) rather than a linear ramp
 * or hard cap: it climbs fast for the first handful of characters (visible
 * feedback the instant typing starts) and flattens out approaching 1 for a
 * very long prompt, never truly reaching it. Pure, monotonic non-decreasing
 * in `chars`.
 */
export function chargeFraction(chars: number, tau: number = CHARGE_TAU_CHARS): number {
	if (Number.isNaN(chars) || chars <= 0) return 0;
	return 1 - Math.exp(-chars / tau);
}

/**
 * Release progress in `[0, 1]` at `elapsedMs` since a release started at
 * `releaseStartMs`. Pure, monotonic non-decreasing, clamps to `1` at/after
 * `duration`.
 */
export function releaseProgress(
	elapsedMs: number,
	releaseStartMs: number,
	duration: number = RELEASE_DURATION_MS,
): number {
	const elapsed = elapsedMs - releaseStartMs;
	if (Number.isNaN(elapsed)) return 0;
	if (elapsed <= 0) return 0;
	if (elapsed >= duration) return 1;
	return elapsed / duration;
}

/**
 * Ease-out burst intensity in `[0, chargeAtRelease]`: starts at the charge
 * level captured at submit time and decays quadratically to `0` as
 * `progress` climbs to `1`. Pure.
 */
export function releaseIntensity(chargeAtRelease: number, progress: number): number {
	const clamped = Number.isNaN(progress) || progress >= 1 ? 1 : progress <= 0 ? 0 : progress;
	const decay = (1 - clamped) ** 2;
	return chargeAtRelease * decay;
}

/** A charge fraction (or release intensity) -> filled bar cells out of `cells`. Pure, rounds to the nearest cell, clamps to `[0, cells]`. */
export function filledCells(fraction: number, cells: number = BAR_CELLS): number {
	const clamped = Number.isNaN(fraction) ? 0 : fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
	return Math.round(clamped * cells);
}

/** Coarse charge bucket the bead's dim-to-hot palette keys off. */
export type ChargeBucket = "idle" | "building" | "charged" | "full";

/** Ascending fraction ceilings for the non-idle buckets. Any fraction above the last ceiling is `full`. */
const BUCKET_CEILINGS: ReadonlyArray<{ bucket: Exclude<ChargeBucket, "idle">; max: number }> = [
	{ bucket: "building", max: 0.4 },
	{ bucket: "charged", max: 0.8 },
];

/** Classify a charge fraction into a {@link ChargeBucket}. Pure, monotonic in `fraction`. */
export function chargeBucket(fraction: number): ChargeBucket {
	if (Number.isNaN(fraction) || fraction <= 0) return "idle";
	for (const { bucket, max } of BUCKET_CEILINGS) {
		if (fraction <= max) return bucket;
	}
	return "full";
}

/**
 * Bucket -> theme color, dim at rest, warming through cyan/amber to a hot
 * flash at full charge — the same "existing `ThemeColor` set, not raw ANSI"
 * precedent Token Tide's `BUCKET_THEME_COLOR` and Model Weather Vane's
 * `VANE_COLORS` set.
 */
export const CHARGE_BUCKET_COLOR: Readonly<Record<ChargeBucket, ThemeColor>> = {
	idle: "dim",
	building: "syntaxVariable",
	charged: "syntaxFunction",
	full: "warning",
};
