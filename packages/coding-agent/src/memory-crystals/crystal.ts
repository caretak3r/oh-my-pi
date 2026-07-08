/**
 * Pure math for Memory Crystals: each successful auto-compaction
 * crystallizes into a gem that drops into a resting tray. Every function is a
 * deterministic function of its numeric inputs — no wall-clock reads — so
 * frames are byte-stable given an injected clock.
 */

/**
 * `tokensBefore` magnitude at which a crystal renders at its largest, most
 * saturated tier. A fixed reference ceiling, not an adaptive/rolling max —
 * mirrors Cost Candle's `WAX_REFERENCE_COST_USD`/Token Tide's
 * `MAX_REFERENCE_RATE` normalization pattern.
 */
export const MAX_REFERENCE_TOKENS = 40_000;

/** How long a freshly-spawned crystal's landing sparkle stays visible before it settles into its plain resting glyph. */
export const SPARKLE_DURATION_MS = 500;

/** Magnitude (`[0, 1]`) a compaction's `tokensBefore` produces for its crystal's size/color tier. Pure, monotonic non-decreasing in `tokensBefore`. */
export function crystalMagnitude(tokensBefore: number): number {
	if (!Number.isFinite(tokensBefore) || tokensBefore <= 0) return 0;
	return Math.min(1, tokensBefore / MAX_REFERENCE_TOKENS);
}

/** Ordered gem glyph ramp, smallest/faintest to largest/brightest. */
const GEM_GLYPHS = ["·", "⋄", "◇", "◆"] as const;

/** Map a `[0, 1]` magnitude to a glyph on the {@link GEM_GLYPHS} ramp. Monotonic. Pure. */
export function gemGlyph(magnitude: number): string {
	const clamped = magnitude <= 0 ? 0 : magnitude >= 1 ? 1 : magnitude;
	const index = Math.min(GEM_GLYPHS.length - 1, Math.floor(clamped * GEM_GLYPHS.length));
	return GEM_GLYPHS[index] ?? GEM_GLYPHS[0];
}

/**
 * Sparkle intensity (`[0, 1]`) of a just-landed crystal at `elapsedMs` since
 * it spawned: born at full brightness (the drop's momentary flash), easing
 * back down to `0` by `durationMs` — after which the crystal reads as its
 * plain resting glyph/color. Mirrors Reflection Ripple's `reflectDimAmount`
 * exhale shape (lands instantly, recovers gradually). Monotonic
 * non-increasing in `elapsedMs`. Pure.
 */
export function sparkleIntensity(elapsedMs: number, durationMs: number = SPARKLE_DURATION_MS): number {
	if (durationMs <= 0 || elapsedMs >= durationMs) return 0;
	if (elapsedMs <= 0) return 1;
	return (1 + Math.cos(Math.PI * (elapsedMs / durationMs))) / 2;
}

/** Format a token count compactly, e.g. `12.4k`, `340`. Pure. */
export function formatTokensCompact(tokens: number): string {
	const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
	if (safe < 1000) return `${Math.round(safe)}`;
	return `${(safe / 1000).toFixed(1)}k`;
}
