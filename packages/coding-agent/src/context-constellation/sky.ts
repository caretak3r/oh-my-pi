/**
 * Pure math for Context Constellation: the context window rendered as a
 * small night sky that fills with stars as tokens accumulate, swept clear by
 * a comet-front wipe when compaction reclaims space. Every function here is
 * a deterministic function of its numeric inputs — no wall-clock reads — so
 * frames stay byte-stable given an injected clock.
 */

/** Fixed grid shape. 5% of the context window per cell. */
export const GRID_COLS = 10;
export const GRID_ROWS = 2;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;

/** How long a shooting-star sweep takes to wipe from its start count down to its target count. */
export const SWEEP_DURATION_MS = 900;

/** How long a freshly-lit star holds its bright "just grew" flare before fading to its resting glyph. */
export const GROW_FLARE_MS = 650;

/**
 * 32-bit FNV-1a over a cell index's decimal string. Hand-rolled (not
 * `Bun.hash`) so the scatter order is guaranteed byte-stable across Bun
 * versions/platforms, matching Tool Constellation's `sky.ts` rationale.
 */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * A fixed pseudo-random permutation of `[0, cells)`, computed once at module
 * load. Determines the order cells light up as percent climbs — a scattered
 * "sky" rather than a left-to-right progress bar — while staying exactly
 * reproducible every run.
 */
export function buildFillOrder(cells: number = GRID_CELLS): readonly number[] {
	return Array.from({ length: cells }, (_, i) => i).sort((a, b) => fnv1a(String(a)) - fnv1a(String(b)));
}

export const FILL_ORDER: readonly number[] = buildFillOrder(GRID_CELLS);

/** Inverse of {@link FILL_ORDER}: `RANK_OF_CELL[cellIndex]` is the position that cell lights up in. */
export function invertFillOrder(order: readonly number[]): readonly number[] {
	const rank = new Array<number>(order.length);
	order.forEach((cellIndex, position) => {
		rank[cellIndex] = position;
	});
	return rank;
}

export const RANK_OF_CELL: readonly number[] = invertFillOrder(FILL_ORDER);

/** Clamp a percent value into `[0, 100]`, treating non-finite input as `0`. Pure. */
export function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

/** How many of `cells` grid cells a `[0, 100]` percent fills. Pure, monotonic non-decreasing in `percent`. */
export function cellsForPercent(percent: number, cells: number = GRID_CELLS): number {
	return Math.round((clampPercent(percent) / 100) * cells);
}

/** Ease-out cubic: fast start, gentle settle — the comet-front's deceleration into its resting cell. Pure. */
function easeOutCubic(t: number): number {
	const inverted = 1 - t;
	return 1 - inverted * inverted * inverted;
}

/**
 * Sweep progress in `[0, 1]` as a pure function of elapsed milliseconds
 * since the sweep began. Monotonic non-decreasing; clamps at `1` once
 * `durationMs` has passed.
 */
export function sweepProgress(elapsedMs: number, durationMs: number = SWEEP_DURATION_MS): number {
	if (durationMs <= 0 || elapsedMs >= durationMs) return 1;
	if (elapsedMs <= 0) return 0;
	return easeOutCubic(elapsedMs / durationMs);
}

/** Interpolate the displayed cell count between a sweep's `from` and `to` counts at a given progress. Pure, rounds to the nearest whole cell. */
export function lerpCells(from: number, to: number, progress: number): number {
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
	return Math.round(from + (to - from) * clamped);
}

/**
 * Flare intensity (`[0, 1]`) of a just-lit star at `elapsedMs` since it grew
 * in: born at full brightness, easing back down to `0` by `durationMs` —
 * after which it reads as its plain resting glyph/color. Mirrors Memory
 * Crystals' `sparkleIntensity` exhale shape. Monotonic non-increasing. Pure.
 */
export function growFlareIntensity(elapsedMs: number, durationMs: number = GROW_FLARE_MS): number {
	if (durationMs <= 0 || elapsedMs >= durationMs) return 0;
	if (elapsedMs <= 0) return 1;
	return (1 + Math.cos(Math.PI * (elapsedMs / durationMs))) / 2;
}

/** Unlit grid cell glyph. */
export const EMPTY_GLYPH = "·";
/** Resting lit-star glyph. */
export const STAR_GLYPH = "✦";
/** A freshly-grown star's brief flare glyph. */
export const FLARE_GLYPH = "✹";
/** The sweep's comet-front glyph, shown at the wipe boundary while a sweep is in progress. */
export const COMET_GLYPH = "☄";
