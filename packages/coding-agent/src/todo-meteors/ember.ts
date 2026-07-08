/** Total duration, in ms, for a completed todo's meteor to arc off-screen. */
export const METEOR_ARC_DURATION_MS = 900;

/** Progress in `[0, 1]` along a meteor's arc, given it launched at `launchedAtMs`, evaluated at `elapsedMs` (both readings from the same relative clock). Clamped, monotonic non-decreasing. Pure. */
export function meteorProgress(launchedAtMs: number, elapsedMs: number): number {
	const t = (elapsedMs - launchedAtMs) / METEOR_ARC_DURATION_MS;
	return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Whether a meteor launched at `launchedAtMs` has finished its arc (and should be pruned) at `elapsedMs`. Pure. */
export function meteorDone(launchedAtMs: number, elapsedMs: number): boolean {
	return elapsedMs - launchedAtMs >= METEOR_ARC_DURATION_MS;
}

/** Ordered head-glyph ramp a meteor ages through as it burns across the sky: bright comet head, fading to a spark, then a trailing mote just before it's pruned. */
const METEOR_GLYPHS = ["☄", "*", "·"] as const;

/** Map arc progress to the meteor's head glyph. Monotonic along the ramp. Pure. */
export function meteorGlyph(progress: number): string {
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	const index = Math.min(METEOR_GLYPHS.length - 1, Math.floor(clamped * METEOR_GLYPHS.length));
	return METEOR_GLYPHS[index] ?? METEOR_GLYPHS[0];
}

/** Column (0-based, left to right) a meteor sits at within a lane of `width` columns at `progress`. Pure, monotonic non-decreasing in progress. */
export function meteorColumn(progress: number, width: number): number {
	if (width <= 0) return 0;
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	return Math.min(width - 1, Math.floor(clamped * width));
}

/**
 * Resting brightness in `[0, 1]` for an open ember, keyed by todo status (no
 * reminder pressure applied). `TodoItem` carries no priority field in this
 * codebase — `in_progress` reading brighter than `pending` is the closest
 * real analog, matching the todo tool's own `accent`/`dim` status coloring.
 * Pure.
 */
export function emberRestBrightness(status: "pending" | "in_progress"): number {
	return status === "in_progress" ? 1 : 0.4;
}

const URGENCY_PULSE_PERIOD_MS = 500;

/**
 * Urgency pulse amplitude in `[0, 1]`, added on top of an ember's resting
 * brightness: 0 with no reminder pressure (`attempt <= 0`), rising with
 * `attempt / maxAttempts`, oscillating so the pulse actually reads as
 * "pulsing" rather than a flat brightness bump. Pure, periodic in `elapsedMs`.
 */
export function urgencyPulse(attempt: number, maxAttempts: number, elapsedMs: number): number {
	if (attempt <= 0 || maxAttempts <= 0) return 0;
	const pressure = Math.min(1, Math.max(0, attempt / maxAttempts));
	const phase = ((elapsedMs % URGENCY_PULSE_PERIOD_MS) + URGENCY_PULSE_PERIOD_MS) % URGENCY_PULSE_PERIOD_MS;
	const wave = Math.sin((phase / URGENCY_PULSE_PERIOD_MS) * Math.PI * 2) * 0.5 + 0.5;
	return pressure * wave;
}

/** Combine a resting brightness with a pulse amplitude, clamped to `[0, 1]`. The pulse only ever brightens (never dims below rest), so a fully-lit `in_progress` ember stays lit rather than flickering dark. Pure. */
export function combineBrightness(rest: number, pulse: number): number {
	const combined = rest + pulse * (1 - rest);
	return combined <= 0 ? 0 : combined >= 1 ? 1 : combined;
}

/** Ordered glyph ramp for an ember, dimmest to brightest. */
const EMBER_GLYPHS = ["·", "○", "◉", "●"] as const;

/** Map a combined brightness value (`0..1`) to an ember glyph. Monotonic. Pure. */
export function emberGlyph(brightness: number): string {
	const clamped = brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
	const index = Math.min(EMBER_GLYPHS.length - 1, Math.floor(clamped * EMBER_GLYPHS.length));
	return EMBER_GLYPHS[index] ?? EMBER_GLYPHS[0];
}
