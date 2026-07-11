/** Firefly visual state, mapped from the registry's live/finished/aborted lifecycle. */
export type FireflyStatus = "working" | "done" | "failed";

/** Breathing-pulse period, in ms, for a `working` firefly. */
const WORKING_PULSE_PERIOD_MS = 900;
/** Duration, in ms, a `done` firefly takes to fade from full brightness to zero before it's pruned. */
export const FADE_DURATION_MS = 2000;
/** Duration, in ms, a `failed` firefly blinks red before it's pruned. */
export const FAILED_LINGER_MS = 3000;
/** Blink cycle period, in ms, for a `failed` firefly during its linger window. */
const BLINK_PERIOD_MS = 350;
/** Wobble cycle period, in ms, for a `working` firefly's horizontal drift within its cell. */
const WOBBLE_PERIOD_MS = 1400;

/** Clamp to `[0, 1]`. Pure. */
function clamp01(value: number): number {
	return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * 32-bit FNV-1a. Hand-rolled (not `Bun.hash`) so the drift-phase seed is
 * stable across Bun versions and byte-stable in behavioral tests — matching
 * the same precedent set by Tool Constellation's grid-cell hashing.
 */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Deterministic per-agent seed in `[0, 1)`, used to phase-offset each firefly's wobble so a fleet doesn't move in lockstep. Pure. */
export function driftSeed(agentId: string): number {
	return fnv1a(agentId) / 0x100000000;
}

/**
 * Three-state horizontal wobble (`-1` left, `0` center, `1` right) for a
 * `working` firefly, given its seed and elapsed time since it spawned. A
 * sine wave phase-shifted by `seed` so fireflies with different ids wobble
 * out of sync. Pure, periodic in `elapsedSinceSpawnMs`.
 */
export function wobblePhase(seed: number, elapsedSinceSpawnMs: number): -1 | 0 | 1 {
	const phaseOffset = seed * WOBBLE_PERIOD_MS;
	const t = (((elapsedSinceSpawnMs + phaseOffset) % WOBBLE_PERIOD_MS) + WOBBLE_PERIOD_MS) % WOBBLE_PERIOD_MS;
	const wave = Math.sin((t / WOBBLE_PERIOD_MS) * Math.PI * 2);
	return wave > 0.33 ? 1 : wave < -0.33 ? -1 : 0;
}

/** Breathing brightness in `[0.5, 1]` for a `working` firefly — never fully dark while the agent is live. Pure, periodic in `elapsedSinceSpawnMs`. */
export function workingBrightness(elapsedSinceSpawnMs: number): number {
	const phase = ((elapsedSinceSpawnMs % WORKING_PULSE_PERIOD_MS) + WORKING_PULSE_PERIOD_MS) % WORKING_PULSE_PERIOD_MS;
	const wave = Math.sin((phase / WORKING_PULSE_PERIOD_MS) * Math.PI * 2) * 0.5 + 0.5;
	return 0.5 + wave * 0.5;
}

/** Brightness in `[0, 1]` for a `done` firefly, fading linearly from full to zero over {@link FADE_DURATION_MS} since its status changed. Pure, monotonic non-increasing. */
export function doneBrightness(elapsedSinceStatusChangeMs: number): number {
	return 1 - clamp01(elapsedSinceStatusChangeMs / FADE_DURATION_MS);
}

/** Brightness in `[0, 1]` for a `failed` firefly: a red blink whose amplitude decays to zero over {@link FAILED_LINGER_MS}. Pure, periodic envelope in `elapsedSinceStatusChangeMs`. */
export function failedBrightness(elapsedSinceStatusChangeMs: number): number {
	const envelope = 1 - clamp01(elapsedSinceStatusChangeMs / FAILED_LINGER_MS);
	const phase = ((elapsedSinceStatusChangeMs % BLINK_PERIOD_MS) + BLINK_PERIOD_MS) % BLINK_PERIOD_MS;
	const blink = phase < BLINK_PERIOD_MS / 2 ? 1 : 0.2;
	return envelope * blink;
}

/** Dispatch brightness by status. Pure. */
export function brightnessFor(
	status: FireflyStatus,
	elapsedSinceSpawnMs: number,
	elapsedSinceStatusChangeMs: number,
): number {
	if (status === "working") return workingBrightness(elapsedSinceSpawnMs);
	if (status === "failed") return failedBrightness(elapsedSinceStatusChangeMs);
	return doneBrightness(elapsedSinceStatusChangeMs);
}

/** Fixed, non-animated brightness for the `subtle` tier — a discrete encode of status with no per-frame motion. Pure. */
export function restBrightness(status: FireflyStatus): number {
	if (status === "working") return 1;
	if (status === "failed") return 0.6;
	return 0.25;
}

/** Whether a firefly's fade/blink-out has finished and it should be pruned. `working` fireflies are never prunable. Pure. */
export function isPrunable(status: FireflyStatus, elapsedSinceStatusChangeMs: number): boolean {
	if (status === "working") return false;
	if (status === "failed") return elapsedSinceStatusChangeMs >= FAILED_LINGER_MS;
	return elapsedSinceStatusChangeMs >= FADE_DURATION_MS;
}

/** Ordered glyph ramp, dimmest to brightest. */
const FIREFLY_GLYPHS = ["·", "∘", "✧", "✦"] as const;

/** Map a brightness value (`0..1`) to a firefly glyph. Monotonic. Pure. */
export function fireflyGlyph(brightness: number): string {
	const clamped = clamp01(brightness);
	const index = Math.min(FIREFLY_GLYPHS.length - 1, Math.floor(clamped * FIREFLY_GLYPHS.length));
	return FIREFLY_GLYPHS[index] ?? FIREFLY_GLYPHS[0];
}
